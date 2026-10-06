// Flash-crash benchmark — `npm run bench -- --accounts 500`.
//
// Seeds the SAME synthetic cross-margin book into both designs (ParaclrClearinghouseDemo and,
// when deployed, NaiveClearinghouseDemo — same code, every per-lane aggregate on one shared key),
// shocks every market in one oracle tx (the oracle is shared, so both books crash together), lets
// the auction sweeper drive every account to resolution (crash run v2), then runs the Conflict
// X-ray over both designs' resolution txs. Writes:
//   bench/results/<chainId>-<UTC timestamp>.json   RunReport (lane-sharded design) + `bench` block
//   bench/xray/<chainId>-<runId>.json              XrayReport (both designs)
// Commit those files: they are the evidence for the write-up.
//
// If a keeper is already running for this chain (GET /health answers), the crash goes through its
// HTTP API so its price loop is paused for the run; otherwise the bench runs the crash and a
// sweeper in-process (no price loop exists then).
//
// Flags:
//   --accounts N      accounts to seed into EACH design (default 500)
//   --bps B           shock multiplier in bps (default 8000 = −20%)
//   --seed S          PRNG seed for the synthetic book (default: time-based)
//   --rpc URL         RPC (default KEEPER_RPC_URL or http://127.0.0.1:8545)
//   --keeper-url URL  keeper to delegate the crash to (default http://127.0.0.1:$KEEPER_PORT)
//   --standalone      never delegate to a running keeper (refuses if one is reachable, unless --force)
//   --legacy          old crash path: one liquidateBatch per lane per design (no auctions)
//   --paraclr-only    seed/crash only the lane-sharded design
//   --no-xray         skip the Conflict X-ray
//   --seed-only       seed the book(s) and stop (no crash; prices untouched)
//   --fund-backstop A top up every lane backstop pool to A AUSD of cash before the crash (the
//                     naive design's single shared pool to 8 × A, so total liquidity is equal)
//   --no-demo-takers  no keeper-run demo external takers (default: on, derived from --seed, so the
//                     pool is not the only bidder; the report labels them as demo bots)
//   --taker-seed N    seed for the demo takers' keys and reservations (default: --seed)
//   --no-recover      leave prices crashed afterwards
//   --out DIR         write results/ and xray/ under DIR instead of bench/ (dev runs)
//   --yes             required on Monad testnet (spends testnet MON)
//
// Private local stacks: with --rpc http://127.0.0.1:<port ≠ 8545> the deployment file defaults to
// contracts/cache/dev-chain/<port>/deployments.json and the keeper to :8787 + (port − 8545), the
// same rule as `npm run dev:chain -- --port <port>`.

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatEther, formatGwei, parseAbiItem, type Hex } from "viem";
import { abis, createContext, ensureAnvilBalances, type DesignRef, type KeeperContext } from "../keeper/src/context";
import {
  CrashController,
  fetchAuctionEvents,
  summarizeAuctions,
  type CrashOptions,
  type RunReport,
} from "../keeper/src/crash";
import { loadKeeperEnv, parseArgs, REPO_ROOT, rpcHost, sleep } from "../keeper/src/env";
import { applyPrivateStackDefaults, defaultRpcUrl, deploymentLabel, LANE_COUNT } from "../keeper/src/network";
import { fundBackstopPools, generateBook, SEED_PARAMS, seedBook } from "../keeper/src/seed";
import { Sweeper } from "../keeper/src/sweeper";
import { createTakers, describeTakers, takerConfig } from "../keeper/src/takers";
import type { XrayReport } from "../keeper/src/xray";
import { xrayFile } from "../keeper/src/xray-run";

/**
 * Gas LIMIT per account per design measured on anvil (bench/results/31337-2026-10-06T22-31-47Z.json:
 * seeding 372.5k limit / 338.6k used per account; crash v2 resolution 26.2M limit for 500 scanned
 * accounts ≈ 52.4k per scanned account at a −20% shock). Monad cost preview only.
 */
