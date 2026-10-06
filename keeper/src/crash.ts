// The measured flash-crash run.
//
// Crash run v2 (docs/FAIR_LIQUIDATION_PLAN.md, default when the contract has the auction API):
//   1. pause the price loop and wait for in-flight pushes (nothing but the shock and the
//      resolution txs writes the oracle/clearinghouse during the run);
//   2. shock every market in ONE oracle tx (MockOracle.shockPrices) from the operator key — the
//      oracle is shared, so the lane-sharded design and the naive baseline crash together;
//   3. the sweeper (sweeper.ts) drives every auction to resolution, block by block, from the 8
//      lane keeper keys: startAuctions → backstopTakeBatch at the pool's min discount → (cancel
//      cured / expire at MAX);
//   4. once no design has a liquidatable or in-auction account left, the report is built from
//      the auction events (AuctionStarted/Taken/Cancelled/Expired) and the sweeper's txs;
//   5. Conflict X-ray of both designs' resolution txs (xray-run.ts).
//
// Legacy mode (contracts without auctions, or `mode: "legacy"`): one liquidateBatch(lane, …) per
// lane per design, fired concurrently from the 8 keeper EOAs (the original ONCHAIN_PLAN run).
//
// Timings are keeper-side wall clock (Date.now()): submittedAt is taken immediately before
// eth_sendRawTransaction, confirmedAt when the receipt poll first returns the receipt, so each
// confirmedAt includes up to one receipt-poll interval plus RPC round-trip latency.

import { encodeFunctionData, parseEventLogs, type Address, type Hex, type Log } from "viem";
import { abis, readOraclePrices, type DesignRef, type KeeperContext } from "./context";
import { sleep } from "./env";
import { keeperForLane, LANE_COUNT, type Network } from "./network";
import type { PriceLoop } from "./prices";
import { fromWad } from "./prices";
import { estimateLimit, waitForReceipt, waitForReceipts, type SignedTx } from "./sender";
import { decodeAuctionEvents, type Sweeper, type SweepKind, type SweepTx } from "./sweeper";
import type { XrayReport } from "./xray";
import { readXray, runXray } from "./xray-run";

// ---------------------------------------------------------------------------
// RunReport — docs/ONCHAIN_PLAN.md shape + docs/FAIR_LIQUIDATION_PLAN.md additions
// (auctions, underwater, xrayId) + `priceLoopPaused` (coordinator ask) + additive `mode`,
// `batches[].kind`, `xrayError`. AUSD amounts are raw 6-decimal integers as base-10 strings
// ("1500000" = 1.5 AUSD); gas values are base-10 integer strings.
// ---------------------------------------------------------------------------

export interface TxTiming {
  txHash: `0x${string}`;
  block: number | null;
  submittedAt: number;
  confirmedAt: number | null;
}

export interface BatchReport extends TxTiming {
  lane: number;
  keeper: `0x${string}`;
  accounts: number;
  /** Accounts this tx resolved (taken + expired; legacy: liquidated). */
  liquidated: number;
  gasUsed: string;
  gasLimit: string;
  /** Additive: which call this is (startAuctions | backstopTakeBatch | expireBatch | cancelAuction | liquidateBatch). */
  kind: SweepKind | "liquidateBatch";
}

export interface LiquidationReport {
  lane: number;
  account: `0x${string}`;
  equity: string;
  badDebt: string;
  txHash: `0x${string}`;
  logIndex: number;
}

export type Outcome = "backstop" | "external" | "cured" | "expired";

export interface AuctionsReport {
  started: number;
  takenByBackstop: number;
  takenExternal: number;
  cured: number;
  expired: number;
  avgDiscountBps: number;
  traderResidualReturned: string;
  backstopPaid: string;
  badDebt: string;
  legacyCounterfactual: { traderLoss: string };
  /**
   * Additive: Σ max(0, equity at AuctionStarted) over the taken + expired accounts (cured ones keep
   * everything). What traders lost to the auctions = traderEquityAtStart − traderResidualReturned;
   * compare with legacyCounterfactual.traderLoss (all started accounts, liquidated at start).
   */
  traderEquityAtStart: string;
  /**
   * Who could bid besides the lane pool. `demo: true` = the external takers in this run are demo
   * bots run by the keeper (takers.ts), with reservation discounts drawn from `reservationBps`.
   */
  externalTakers?: { demo: boolean; accounts: number; reservationBps: [number, number] | null };
}

export interface UnderwaterReport {
  maxBlocks: number;
  p50Blocks: number;
  p95Blocks: number;
  maxMs: number;
  perAccount: Array<{ account: `0x${string}`; lane: number; fromBlock: number; toBlock: number; outcome: Outcome }>;
}

