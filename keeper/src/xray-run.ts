// Runs the Conflict X-ray for a crash run: collects every resolution-phase tx of each design,
// traces it (live debug_traceTransaction, or an anvil fork replay when the RPC can't), builds the
// same-block edge graphs, labels the slots and writes bench/xray/<chainId>-<runId>.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFunctionData, getAddress, type Address, type Transaction } from "viem";
import { abis, type DesignRef, type KeeperContext } from "./context";
import { hasFoundry } from "./foundry";
import { LANE_COUNT, roleAddresses } from "./network";
import {
  buildDesignGraph,
  hotSlots,
  probeDebugTrace,
  traceAll,
  XRAY_EXCLUSIONS,
  type XrayDesignInput,
  type XrayInput,
  type XrayMethod,
  type XrayReport,
} from "./xray";
import { forkAndReplay } from "./xray-fork";
import { shortAddr, SlotLabeler, type LabelCandidates } from "./xray-labels";

const LANE_FIRST_ARG = new Set([
  "startAuctions",
  "backstopTakeBatch",
  "expireBatch",
  "liquidateBatch",
  "backstopDeposit",
  "backstopWithdraw",
  "backstopReduce",
  "fundLane",
]);
const ACCOUNT_ARG = new Set(["cancelAuction", "take"]);
/** Trader calls act on the sender's own account, i.e. the sender's lane. */
const SENDER_LANE = new Set(["closePosition", "openPosition", "deposit", "withdraw"]);

export function xrayFile(ctx: KeeperContext, runId: string): string {
  return join(ctx.config.xrayDir, `${ctx.info.chainId}-${runId}.json`);
}

export function readXray(ctx: KeeperContext, runId: string): XrayReport | null {
  const f = xrayFile(ctx, runId);
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, "utf8")) as XrayReport;
}

/** Function name, lane and the account arrays of a clearinghouse call. */
function describeCall(tx: Transaction): { kind: string; lane: number | null; accounts: Address[] } {
  try {
    const { functionName, args } = decodeFunctionData({ abi: abis.clearinghouse, data: tx.input });
    const a = (args ?? []) as readonly unknown[];
    let lane: number | null = null;
    if (LANE_FIRST_ARG.has(functionName) && typeof a[0] === "number") lane = a[0];
    else if (ACCOUNT_ARG.has(functionName) && typeof a[0] === "string") lane = Number(BigInt(a[0]) % BigInt(LANE_COUNT));
    else if (SENDER_LANE.has(functionName)) lane = Number(BigInt(tx.from) % BigInt(LANE_COUNT));
    const accounts = a.flatMap((x) => (Array.isArray(x) ? x.filter((v): v is Address => typeof v === "string" && v.length === 42) : []));
    if (ACCOUNT_ARG.has(functionName) && typeof a[0] === "string") accounts.push(a[0] as Address);
    return { kind: functionName, lane, accounts };
  } catch {
    return { kind: tx.input.slice(0, 10), lane: null, accounts: [] };
  }
}

export interface XrayRunOptions {
  runId: string;
  /** Inclusive block range of the resolution phase (the shock block itself is excluded). */
  fromBlock: number;
  toBlock: number;
  designs: DesignRef[];
  method?: "auto" | "debug" | "fork";
  log?: (m: string) => void;
  write?: boolean;
}