const EST_SEED_GAS_PER_ACCOUNT = 373_000;
const EST_RESOLVE_GAS_PER_ACCOUNT_SCANNED = 53_000;


async function keeperHealth(url: string): Promise<{ chainId: number; crashed: boolean; addresses?: { clearinghouse?: string } } | null> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return null;
    return (await res.json()) as { chainId: number; crashed: boolean };
  } catch {
    return null;
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`${url} → ${res.status}: ${json.error ?? JSON.stringify(json)}`);
  return json;
}

async function crashViaKeeper(keeperUrl: string, opts: CrashOptions): Promise<RunReport> {
  const { runId } = await postJson<{ runId: string }>(`${keeperUrl}/crash`, opts);
  console.log(`  keeper run ${runId}`);
  let last = "";
  for (;;) {
    await sleep(250);
    const res = await fetch(`${keeperUrl}/runs/${runId}`);
    const report = (await res.json()) as RunReport;
    if (report.status !== "running") return report;
    const n = report.batches?.length ?? 0;
    const line = `  … ${n} resolution tx(s) so far`;
    if (line !== last && n) console.log(line);
    last = line;
  }
}

async function xrayViaKeeper(keeperUrl: string, runId: string): Promise<XrayReport | null> {
  for (let i = 0; i < 600; i++) {
    const res = await fetch(`${keeperUrl}/runs/${runId}/xray`);
    if (res.status === 200) return (await res.json()) as XrayReport;
    if (res.status !== 202) return null;
    await sleep(500);
  }
  return null;
}

/** PriceUpdated logs between the shock and the last resolution block NOT written by the shock tx. */
async function foreignPriceUpdates(ctx: KeeperContext, report: RunReport, lastBlock: number): Promise<number | null> {
  if (report.shock.block === null || lastBlock < report.shock.block) return null;
  const logs = await ctx.client.getLogs({
    address: ctx.dep.oracle,
    event: parseAbiItem("event PriceUpdated(bytes32 indexed marketId, uint256 price, uint256 updatedAt)"),
    fromBlock: BigInt(report.shock.block),
    toBlock: BigInt(lastBlock),
  });
  return logs.filter((l) => l.transactionHash !== report.shock.txHash).length;
}

/** Average block interval seen from this process (poll eth_blockNumber every 20 ms over 5 blocks). */
async function observeBlockInterval(ctx: KeeperContext, blocks = 5): Promise<number | null> {
  const deadline = Date.now() + 20_000;
  let last = await ctx.client.getBlockNumber();
  let firstAt: number | null = null;
  let seen = 0;
  while (Date.now() < deadline) {
    await sleep(20);
    const n = await ctx.client.getBlockNumber();
    if (n === last) continue;
    last = n;
    if (firstAt === null) firstAt = Date.now();
    else if (++seen === blocks) return Math.round((Date.now() - firstAt) / blocks);
  }
  return null;
}

/** Σ lane insurance and recorded bad debt of a design at `blockNumber` (shared-state: one key). */
async function laneTotals(ctx: KeeperContext, d: DesignRef, blockNumber?: bigint) {
  const shared = await ctx.client.readContract({ address: d.address, abi: abis.clearinghouse, functionName: "sharedState", blockNumber });
  const lanes = await Promise.all(
    Array.from({ length: shared ? 1 : LANE_COUNT }, (_, lane) =>
      ctx.client.readContract({ address: d.address, abi: abis.clearinghouse, functionName: "getLane", args: [lane], blockNumber }),
    ),
  );
  return {
    insurance: lanes.reduce((s, l) => s + l[0], BigInt(0)),
    badDebt: lanes.reduce((s, l) => s + l[1], BigInt(0)),
  };
}