export interface RunReport {
  runId: string;
  status: "running" | "done" | "failed";
  error?: string;
  chainId: number;
  network: Network;
  /** Additive: "auctions" (crash v2) or "legacy" (one liquidateBatch per lane). */
  mode: "auctions" | "legacy";
  /** True when no keeper price push could land between the shock and the last resolution tx. */
  priceLoopPaused: boolean;
  shock: TxTiming & { bps: number };
  batches: BatchReport[];
  liquidations: LiquidationReport[];
  totals: {
    accountsScanned: number;
    liquidated: number;
    badDebt: string;
    wallClockMs: number;
    blocks: number[];
    sameBlock: boolean;
    totalGasUsed: string;
  };
  auctions?: AuctionsReport;
  underwater?: UnderwaterReport;
  xrayId?: string;
  /** Additive: set when the X-ray could not be produced (the crash itself still counts). */
  xrayError?: string;
}

export class BusyError extends Error {
  constructor(readonly runId: string) {
    super(`crash run ${runId} is still running`);
  }
}
export class NotCrashedError extends Error {
  constructor() {
    super("prices are not in a crashed state (nothing to recover)");
  }
}

export interface CrashOptions {
  bps: number;
  /** auto = auctions when the contract has them, else legacy. */
  mode?: "auto" | "auctions" | "legacy";
  /** Run the Conflict X-ray afterwards (default: config.xray !== "off"). */
  xray?: boolean;
}

const DISCOVERY_PAGE = 250;
const MAX_RUNS_KEPT = 50;
const BPS = 10_000;

interface LaneChunk {
  lane: number;
  design: DesignRef;
  accounts: Address[];
  data: Hex;
  gasLimit: bigint;
}

function newRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function emptyReport(ctx: KeeperContext, runId: string, bps: number, mode: RunReport["mode"]): RunReport {
  return {
    runId,
    status: "running",
    chainId: ctx.info.chainId,
    network: ctx.info.network,
    mode,
    priceLoopPaused: false,
    shock: { txHash: "0x", block: null, submittedAt: 0, confirmedAt: null, bps },
    batches: [],
    liquidations: [],
    totals: {
      accountsScanned: 0,
      liquidated: 0,
      badDebt: "0",
      wallClockMs: 0,
      blocks: [],
      sameBlock: false,
      totalGasUsed: "0",
    },
  };
}

/** Nearest-rank percentile of a sorted array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export type AuctionEvents = ReturnType<typeof decodeAuctionEvents>;

/**
 * Auction outcome of a crash from the design's auction events (sorted by block/logIndex):
 * accounts whose AuctionStarted is at/after the shock block, each followed to its first
 * AuctionTaken / AuctionCancelled / AuctionExpired. Pure, so the bench can run it on the naive
 * design's events too.
 */