export async function runXray(ctx: KeeperContext, opts: XrayRunOptions): Promise<XrayReport> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const notes: string[] = [];
  const t0 = Date.now();

  // 1. Every tx to each design contract in the resolution blocks, in block order.
  const byContract = new Map(opts.designs.map((d) => [d.address.toLowerCase(), d]));
  const inputs = new Map<string, XrayDesignInput>(
    opts.designs.map((d) => [d.address.toLowerCase(), { design: d.design, contract: d.address, txs: [] }]),
  );
  const accounts = new Set<string>();
  const blockNums = [];
  for (let b = opts.fromBlock; b <= opts.toBlock; b++) blockNums.push(b);
  const blocks = await Promise.all(
    blockNums.map((b) => ctx.client.getBlock({ blockNumber: BigInt(b), includeTransactions: true })),
  );
  for (const block of blocks) {
    for (const tx of block.transactions as Transaction[]) {
      const to = tx.to?.toLowerCase();
      if (!to || !byContract.has(to)) continue;
      const call = describeCall(tx);
      call.accounts.forEach((a) => accounts.add(a.toLowerCase()));
      const input: XrayInput = { hash: tx.hash, lane: call.lane, kind: call.kind };
      inputs.get(to)!.txs.push(input);
    }
  }
  const all = [...inputs.values()].flatMap((d) => d.txs.map((t) => t.hash));
  if (all.length === 0) throw new Error(`no resolution txs found in blocks ${opts.fromBlock}…${opts.toBlock}`);

  // 2. Method: live debug trace if the RPC serves prestateTracer + diffMode, else fork replay.
  let method: XrayMethod = "debug_traceTransaction";
  let traceClient = ctx.client;
  let forkedFrom: XrayReport["forkedFrom"];
  let stopFork: (() => Promise<void>) | null = null;
  const want = opts.method ?? ctx.config.xray;
  let reason: string | null = null;
  if (want !== "fork") {
    reason = await probeDebugTrace(ctx.client, all[0]);
    if (reason && want === "debug") throw new Error(`debug_traceTransaction unusable: ${reason}`);
  }
  if (want === "fork" || reason) {
    if (!hasFoundry("anvil")) throw new Error(`debug tracing unavailable (${reason ?? "forced"}) and anvil is not installed for the fork replay`);
    if (reason) notes.push(`debug_traceTransaction on the RPC was unusable (${reason}); fell back to an anvil fork replay.`);
    const fork = await forkAndReplay({
      source: ctx.client,
      sourceRpcUrl: ctx.rpcUrl,
      hashes: all,
      contracts: [...opts.designs.map((d) => d.address), ctx.dep.oracle, ctx.dep.ausd],
      log,
    });
    method = "anvil-fork-replay";
    traceClient = fork.client;
    forkedFrom = { chainId: ctx.info.chainId, block: fork.forkBlock };
    stopFork = fork.stop;
    notes.push(...fork.notes);
  }

  // 3. Trace (both prestate modes) and build the graphs.
  let report: XrayReport;
  try {
    const traced = await traceAll(traceClient, all, { concurrency: ctx.info.network === "anvil" ? 16 : 4 });
    const designs = [...inputs.values()].map((d) => buildDesignGraph(d, traced));

    // 4. Labels for every slot on an edge.
    const roles = roleAddresses(ctx.roles);
    const roleMap = new Map<string, string>([
      [ctx.dep.clearinghouse.toLowerCase(), "paraclr"],
      [ctx.dep.oracle.toLowerCase(), "oracle"],
      [ctx.dep.ausd.toLowerCase(), "ausd"],
      [roles.operator.toLowerCase(), "operator"],
      [roles.pricePusher.toLowerCase(), "pricePusher"],
      [roles.faucet.toLowerCase(), "faucet"],
      ...roles.keepers.map((k, i): [string, string] => [k.toLowerCase(), `keeper[${i}]`]),
    ]);
    if (ctx.dep.naive) roleMap.set(ctx.dep.naive.toLowerCase(), "naive");
    const candidates: LabelCandidates = {
      addresses: new Map([...roleMap, ...[...accounts].map((a): [string, string] => [a, shortAddr(getAddress(a))])]),
      roleAddresses: roleMap,
      bytes32: new Map(ctx.markets.map((m) => [m.id.toLowerCase(), m.symbol])),
      smallInts: Array.from({ length: LANE_COUNT }, (_, i) => i),
    };
    const slotLabels: Record<string, string> = {};
    const edgeSlots = new Set(designs.flatMap((d) => d.edges.flatMap((e) => e.slots)));
    if (edgeSlots.size) {
      const labeler = new SlotLabeler(
        [
          { address: ctx.dep.clearinghouse, name: "paraclr", contract: "ParaclrClearinghouseDemo" },
          ...(ctx.dep.naive ? [{ address: ctx.dep.naive, name: "naive", contract: "NaiveClearinghouseDemo" }] : []),
          { address: ctx.dep.oracle, name: "oracle", contract: "MockOracle" },
          { address: ctx.dep.ausd, name: "ausd", contract: "MockAUSD" },
        ],
        candidates,
      );
      for (const s of edgeSlots) {
        const l = labeler.label(s);
        if (l) slotLabels[s] = l;
      }
      if (!labeler.available) notes.push("Slot labels unavailable (forge not found or `forge inspect` failed); slots are raw address:slot keys.");
    }

    report = {
      runId: opts.runId,
      chainId: ctx.info.chainId,
      network: ctx.info.network,
      method,
      ...(forkedFrom ? { forkedFrom } : {}),
      designs,
      exclusions: [...XRAY_EXCLUSIONS],
      generatedAt: new Date().toISOString(),
      edgeScope: "same-block",
      slotLabels,
      notes: [
        `Resolution phase = every tx to the design's contract in blocks ${opts.fromBlock}…${opts.toBlock} (the block after the shock through the last resolution tx).`,
        "reads = slots/account fields the tx accessed without modifying them; writes = slots/account fields it modified (prestateTracer diffMode).",
        ctx.info.network === "anvil"
          ? "Measured on local anvil (NOT Monad): anvil executes sequentially; this is the dependency structure of the txs, not Monad's re-execution count."
          : "Monad testnet: dependency structure of the txs as executed; it does not report Monad's internal re-execution count.",
        ...notes,
      ],
    };
  } finally {
    if (stopFork) await stopFork();
  }

  for (const d of report.designs) {
    const hot = hotSlots(d, 3)
      .map((h) => `${report.slotLabels[h.slot] ?? h.slot} (${h.edges})`)
      .join(", ");
    log(
      `[xray] ${d.design}: ${d.summary.txs} txs in ${d.blocks.length} block(s), ${d.summary.edges} edges ` +
        `(${d.summary.crossLaneEdges} cross-lane, ${d.summary.sameLaneEdges} same-lane), ` +
        `longest chain ${d.summary.longestChain}, ${d.summary.independentTxs} independent${hot ? ` · hot: ${hot}` : ""}`,
    );
  }
  log(`[xray] ${report.method} in ${Date.now() - t0} ms`);

  if (opts.write !== false) {
    mkdirSync(ctx.config.xrayDir, { recursive: true });
    const file = xrayFile(ctx, opts.runId);
    writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
    log(`[xray] wrote ${file}`);
  }
  return report;
}