function fmtAusd(raw: string | bigint): string {
  return (Number(BigInt(raw)) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadKeeperEnv();
  const rpcUrl = typeof args.rpc === "string" ? args.rpc : defaultRpcUrl();
  applyPrivateStackDefaults(rpcUrl);
  const outBase = typeof args.out === "string" ? resolve(args.out) : join(REPO_ROOT, "bench");
  const RESULTS_DIR = join(outBase, "results");
  const XRAY_DIR = join(outBase, "xray");
  const ctx = await createContext({ rpcUrl });
  const { info, config } = ctx;
  const accounts = Number(args.accounts ?? 500);
  const bps = Number(args.bps ?? 8_000);
  const seed = args.seed !== undefined ? Number(args.seed) : Date.now() % 2_147_483_647;
  if (!Number.isInteger(accounts) || accounts < 1) throw new Error("--accounts must be a positive integer");
  if (!Number.isInteger(bps) || bps < 1_000 || bps >= 10_000) throw new Error("--bps must be in [1000, 9999]");
  if (!Number.isInteger(seed) || seed < 0) throw new Error("--seed must be a non-negative integer");
  const mode: CrashOptions["mode"] = args.legacy ? "legacy" : "auto";
  const designs: DesignRef[] = ctx.designs.filter((d) => d.label === "paraclr" || !args["paraclr-only"]);
  if (args["paraclr-only"]) ctx.config.sweepNaive = "off";

  const where = info.network === "anvil" ? "local anvil (NOT Monad)" : "Monad testnet";
  console.log(`bench: ${accounts} accounts × ${designs.length} design(s), shock ${bps} bps (${((bps - 10_000) / 100).toFixed(1)}%), seed ${seed}`);
  console.log(`chain: ${where} · chain id ${info.chainId} · rpc ${rpcHost(ctx.rpcUrl)} · ${info.clientVersion}`);
  console.log(`deployment: ${deploymentLabel(info.chainId)} · ${designs.map((d) => `${d.label} ${d.address}`).join(" · ")}`);
  console.log(`features: ${JSON.stringify(ctx.features)} → crash mode ${mode === "legacy" || !ctx.features.auctions ? "legacy (liquidateBatch)" : "auctions (v2)"}`);
  if (!ctx.dep.naive) console.log("note: no naive design in the deployment file — the X-ray will show the lane-sharded design only");

  if (info.network === "monad-testnet") {
    const gasPrice = await ctx.client.getGasPrice();
    const gas = BigInt(accounts) * BigInt(designs.length) * BigInt(EST_SEED_GAS_PER_ACCOUNT + EST_RESOLVE_GAS_PER_ACCOUNT_SCANNED);
    console.log(
      `Monad bills the gas LIMIT. Rough cost at ${formatGwei(gasPrice)} gwei: ` +
        `~${Number(formatEther(gas * gasPrice)).toFixed(2)} MON (operator pays seeding; keepers pay resolution).`,
    );
    if (!args.yes) {
      console.log("Re-run with --yes to spend it.");
      process.exit(1);
    }
  }
  await ensureAnvilBalances(ctx);

  // Delegate the crash to a running keeper so its price loop is paused for the run.
  const keeperUrl = typeof args["keeper-url"] === "string" ? args["keeper-url"] : `http://127.0.0.1:${config.port}`;
  const health = await keeperHealth(keeperUrl);
  const keeperUp =
    health !== null &&
    health.chainId === info.chainId &&
    (health.addresses?.clearinghouse ?? "").toLowerCase() === ctx.dep.clearinghouse.toLowerCase();
  if (health !== null && !keeperUp) {
    console.log(`note: keeper at ${keeperUrl} serves a different chain/deployment; ignoring it`);
  }
  if (args.standalone && keeperUp && !args.force) {
    throw new Error(
      `a keeper is running at ${keeperUrl} on this chain; its price loop would race the standalone crash. ` +
        "Stop it, drop --standalone, or pass --force.",
    );
  }
  const via: "keeper-http" | "standalone" = keeperUp && !args.standalone ? "keeper-http" : "standalone";
  if (!args["seed-only"]) {
    console.log(`crash via: ${via === "keeper-http" ? `keeper at ${keeperUrl}` : "in-process (no keeper running)"}`);
  }
  const sweeper = via === "standalone" ? new Sweeper(ctx, designs) : null;
  const controller = via === "standalone" ? new CrashController(ctx, null, sweeper) : null;
  if (via === "keeper-http" && health?.crashed && !args["seed-only"]) {
    console.log("keeper reports crashed prices; recovering first");
    await postJson(`${keeperUrl}/recover`, {});
  }

  const blockIntervalMs = await observeBlockInterval(ctx);
  console.log(`observed block interval: ${blockIntervalMs ?? "?"} ms`);

  // 1. Seed the identical book into every design. The keeper's price loop is paused first, so both
  //    books open every position at the same oracle mark (truly identical books).
  let pricesPaused = false;
  if (via === "keeper-http") {
    await postJson(`${keeperUrl}/price-loop`, { paused: true, reason: "bench seeding" });
    pricesPaused = true;
  }
  const resumePrices = async () => {
    if (!pricesPaused) return;
    pricesPaused = false;
    await postJson(`${keeperUrl}/price-loop`, { paused: false }).catch((err: unknown) =>
      console.warn(`could not resume the keeper price loop: ${(err as Error).message}`),
    );
  };
  process.once("exit", () => {
    if (pricesPaused) console.warn(`NOTE: the keeper price loop may still be paused — POST ${keeperUrl}/price-loop {"paused":false}`);
  });
  const startedAt = new Date();
  const book = generateBook(ctx.markets, accounts, seed);
  const perLane = Array.from({ length: LANE_COUNT }, () => 0);
  for (const a of book) perLane[Number(BigInt(a.account) % BigInt(LANE_COUNT))]++;
  const positions = book.reduce((n, a) => n + a.positions.length, 0);
  const seeding: Record<string, { txs: Awaited<ReturnType<typeof seedBook>>["txs"]; gasUsed: string; gasLimit: string; wallClockMs: number }> = {};
  let totalCollateral = BigInt(0);
  const backstopFunding: Record<string, unknown> = {};
  try {
    for (const d of designs) {
      console.log(`seeding ${book.length} accounts into ${d.label} ${d.address} (per lane: ${perLane.join(" / ")})`);
      const t0 = Date.now();
      const seeded = await seedBook(ctx, book, (m) => console.log(m), d.address);
      totalCollateral = seeded.totalCollateral;
      seeding[d.design] = {
        txs: seeded.txs,
        gasUsed: seeded.gasUsed.toString(),
        gasLimit: seeded.gasLimit.toString(),
        wallClockMs: Date.now() - t0,
      };
      console.log(
        `  ${d.label}: ${book.length} accounts / ${positions} positions, ${fmtAusd(seeded.totalCollateral)} AUSD collateral, ` +
          `${seeded.gasUsed} gas in ${seeded.txs.length} txs, ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
    }
    if (typeof args["fund-backstop"] === "string") {
      const perLane = BigInt(Math.round(Number(args["fund-backstop"]) * 1e6));
      if (!(perLane > BigInt(0))) throw new Error("--fund-backstop must be a positive AUSD amount");
      for (const d of designs) backstopFunding[d.design] = await fundBackstopPools(ctx, d.address, perLane, (m) => console.log(m));
    }
  } catch (err) {
    await resumePrices();
    throw err;
  }
  // Demo external takers (keeper-run bots), deterministic per seed, funded on every design.
  let takersInfo: unknown = null;
  if (ctx.features.auctions && !args["seed-only"]) {
    const takerSeed = args["taker-seed"] !== undefined ? Number(args["taker-seed"]) : seed;
    try {
      if (via === "keeper-http") {
        takersInfo = await postJson(`${keeperUrl}/demo-takers`, args["no-demo-takers"] ? { enabled: false } : { seed: takerSeed });
      } else if (!args["no-demo-takers"]) {
        const set = await createTakers(ctx, takerConfig(ctx, { seed: takerSeed }), designs, (m) => console.log(m));
        sweeper!.setTakers(set);
        takersInfo = describeTakers(set);
      } else {
        takersInfo = describeTakers(null);
      }
    } catch (err) {
      await resumePrices();
      throw err;
    }
    const ti = takersInfo as { demo: boolean; takers: unknown[]; reservationBps: number[] | null };
    console.log(
      ti.demo
        ? `demo external takers: ${ti.takers.length} keeper-run bots, reservation ${ti.reservationBps?.join("–")} bps (seed ${takerSeed})`
        : "demo external takers: off (the lane pools are the only bidders)",
    );
  }
  if (args["seed-only"]) {
    await resumePrices();
    console.log("--seed-only: done (no crash, prices untouched).");
    return;
  }

  // 2. Crash (v2: the sweeper resolves every auction; legacy: liquidateBatch per lane).
  console.log(`crash: shock ${bps} bps; resolving…`);
  const crashOpts: CrashOptions = { bps, mode, xray: !args["no-xray"] };
  const preCrashBlock = await ctx.client.getBlockNumber();
  const lanesBefore = await Promise.all(designs.map((d) => laneTotals(ctx, d, preCrashBlock)));
  // The crash run pauses the loop itself and keeps it paused until /recover resumes it.
  pricesPaused = false;
  const report = via === "keeper-http" ? await crashViaKeeper(keeperUrl, crashOpts) : await controller!.run(crashOpts);
  let xray: XrayReport | null = null;
  if (report.xrayId) {
    xray =
      via === "keeper-http"
        ? await xrayViaKeeper(keeperUrl, report.runId)
        : ((controller!.getXray(report.runId) as XrayReport | null) ?? null);
  }
  const lastBlock = Math.max(
    report.shock.block ?? 0,
    ...report.batches.map((b) => b.block ?? 0),
    ...(xray?.designs.flatMap((d) => d.blocks) ?? []),
  );
  const foreign = await foreignPriceUpdates(ctx, report, lastBlock).catch(() => null);
  const lanesAfter = await Promise.all(designs.map((d) => laneTotals(ctx, d, BigInt(lastBlock))));
  const laneFunds = Object.fromEntries(
    designs.map((d, i) => [
      d.design,
      {
        block: { before: Number(preCrashBlock), after: lastBlock },
        insuranceBefore: lanesBefore[i].insurance.toString(),
        insuranceAfter: lanesAfter[i].insurance.toString(),
        recordedBadDebtBefore: lanesBefore[i].badDebt.toString(),
        recordedBadDebtAfter: lanesAfter[i].badDebt.toString(),
      },
    ]),
  );

  // Per-account comparison with the legacy penalty (lane-sharded design), from its events.
  let vsLegacy: Record<string, unknown> | null = null;
  if (report.mode === "auctions" && report.shock.block !== null) {
    const feeBps = await ctx.client
      .readContract({ address: designs[0].address, abi: abis.clearinghouse, functionName: "LIQUIDATION_FEE_BPS" })
      .then(Number, () => 100);
    vsLegacy = summarizeAuctions(await fetchAuctionEvents(ctx, designs[0].address, report.shock.block, lastBlock), {
      shockBlock: report.shock.block,
      shockAt: 0,
      legacyFeeBps: feeBps,
      seenAt: () => null,
    }).vsLegacy;
  }

  // Naive baseline outcome (same logic → should match the lane-sharded numbers).
  let naiveOutcome: Record<string, unknown> | null = null;
  const naive = designs.find((d) => d.label === "naive");
  if (naive && report.mode === "auctions" && report.shock.block !== null) {
    const feeBps = await ctx.client
      .readContract({ address: naive.address, abi: [parseAbiItem("function LIQUIDATION_FEE_BPS() view returns (uint256)")], functionName: "LIQUIDATION_FEE_BPS" })
      .then(Number, () => 100);
    const naiveEvents = await fetchAuctionEvents(ctx, naive.address, report.shock.block, lastBlock);
    const sum = summarizeAuctions(naiveEvents, {
      shockBlock: report.shock.block,
      shockAt: report.shock.confirmedAt ?? report.shock.submittedAt,
      legacyFeeBps: feeBps,
      seenAt: () => null,
    });
    const { perAccount, ...uw } = sum.underwater;
    naiveOutcome = {
      design: naive.design,
      contract: naive.address,
      auctions: { ...sum.auctions, externalTakers: report.auctions?.externalTakers },
      underwater: { ...uw, accounts: perAccount.length, maxMs: null },
      vsLegacy: sum.vsLegacy,
      unresolved: sum.unresolved,
      note: "Same events-based summary as the RunReport, computed for the naive design (keeper ms not tracked for it).",
    };
  }

  // Gas of every design's resolution txs (the RunReport only carries the lane-sharded design's).
  const resolutionGas: Record<string, { txs: number; gasUsed: string; gasLimit: string }> = {};
  for (const d of xray?.designs ?? []) {
    const rows = await Promise.all(
      d.txs.map(async (t) => {
        const [tx, rcpt] = await Promise.all([
          ctx.client.getTransaction({ hash: t.hash }),
          ctx.client.getTransactionReceipt({ hash: t.hash }),
        ]);
        return { used: rcpt.gasUsed, limit: tx.gas };
      }),
    );
    resolutionGas[d.design] = {
      txs: rows.length,
      gasUsed: rows.reduce((s, r) => s + r.used, BigInt(0)).toString(),
      gasLimit: rows.reduce((s, r) => s + r.limit, BigInt(0)).toString(),
    };
  }

  // 3. Recover (default) so the chain is usable again.
  let recoverTx: Hex | null = null;
  if (!args["no-recover"]) {
    try {
      const r = via === "keeper-http" ? await postJson<{ txHash: Hex }>(`${keeperUrl}/recover`, {}) : await controller!.recover();
      recoverTx = r.txHash;
    } catch (err) {
      console.warn(`recover failed: ${(err as Error).message}`);
    }
  }

  // 4. X-ray file: the keeper wrote it to its XRAY_DIR; make sure bench/xray has it.
  let xrayPath: string | null = null;
  if (xray) {
    xrayPath = join(XRAY_DIR, `${info.chainId}-${report.runId}.json`);
    mkdirSync(XRAY_DIR, { recursive: true });
    const written = xrayFile(ctx, report.runId);
    if (existsSync(written) && written !== xrayPath) copyFileSync(written, xrayPath);
    else if (!existsSync(xrayPath)) writeFileSync(xrayPath, JSON.stringify(xray, null, 2) + "\n");
  }

  // 5. Derived numbers + results file.
  const t = report.totals;
  const gasUsed = Number(t.totalGasUsed);
  const batchGas = report.batches.map((b) => Number(b.gasUsed));
  const lastConfirm = Math.max(0, ...report.batches.map((b) => b.confirmedAt ?? 0));
  const byKind: Record<string, { txs: number; gasUsed: number; gasLimit: number; accounts: number }> = {};
  for (const b of report.batches) {
    const k = (byKind[b.kind] ??= { txs: 0, gasUsed: 0, gasLimit: 0, accounts: 0 });
    k.txs++;
    k.gasUsed += Number(b.gasUsed);
    k.gasLimit += Number(b.gasLimit);
    k.accounts += b.accounts;
  }
  const derived = {
    liquidatedPct: t.accountsScanned ? +((100 * t.liquidated) / t.accountsScanned).toFixed(2) : 0,
    gasPerResolvedAccount: t.liquidated ? Math.round(gasUsed / t.liquidated) : null,
    gasPerScannedAccount: t.accountsScanned ? Math.round(gasUsed / t.accountsScanned) : null,
    batchCount: report.batches.length,
    avgGasPerBatch: batchGas.length ? Math.round(batchGas.reduce((a, b) => a + b, 0) / batchGas.length) : null,
    maxGasPerBatch: batchGas.length ? Math.max(...batchGas) : null,
    byKind,
    shockConfirmMs: report.shock.confirmedAt !== null ? report.shock.confirmedAt - report.shock.submittedAt : null,
    shockSubmitToLastResolutionReceiptMs: lastConfirm ? lastConfirm - report.shock.submittedAt : null,
    seedGasPerAccount: Math.round(Number(seeding[designs[0].design].gasUsed) / book.length),
    traderLossAuctions: report.auctions
      ? (BigInt(report.auctions.traderEquityAtStart) - BigInt(report.auctions.traderResidualReturned)).toString()
      : null,
    traderLossLegacyCounterfactual: report.auctions?.legacyCounterfactual.traderLoss ?? null,
    /** Taken accounts that lost more / the same / less than the legacy penalty would have taken (cured = less or same, expired = same). */
    accountsVsLegacy: vsLegacy,
  };
  const out = {
    ...report,
    bench: {
      measuredOn: where,
      tool: "npm run bench",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      crashVia: via,
      crashMode: report.mode,
      rpcHost: rpcHost(ctx.rpcUrl),
      clientVersion: info.clientVersion,
      observedBlockIntervalMs: blockIntervalMs,
      seed,
      designs: designs.map((d) => ({ design: d.design, contract: d.address })),
      accountsSeeded: book.length,
      accountsSeededPerDesign: book.length,
      positionsSeeded: positions,
      accountsPerLaneSeeded: perLane,
      seedParams: SEED_PARAMS,
      seedTotalCollateral: totalCollateral.toString(),
      seedGasUsed: seeding[designs[0].design].gasUsed,
      seedGasLimit: seeding[designs[0].design].gasLimit,
      seedWallClockMs: seeding[designs[0].design].wallClockMs,
      seedTxs: seeding[designs[0].design].txs,
      seeding,
      backstopFunding: Object.keys(backstopFunding).length ? backstopFunding : null,
      demoTakers: takersInfo,
      config: {
        receiptPollMs: config.receiptPollMs,
        gasMarginBps: config.gasMarginBps,
        maxTxGas: config.maxTxGas.toString(),
        keeperKeys: ctx.roles.keepers.length,
        sweeperPollMs: config.sweeperPollMs,
      },
      priceUpdatesDuringRunExcludingShock: foreign,
      recoverTxHash: recoverTx,
      naive: naiveOutcome,
      laneFunds,
      resolutionGas,
      xray: xray
        ? {
            file: xrayPath ? (xrayPath.startsWith(REPO_ROOT + "/") ? xrayPath.slice(REPO_ROOT.length + 1) : xrayPath) : null,
            method: xray.method,
            summary: Object.fromEntries(xray.designs.map((d) => [d.design, d.summary])),
          }
        : null,
      derived,
      notes: [
        "Timings are keeper-side wall clock (Date.now()): submittedAt right before eth_sendRawTransaction, " +
          "confirmedAt when the receipt poll first sees the receipt (includes up to receiptPollMs + RPC latency).",
        report.mode === "auctions"
          ? "batches = every sweeper tx on the lane-sharded design during the run (kind: startAuctions | backstopTakeBatch | expireBatch | cancelAuction); wallClockMs = first submitted → last receipt observed."
          : "wallClockMs = first lane batch submitted → last lane batch receipt observed.",
        "underwater: fromBlock = shock block, toBlock = block of the resolving event; maxMs = keeper saw the shock receipt → keeper saw the resolving receipt.",
        "External takers in this run (auctions.externalTakers.demo = true) are demo bots run by the keeper: same-lane accounts with reservation discounts drawn from auctions.externalTakers.reservationBps, which take when the payment they would really receive (capped at the trader's equity) reaches their reservation, then close what they inherited at mark the next block. bench.demoTakers lists them.",
        "legacyCounterfactual.traderLoss = Σ min(max(equity, 0), notional × LIQUIDATION_FEE_BPS / 10000) over the same accounts, equity and notional from AuctionStarted (the old liquidateBatch penalty).",
        "accountsScanned counts every account registered in the 8 lanes of the lane-sharded design, including accounts seeded by earlier runs.",
        "auctions.badDebt / totals.badDebt = Σ event badDebt = lane-FUNDED shortfall (AuctionTaken: max(0, payment − equity) incl. written-off negative equity; AuctionExpired / Liquidated: negative equity written off). The lane insurance fund pays first; only what it cannot cover becomes recorded lane bad debt — see laneFunds for the recorded before/after.",
        "AUSD amounts are raw 6-decimal integers; gas values are integers as strings.",
        info.network === "anvil"
          ? "Local anvil with interval mining: block time and ordering are anvil's, NOT Monad's."
          : "Monad testnet: gas is billed on gas limit; see seedGasLimit and batches[].gasLimit.",
      ],
    },
  };
  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:]/g, "-").replace(/\.\d+Z$/, "Z");
  const file = join(RESULTS_DIR, `${info.chainId}-${stamp}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");

  // 6. Print.
  console.log(`\n=== ${where} · ${report.mode} · ${report.status}${report.error ? ` (${report.error})` : ""} ===`);
  console.log(`accounts scanned     ${t.accountsScanned}  (seeded this run: ${book.length} per design)`);
  console.log(`resolved             ${t.liquidated}  (${derived.liquidatedPct}%)`);
  if (report.auctions) {
    const a = report.auctions;
    console.log(
      `auctions             started ${a.started} · backstop ${a.takenByBackstop} · external ${a.takenExternal}` +
        `${a.externalTakers?.demo ? " (demo bots)" : ""} · cured ${a.cured} · expired ${a.expired} · avg discount ${a.avgDiscountBps} bps`,
    );
    const auctionLoss = BigInt(a.traderEquityAtStart) - BigInt(a.traderResidualReturned);
    console.log(
      `trader equity        at start ${fmtAusd(a.traderEquityAtStart)} AUSD · returned ${fmtAusd(a.traderResidualReturned)} ` +
        `(auctions took ${fmtAusd(auctionLoss)}) · legacy 1% penalty would have taken ${fmtAusd(a.legacyCounterfactual.traderLoss)} · ` +
        `backstop paid ${fmtAusd(a.backstopPaid)}`,
    );
  }
  if (vsLegacy) {
    const v = vsLegacy as { worse: number; equal: number; better: number; worstExtra: string };
    console.log(
      `per account vs legacy ${v.better} lost less · ${v.equal} the same · ${v.worse} lost MORE` +
        (v.worse ? ` (worst: +${fmtAusd(v.worstExtra)} AUSD)` : ""),
    );
  }
  if (report.underwater) {
    const u = report.underwater;
    console.log(`time underwater      max ${u.maxBlocks} blocks · p50 ${u.p50Blocks} · p95 ${u.p95Blocks} · max ${u.maxMs} ms`);
  }
  console.log(`bad debt             ${fmtAusd(t.badDebt)} AUSD`);
  console.log(`resolution txs       ${report.batches.length} from ${new Set(report.batches.map((b) => b.keeper)).size} keeper EOAs · ${JSON.stringify(byKind)}`);
  console.log(`blocks               ${t.blocks.join(", ")}  (shock in ${report.shock.block})`);
  console.log(`wall clock           ${t.wallClockMs} ms first resolution submit → last receipt`);
  console.log(`price loop paused    ${report.priceLoopPaused}; foreign price updates during run: ${foreign}`);
  if (naiveOutcome) console.log(`naive baseline       ${JSON.stringify((naiveOutcome as { auctions: unknown }).auctions)}`);
  if (xray) {
    for (const d of xray.designs) {
      console.log(
        `X-ray ${d.design.padEnd(14)} ${d.summary.txs} txs · ${d.summary.edges} edges (${d.summary.crossLaneEdges} cross-lane / ${d.summary.sameLaneEdges} same-lane) · ` +
          `longest chain ${d.summary.longestChain} · ${d.summary.independentTxs} independent  (${xray.method})`,
      );
    }
  } else if (report.xrayError) {
    console.log(`X-ray failed: ${report.xrayError}`);
  }
  console.log(`\nwrote ${file}${xrayPath ? `\nwrote ${xrayPath}` : ""}`);
  if (report.status !== "done") process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(`bench failed: ${(err as Error)?.message ?? err}`);
  process.exit(1);
});