export function summarizeAuctions(
  events: AuctionEvents,
  opts: {
    shockBlock: number;
    /** ms epoch the shock was observed (start of "underwater" in ms). */
    shockAt: number;
    legacyFeeBps: number;
    /** ms epoch the keeper observed a resolving tx / block, or null if unknown. */
    seenAt: (hash: Hex, block: number) => number | null;
  },
): {
  auctions: AuctionsReport;
  underwater: UnderwaterReport;
  liquidations: LiquidationReport[];
  resolvedInTx: Map<Hex, number>;
  unresolved: number;
  /**
   * Per account, what the auction took vs what the legacy penalty would have taken (taken accounts;
   * expiry IS the legacy path, cured accounts lose nothing).
   */
  vsLegacy: { worse: number; equal: number; better: number; worstExtra: string };
} {
  const starts = new Map<string, { lane: number; equity: bigint; notional: bigint; block: number }>();
  const outcomes = new Map<string, { outcome: Outcome; block: number; hash: Hex }>();
  const residualOf = new Map<string, bigint>();
  let takenByBackstop = 0;
  let takenExternal = 0;
  let cured = 0;
  let expired = 0;
  let discountSum = 0;
  let residual = BigInt(0);
  let backstopPaid = BigInt(0);
  let badDebt = BigInt(0);
  const liquidations: LiquidationReport[] = [];
  const resolvedInTx = new Map<Hex, number>();

  for (const e of events) {
    const acct = e.args.account.toLowerCase();
    if (e.eventName === "AuctionStarted") {
      if (Number(e.blockNumber) >= opts.shockBlock && !starts.has(acct)) {
        starts.set(acct, { lane: Number(e.args.lane), equity: e.args.equity, notional: e.args.notional, block: Number(e.blockNumber) });
      }
      continue;
    }
    const start = starts.get(acct);
    if (!start || outcomes.has(acct)) continue; // pre-crash auction, or already resolved
    const at = { block: Number(e.blockNumber), hash: e.transactionHash as Hex };
    if (e.eventName === "AuctionTaken" || e.eventName === "AuctionExpired") {
      if (e.eventName === "AuctionTaken") {
        const backstop = e.args.backstop;
        if (backstop) takenByBackstop++;
        else takenExternal++;
        discountSum += Number(e.args.discountBps);
        residual += e.args.traderResidual;
        residualOf.set(acct, e.args.traderResidual);
        if (backstop) backstopPaid += e.args.payment;
        outcomes.set(acct, { outcome: backstop ? "backstop" : "external", ...at });
      } else {
        expired++;
        outcomes.set(acct, { outcome: "expired", ...at });
      }
      badDebt += e.args.badDebt;
      liquidations.push({
        lane: Number(e.args.lane),
        account: e.args.account,
        equity: start.equity.toString(),
        badDebt: e.args.badDebt.toString(),
        txHash: at.hash,
        logIndex: e.logIndex,
      });
      resolvedInTx.set(at.hash, (resolvedInTx.get(at.hash) ?? 0) + 1);
    } else if (e.eventName === "AuctionCancelled") {
      cured++;
      outcomes.set(acct, { outcome: "cured", ...at });
    }
  }

  // Legacy counterfactual: the old path closes at mark and charges LIQUIDATION_FEE_BPS of the
  // notional, capped at the remaining equity — evaluated on the same accounts at auction start.
  const feeBps = BigInt(opts.legacyFeeBps);
  let legacyLoss = BigInt(0);
  let equityAtStart = BigInt(0);
  const vsLegacy = { worse: 0, equal: 0, better: 0, worstExtra: BigInt(0) };
  for (const [acct, st] of starts) {
    const eq = st.equity > BigInt(0) ? st.equity : BigInt(0);
    const penalty = (st.notional * feeBps) / BigInt(BPS);
    const legacy = penalty < eq ? penalty : eq;
    legacyLoss += legacy;
    const o = outcomes.get(acct)?.outcome;
    if (o === "backstop" || o === "external") {
      const took = eq - (residualOf.get(acct) ?? BigInt(0));
      if (took > legacy) {
        vsLegacy.worse++;
        if (took - legacy > vsLegacy.worstExtra) vsLegacy.worstExtra = took - legacy;
      } else if (took === legacy) vsLegacy.equal++;
      else vsLegacy.better++;
    } else if (o === "expired") vsLegacy.equal++;
    else if (o === "cured" && legacy > BigInt(0)) vsLegacy.better++;
    else if (o === "cured") vsLegacy.equal++;
    // Cured accounts keep everything; only taken / expired ones hand equity over.
    if (o === "backstop" || o === "external" || o === "expired") equityAtStart += eq;
  }

  // Time underwater: shock block → resolution block; ms from the keeper seeing the shock receipt
  // to it seeing the resolving tx's receipt (or, for txs not sent by this keeper, the block).
  const perAccount: UnderwaterReport["perAccount"] = [];
  const msList: number[] = [];
  for (const [acct, st] of starts) {
    const o = outcomes.get(acct);
    if (!o) continue;
    perAccount.push({ account: acct as `0x${string}`, lane: st.lane, fromBlock: opts.shockBlock, toBlock: o.block, outcome: o.outcome });
    const seen = opts.seenAt(o.hash, o.block);
    if (seen !== null) msList.push(seen - opts.shockAt);
  }
  const blocksList = perAccount.map((p) => p.toBlock - p.fromBlock).sort((x, y) => x - y);
  const takes = takenByBackstop + takenExternal;
  return {
    auctions: {
      started: starts.size,
      takenByBackstop,
      takenExternal,
      cured,
      expired,
      avgDiscountBps: takes ? Math.round((discountSum / takes) * 100) / 100 : 0,
      traderResidualReturned: residual.toString(),
      backstopPaid: backstopPaid.toString(),
      badDebt: badDebt.toString(),
      legacyCounterfactual: { traderLoss: legacyLoss.toString() },
      traderEquityAtStart: equityAtStart.toString(),
    },
    underwater: {
      maxBlocks: blocksList.length ? blocksList[blocksList.length - 1] : 0,
      p50Blocks: percentile(blocksList, 50),
      p95Blocks: percentile(blocksList, 95),
      maxMs: msList.length ? Math.max(...msList) : 0,
      perAccount,
    },
    liquidations,
    resolvedInTx,
    unresolved: starts.size - perAccount.length,
    vsLegacy: { ...vsLegacy, worstExtra: vsLegacy.worstExtra.toString() },
  };
}

/** Auction events of `address` in [from, to], fetched in 100-block chunks (public RPC log limit). */
export async function fetchAuctionEvents(ctx: KeeperContext, address: Address, from: number, to: number): Promise<AuctionEvents> {
  const logs: Log[] = [];
  for (let a = from; a <= to; a += 100) {
    const b = Math.min(to, a + 99);
    logs.push(...(await ctx.client.getLogs({ address, fromBlock: BigInt(a), toBlock: BigInt(b) })));
  }
  return decodeAuctionEvents(logs).sort((x, y) => Number(x.blockNumber) - Number(y.blockNumber) || x.logIndex - y.logIndex);
}

/**
 * Owns the crash/recover state machine. One instance per process; the HTTP server and the
 * standalone bench both drive it.
 */
export class CrashController {
  crashed = false;
  /** Oracle prices (1e18) right before the first shock of the current crashed episode. */
  private preCrash: Record<string, bigint> | null = null;
  private readonly runs = new Map<string, RunReport>();
  private readonly xrays = new Map<string, XrayReport>();
  private readonly xrayPending = new Set<string>();
  activeRunId: string | null = null;
  lastRunId: string | null = null;

  constructor(
    private readonly ctx: KeeperContext,
    private readonly loop: PriceLoop | null,
    private readonly sweeper: Sweeper | null,
    private readonly log: (m: string) => void = (m) => console.log(m),
  ) {}

  getRun(runId: string): RunReport | undefined {
    return this.runs.get(runId);
  }

  listRuns(): Array<Pick<RunReport, "runId" | "status">> {
    return [...this.runs.values()].map((r) => ({ runId: r.runId, status: r.status }));
  }

  /** X-ray of a run: memory, else bench/xray/<chainId>-<runId>.json; "pending" while it is computed. */
  getXray(runId: string): XrayReport | "pending" | null {
    const x = this.xrays.get(runId);
    if (x) return x;
    if (this.xrayPending.has(runId) || this.runs.get(runId)?.status === "running") return "pending";
    return readXray(this.ctx, runId);
  }

  resolveMode(mode: CrashOptions["mode"]): RunReport["mode"] {
    if (mode === "legacy") return "legacy";
    if (mode === "auctions" && !this.ctx.features.auctions) {
      throw new Error("the deployed clearinghouse has no auction API (startAuctions); use mode legacy");
    }
    return this.ctx.features.auctions ? "auctions" : "legacy";
  }

  /** Start a run in the background (HTTP /crash). Throws BusyError if one is active. */
  start(opts: CrashOptions | number): { runId: string; done: Promise<RunReport> } {
    const o: CrashOptions = typeof opts === "number" ? { bps: opts } : opts;
    if (this.activeRunId) throw new BusyError(this.activeRunId);
    const mode = this.resolveMode(o.mode);
    const runId = newRunId();
    const report = emptyReport(this.ctx, runId, o.bps, mode);
    this.runs.set(runId, report);
    while (this.runs.size > MAX_RUNS_KEPT) this.runs.delete(this.runs.keys().next().value as string);
    this.activeRunId = runId;
    this.lastRunId = runId;
    const xray = o.xray ?? this.ctx.config.xray !== "off";
    const done = this.execute(report, xray)
      .catch((err: unknown) => {
        report.status = "failed";
        report.error = (err as Error)?.message?.split("\n")[0] ?? String(err);
      })
      .then(() => {
        this.activeRunId = null;
        return report;
      });
    return { runId, done };
  }

  /** Run to completion (bench). */
  run(opts: CrashOptions | number): Promise<RunReport> {
    return this.start(opts).done;
  }

  private async execute(report: RunReport, xray: boolean): Promise<void> {
    const { ctx } = this;
    const { client, dep, config } = ctx;
    const ids = ctx.markets.map((m) => m.id);
    const wait = { pollMs: config.receiptPollMs, timeoutMs: config.receiptTimeoutMs };
    const designs = report.mode === "auctions" && this.sweeper ? this.sweeper.designs : this.legacyDesigns();

    // 1. Quiesce the price loop: from here until /recover, only the shock and the resolution txs
    //    touch the oracle/clearinghouse.
    if (this.loop) await this.loop.pause(`crash ${report.runId}`);
    report.priceLoopPaused = true;
    // Legacy runs fire their own batches: the sweeper must not act on the same accounts.
    const sweeperWasRunning = this.sweeper?.status().running ?? false;
    if (report.mode === "legacy" && this.sweeper) await this.sweeper.pause(`legacy crash ${report.runId}`);
    if (report.mode === "auctions") {
      if (!this.sweeper) throw new Error("crash v2 needs a sweeper");
      if (!sweeperWasRunning) this.sweeper.start(); // e.g. SWEEPER=0: run it for this crash only
      await this.sweeper.idle(); // nothing of the sweeper's own still in flight
    }
    const capture = report.mode === "auctions" ? this.sweeper!.capture() : null;

    let shockSent = false;
    let lastBlock = 0;
    try {
      if (!this.crashed || !this.preCrash) {
        const snap = await readOraclePrices(ctx);
        this.preCrash = Object.fromEntries(Object.entries(snap).map(([s, v]) => [s, v.price]));
      }

      // 2. Shock all markets in one oracle tx.
      const operator = ctx.senders.for(ctx.roles.operator);
      const shockData = encodeFunctionData({
        abi: abis.oracle,
        functionName: "shockPrices",
        args: [ids, BigInt(report.shock.bps)],
      });
      const shockGas = await estimateLimit(
        client,
        { account: operator.address, to: dep.oracle, data: shockData },
        config.gasMarginBps,
      );
      const shock = await operator.send({ to: dep.oracle, data: shockData, gas: shockGas.limit });
      shockSent = true;
      this.crashed = true;
      report.shock.txHash = shock.hash;
      report.shock.submittedAt = shock.submittedAt;
      const shockRcpt = await waitForReceipt(client, shock.hash, wait);
      report.shock.block = Number(shockRcpt.receipt.blockNumber);
      report.shock.confirmedAt = shockRcpt.observedAt;
      if (shockRcpt.receipt.status !== "success") throw new Error(`shock tx ${shock.hash} reverted`);
      const atBlock = shockRcpt.receipt.blockNumber;
      report.totals.accountsScanned = await this.countAccounts(dep.clearinghouse, atBlock);

      if (report.mode === "legacy") {
        lastBlock = await this.legacyResolve(report, designs, atBlock);
      } else {
        lastBlock = await this.auctionResolve(report, designs, capture!);
      }
    } catch (err) {
      capture?.close();
      // Nothing changed on chain → resume prices. Once the shock is out we stay "crashed"
      // (loop paused) until /recover restores the pre-crash prices.
      if (!shockSent && this.loop && !this.crashed) this.loop.resume();
      if (report.mode === "legacy" && this.sweeper) this.sweeper.resume();
      throw err;
    } finally {
      if (report.mode === "auctions" && this.sweeper && !sweeperWasRunning) await this.sweeper.stop();
    }
    if (report.mode === "legacy" && this.sweeper) this.sweeper.resume();

    // 5. Conflict X-ray of the resolution phase of every design.
    if (xray && report.shock.block !== null && lastBlock > report.shock.block) {
      this.xrayPending.add(report.runId);
      try {
        const x = await runXray(ctx, {
          runId: report.runId,
          fromBlock: report.shock.block + 1,
          toBlock: lastBlock,
          designs,
          log: this.log,
        });
        this.xrays.set(report.runId, x);
        while (this.xrays.size > MAX_RUNS_KEPT) this.xrays.delete(this.xrays.keys().next().value as string);
        report.xrayId = report.runId;
      } catch (err) {
        report.xrayError = (err as Error)?.message?.split("\n")[0] ?? String(err);
        this.log(`[xray] failed: ${report.xrayError}`);
      } finally {
        this.xrayPending.delete(report.runId);
      }
    }
    if (report.status === "running") report.status = "done";
  }

  private legacyDesigns(): DesignRef[] {
    return this.ctx.designs.filter((d) => d.label === "paraclr" || this.ctx.config.sweepNaive !== "off");
  }

  private async countAccounts(address: Address, blockNumber: bigint): Promise<number> {
    const counts = await Promise.all(
      Array.from({ length: LANE_COUNT }, (_, lane) =>
        this.ctx.client.readContract({
          address,
          abi: abis.clearinghouse,
          functionName: "laneAccountCount",
          args: [lane],
          blockNumber,
        }),
      ),
    );
    return counts.reduce((s, c) => s + Number(c), 0);
  }

  // ---------------------------------------------------------------------------
  // v2: auctions driven by the sweeper
  // ---------------------------------------------------------------------------

  private async auctionResolve(
    report: RunReport,
    designs: DesignRef[],
    capture: NonNullable<ReturnType<Sweeper["capture"]>>,
  ): Promise<number> {
    const { ctx } = this;
    const sweeper = this.sweeper!;
    const shockBlock = report.shock.block!;
    const deadline = Date.now() + ctx.config.crashResolveTimeoutMs;

    // 3. Wait until every design is clear: no liquidatable account outside an auction, no active
    //    auction, nothing of the sweeper's in flight — as seen at a block after the shock.
    let clear = false;
    while (!clear && Date.now() < deadline) {
      await sleep(ctx.config.sweeperPollMs);
      clear = designs.every((d) => {
        const s = sweeper.scans.get(d.design);
        return (
          s !== undefined &&
          s.block > shockBlock &&
          s.liquidatable === 0 &&
          s.inAuction === 0 &&
          sweeper.pendingFor(d.design) === 0 &&
          sweeper.takersHolding(d.design) === 0 // demo takers closed what they inherited
        );
      });
    }
    await sweeper.idle();
    const txs = capture.close();
    if (!clear) {
      const left = designs
        .map((d) => {
          const s = sweeper.scans.get(d.design);
          return `${d.label}: ${s?.liquidatable ?? "?"} liquidatable, ${s?.inAuction ?? "?"} in auction`;
        })
        .join("; ");
      report.status = "failed";
      report.error = `auctions not resolved within ${ctx.config.crashResolveTimeoutMs} ms (${left})`;
    }

    // 4. Report for the lane-sharded design (the naive one runs the same logic; see the X-ray).
    const paraclr = designs.find((d) => d.label === "paraclr") ?? designs[0];
    const mine = txs.filter((t) => t.design === paraclr.design && t.block !== null);
    const lastBlock = Math.max(shockBlock, ...txs.map((t) => t.block ?? 0));
    const [events, feeBps] = await Promise.all([
      fetchAuctionEvents(ctx, paraclr.address, shockBlock, lastBlock),
      ctx.client
        .readContract({ address: paraclr.address, abi: abis.clearinghouse, functionName: "LIQUIDATION_FEE_BPS" })
        .then(Number, () => 100), // plan/README default: 1% of notional
    ]);
    this.fillAuctionReport(report, mine, events, sweeper, feeBps);
    const problems = txs.filter((t) => t.status === "reverted" || t.status === "lost");
    if (problems.length && report.status !== "failed") {
      report.status = "failed";
      report.error = problems.map((t) => `${t.status}: ${t.design} lane ${t.lane} ${t.kind} (${t.hash})`).join("; ");
    }
    await this.fillExpiredResidual(report, paraclr);
    return lastBlock;
  }

  private fillAuctionReport(
    report: RunReport,
    txs: SweepTx[],
    events: AuctionEvents,
    sweeper: Sweeper,
    legacyFeeBps: number,
  ): void {
    const confirmedAtByHash = new Map(txs.map((t) => [t.hash, t.confirmedAt]));
    const sum = summarizeAuctions(events, {
      shockBlock: report.shock.block!,
      shockAt: report.shock.confirmedAt ?? report.shock.submittedAt,
      legacyFeeBps,
      seenAt: (hash, block) => confirmedAtByHash.get(hash) ?? sweeper.blockSeenAt.get(block) ?? null,
    });
    report.auctions = { ...sum.auctions, externalTakers: sweeper.externalTakersInfo() };
    report.underwater = sum.underwater;
    if (sum.unresolved > 0 && report.status !== "failed") {
      report.status = "failed";
      report.error = `${sum.unresolved} auction(s) started by the crash were not resolved`;
    }
    const { liquidations, resolvedInTx } = sum;
    const badDebt = BigInt(sum.auctions.badDebt);

    // Backward-compatible batch / liquidation / totals view.
    report.batches = txs.map((t) => ({
      txHash: t.hash,
      block: t.block,
      submittedAt: t.submittedAt,
      confirmedAt: t.confirmedAt,
      lane: t.lane,
      keeper: t.keeper,
      accounts: t.accounts.length,
      liquidated: resolvedInTx.get(t.hash) ?? 0,
      gasUsed: (t.gasUsed ?? BigInt(0)).toString(),
      gasLimit: t.gasLimit.toString(),
      kind: t.kind,
    }));
    report.liquidations = liquidations;
    const blocks = [...new Set(txs.map((t) => t.block as number))].sort((a, b) => a - b);
    const confirmed = txs.filter((t) => t.confirmedAt !== null);
    report.totals = {
      accountsScanned: report.totals.accountsScanned,
      liquidated: liquidations.length,
      badDebt: badDebt.toString(),
      wallClockMs: confirmed.length
        ? Math.max(...confirmed.map((t) => t.confirmedAt as number)) - Math.min(...txs.map((t) => t.submittedAt))
        : 0,
      blocks,
      sameBlock: blocks.length === 1,
      totalGasUsed: txs.reduce((s, t) => s + (t.gasUsed ?? BigInt(0)), BigInt(0)).toString(),
    };
  }

  /** Expired accounts keep whatever collateral the expiry leaves: add it to traderResidualReturned. */
  private async fillExpiredResidual(report: RunReport, design: DesignRef): Promise<void> {
    if (!report.auctions) return;
    const expiredAt = (report.underwater?.perAccount ?? []).filter((p) => p.outcome === "expired");
    if (expiredAt.length === 0) return;
    const cols = await Promise.all(
      expiredAt.map((p) =>
        this.ctx.client.readContract({
          address: design.address,
          abi: abis.clearinghouse,
          functionName: "getAccount",
          args: [p.account],
          blockNumber: BigInt(p.toBlock),
        }),
      ),
    );
    let extra = BigInt(0);
    for (const [collateral] of cols) if (collateral > BigInt(0)) extra += collateral;
    report.auctions.traderResidualReturned = (BigInt(report.auctions.traderResidualReturned) + extra).toString();
  }

  // ---------------------------------------------------------------------------
  // Legacy: one liquidateBatch per lane per design, fired concurrently
  // ---------------------------------------------------------------------------

  private async legacyResolve(report: RunReport, designs: DesignRef[], atBlock: bigint): Promise<number> {
    const { ctx } = this;
    const { client, config } = ctx;
    const wait = { pollMs: config.receiptPollMs, timeoutMs: config.receiptTimeoutMs };
    const paraclr = designs[0];

    // Discover liquidatable accounts per lane per design (state as of the shock block).
    const work = (
      await Promise.all(
        designs.flatMap((d) => Array.from({ length: LANE_COUNT }, (_, lane) => this.discoverLane(d, lane, atBlock))),
      )
    ).filter((l) => l.liquidatable.length > 0);
    const plans = await Promise.all(work.map((l) => this.planLane(l.design, l.lane, l.liquidatable)));

    // Sign everything first, then fire. Fees quoted once for the whole run.
    const fees = await ctx.senders.fees.get(true);
    const signed: Array<{ lane: number; design: DesignRef; keeper: Address; chunks: Array<{ chunk: LaneChunk; tx: SignedTx }> }> = [];
    for (const chunks of plans) {
      const { lane, design } = chunks[0];
      const sender = ctx.senders.for(keeperForLane(ctx.roles, lane));
      const out: Array<{ chunk: LaneChunk; tx: SignedTx }> = [];
      for (const chunk of chunks) {
        out.push({ chunk, tx: await sender.sign({ to: chunk.design.address, data: chunk.data, gas: chunk.gasLimit }, fees) });
      }
      signed.push({ lane, design, keeper: sender.address, chunks: out });
    }

    const all: BatchReport[] = [];
    const designOf = new Map<Hex, DesignRef>();
    const byHash = new Map<Hex, BatchReport>();
    for (const s of signed) {
      for (const { chunk, tx } of s.chunks) {
        const b: BatchReport = {
          txHash: tx.hash,
          block: null,
          submittedAt: 0,
          confirmedAt: null,
          lane: s.lane,
          keeper: s.keeper,
          accounts: chunk.accounts.length,
          liquidated: 0,
          gasUsed: "0",
          gasLimit: chunk.gasLimit.toString(),
          kind: "liquidateBatch",
        };
        all.push(b);
        byHash.set(tx.hash, b);
        designOf.set(tx.hash, s.design);
      }
    }

    // One keeper key per lane: lanes go out concurrently, a key's own txs in nonce order.
    const sendErrors: string[] = [];
    const byKeeper = new Map<Address, typeof signed>();
    for (const s of signed) byKeeper.set(s.keeper, [...(byKeeper.get(s.keeper) ?? []), s]);
    await Promise.all(
      [...byKeeper.values()].map(async (group) => {
        for (const s of group) {
          const sender = ctx.senders.for(keeperForLane(ctx.roles, s.lane));
          for (const { tx } of s.chunks) {
            try {
              const sub = await sender.broadcast(tx);
              byHash.get(tx.hash)!.submittedAt = sub.submittedAt;
            } catch (err) {
              sendErrors.push(`${s.design.label} lane ${s.lane}: ${(err as Error)?.message?.split("\n")[0] ?? err}`);
              return; // later txs of this key would have a nonce gap
            }
          }
        }
      }),
    );

    const sent = all.filter((b) => b.submittedAt > 0);
    const observed = await waitForReceipts(client, sent.map((b) => b.txHash), wait);
    let badDebt = BigInt(0);
    let gasTotal = BigInt(0);
    const reverted: string[] = [];
    for (const b of sent) {
      const o = observed.get(b.txHash);
      if (!o) continue;
      b.block = Number(o.receipt.blockNumber);
      b.confirmedAt = o.observedAt;
      b.gasUsed = o.receipt.gasUsed.toString();
      if (o.receipt.status !== "success") {
        reverted.push(`${designOf.get(b.txHash)!.label} lane ${b.lane} (${b.txHash})`);
        continue;
      }
      if (designOf.get(b.txHash) !== paraclr) continue;
      gasTotal += o.receipt.gasUsed;
      const logs = parseEventLogs({
        abi: abis.clearinghouse,
        logs: o.receipt.logs.filter((l) => l.address.toLowerCase() === paraclr.address.toLowerCase()),
        eventName: ["Liquidated", "LaneSettled"],
      });
      for (const log of logs) {
        if (log.eventName === "LaneSettled") {
          b.liquidated = Number(log.args.liquidated);
        } else if (log.eventName === "Liquidated") {
          badDebt += log.args.badDebt;
          report.liquidations.push({
            lane: Number(log.args.lane),
            account: log.args.account,
            equity: log.args.equity.toString(),
            badDebt: log.args.badDebt.toString(),
            txHash: b.txHash,
            logIndex: log.logIndex,
          });
        }
      }
    }

    const mine = sent.filter((b) => designOf.get(b.txHash) === paraclr);
    report.batches = all.filter((b) => designOf.get(b.txHash) === paraclr);
    const blocks = [...new Set(mine.filter((b) => b.block !== null).map((b) => b.block as number))].sort((a, b) => a - b);
    const confirmed = mine.filter((b) => b.confirmedAt !== null);
    report.totals = {
      accountsScanned: report.totals.accountsScanned,
      liquidated: report.liquidations.length,
      badDebt: badDebt.toString(),
      wallClockMs: confirmed.length
        ? Math.max(...confirmed.map((b) => b.confirmedAt as number)) - Math.min(...mine.map((b) => b.submittedAt))
        : 0,
      blocks,
      sameBlock: blocks.length === 1,
      totalGasUsed: gasTotal.toString(),
    };

    const problems = [
      ...sendErrors.map((e) => `send failed: ${e}`),
      ...reverted.map((r) => `reverted: ${r}`),
      ...sent
        .filter((b) => !observed.has(b.txHash))
        .map((b) => `no receipt: ${designOf.get(b.txHash)!.label} lane ${b.lane} (${b.txHash})`),
    ];
    if (problems.length) {
      report.status = "failed";
      report.error = problems.join("; ");
    }
    return Math.max(report.shock.block ?? 0, ...sent.map((b) => b.block ?? 0));
  }

  private async discoverLane(design: DesignRef, lane: number, blockNumber: bigint) {
    const { client } = this.ctx;
    const count = Number(
      await client.readContract({
        address: design.address,
        abi: abis.clearinghouse,
        functionName: "laneAccountCount",
        args: [lane],
        blockNumber,
      }),
    );
    const liquidatable: Address[] = [];
    for (let offset = 0; offset < count; offset += DISCOVERY_PAGE) {
      const page = await client.readContract({
        address: design.address,
        abi: abis.clearinghouse,
        functionName: "getLiquidatableAccounts",
        args: [lane, BigInt(offset), BigInt(DISCOVERY_PAGE)],
        blockNumber,
      });
      liquidatable.push(...page);
    }
    return { design, lane, count, liquidatable };
  }

  /**
   * estimateGas for the whole lane; if the limit exceeds the per-tx cap, split in halves until
   * every piece fits. Later pieces are estimated against pre-batch state, so they get +10% extra.
   */
  private async planLane(design: DesignRef, lane: number, accounts: Address[]): Promise<LaneChunk[]> {
    const { ctx } = this;
    const keeper = keeperForLane(ctx.roles, lane);
    const plan = async (accts: Address[], marginBps: number): Promise<LaneChunk[]> => {
      const data = encodeFunctionData({
        abi: abis.clearinghouse,
        functionName: "liquidateBatch",
        args: [lane, accts],
      });
      const { limit } = await estimateLimit(ctx.client, { account: keeper.address, to: design.address, data }, marginBps);
      if (limit <= ctx.config.maxTxGas || accts.length === 1) return [{ lane, design, accounts: accts, data, gasLimit: limit }];
      const mid = Math.ceil(accts.length / 2);
      const split = ctx.config.gasMarginBps + 1_000;
      const [a, b] = await Promise.all([plan(accts.slice(0, mid), split), plan(accts.slice(mid), split)]);
      return [...a, ...b];
    };
    return plan(accounts, ctx.config.gasMarginBps);
  }

  /** Restore the pre-crash prices in one setPrices tx from the operator and resume the loop. */
  async recover(): Promise<{ txHash: Hex; block: number }> {
    if (this.activeRunId) throw new BusyError(this.activeRunId);
    if (!this.crashed || !this.preCrash) throw new NotCrashedError();
    const { ctx } = this;
    const snap = this.preCrash;
    const operator = ctx.senders.for(ctx.roles.operator);
    const data = encodeFunctionData({
      abi: abis.oracle,
      functionName: "setPrices",
      args: [ctx.markets.map((m) => m.id), ctx.markets.map((m) => snap[m.symbol] ?? BigInt(0))],
    });
    const { limit } = await estimateLimit(
      ctx.client,
      { account: operator.address, to: ctx.dep.oracle, data },
      ctx.config.gasMarginBps,
    );
    const sub = await operator.send({ to: ctx.dep.oracle, data, gas: limit });
    const { receipt } = await waitForReceipt(ctx.client, sub.hash, {
      pollMs: ctx.config.receiptPollMs,
      timeoutMs: ctx.config.receiptTimeoutMs,
    });
    if (receipt.status !== "success") throw new Error(`recover tx ${sub.hash} reverted`);
    this.crashed = false;
    this.preCrash = null;
    this.loop?.resume(Object.fromEntries(Object.entries(snap).map(([s, p]) => [s, fromWad(p)])));
    return { txHash: sub.hash, block: Number(receipt.blockNumber) };
  }
}
