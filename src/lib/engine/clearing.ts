// Clearing run simulation.
//
// This is a SIMULATION of Monad's execution model, not a measurement. Each
// operation carries a modeled cost (see DEFAULT_COSTS). In parallel mode each
// lane walks its own accounts in order and lanes run concurrently, so the run
// finishes when the slowest lane commits. The sequential baseline performs the
// exact same operations one after another, as a single-threaded EVM would.

import { MAINTENANCE_MARGIN } from "@/lib/store";
import { THREAD_COUNT } from "@/lib/types";
import type { ClearingAccount, ClearingEvent, ClearingRunSummary } from "@/lib/types";
import type { MarkPrices } from "./accounts";
import { createRng } from "./rng";
import { evaluateAccount } from "./risk";

export interface OpCosts {
  /** Oracle read + cross-margin health check, per account (ms). */
  check: number;
  /** Close positions at mark, seize collateral (ms). */
  liquidate: number;
  /** Draw from the lane insurance fund / write settlement (ms). */
  settle: number;
  /** Per-lane state commit at the end of the batch (ms). */
  commit: number;
  /** ± fraction of random jitter applied to each op. */
  jitter: number;
}

export const DEFAULT_COSTS: OpCosts = {
  check: 3.8,
  liquidate: 5.0,
  settle: 2.6,
  commit: 4,
  jitter: 0.18,
};

export const DEFAULT_INSURANCE_PER_LANE = 75_000; // AUSD
/** Share of liquidated notional paid to the lane insurance fund. */
export const LIQUIDATION_FEE = 0.01;

export interface ClearingOptions {
  seed?: number;
  maintenanceMargin?: number;
  costs?: Partial<OpCosts>;
  /** Starting insurance fund per lane (AUSD). Array → per-lane values. */
  insurance?: number | number[];
}

export type AccountOutcome = "healthy" | "warning" | "liquidated" | "settled";

export interface AccountResult {
  accountId: string;
  thread: number;
  outcome: AccountOutcome; // "settled" = liquidated with bad debt covered
  equity: number;
  badDebt: number;
  uncovered: number; // bad debt the lane fund could not absorb
  checkedAt: number;
}

export interface LaneResult {
  thread: number;
  accounts: number;
  liquidated: number;
  badDebt: number;
  insuranceStart: number;
  insuranceEnd: number;
  /** When this lane committed, ms since run start (parallel mode). */
  finishedAt: number;
}

export interface ClearingRun {
  /** Parallel timeline, sorted by `at`. */
  events: ClearingEvent[];
  summary: ClearingRunSummary;
  lanes: LaneResult[];
  results: Record<string, AccountResult>;
  /** Accounts in lane-processing order, per lane (for rendering). */
  laneOrder: string[][];
  /** Same work executed one op at a time. */
  sequentialMs: number;
  /** Sequential completion time of each account (ascending), for race bars. */
  sequentialDoneAt: number[];
  totalBadDebt: number;
  uncoveredDebt: number;
  seizedCollateral: number;
}

function laneInsurance(opt: ClearingOptions["insurance"], lane: number): number {
  if (Array.isArray(opt)) return opt[lane] ?? 0;
  return opt ?? DEFAULT_INSURANCE_PER_LANE;
}

/** Health-check, liquidate and settle every account against `marks`. */
export function runClearing(
  accounts: ClearingAccount[],
  marks: MarkPrices,
  opts: ClearingOptions = {},
): ClearingRun {
  const costs: OpCosts = { ...DEFAULT_COSTS, ...opts.costs };
  const mm = opts.maintenanceMargin ?? MAINTENANCE_MARGIN;
  const rand = createRng(opts.seed ?? 0x5eed);
  const cost = (base: number) => base * (1 + (rand() * 2 - 1) * costs.jitter);

  // Shard: each lane owns a disjoint slice of state.
  const laneOrder: string[][] = Array.from({ length: THREAD_COUNT }, () => []);
  const byLane: ClearingAccount[][] = Array.from({ length: THREAD_COUNT }, () => []);
  for (const a of accounts) {
    byLane[a.thread].push(a);
    laneOrder[a.thread].push(a.id);
  }

  const events: ClearingEvent[] = [];
  const results: Record<string, AccountResult> = {};
  const lanes: LaneResult[] = [];
  // Every op's duration in the order a single thread would run them.
  const seqOps: { accountEnd: boolean; ms: number }[] = [];
  let totalBadDebt = 0;
  let uncoveredDebt = 0;
  let seized = 0;

  for (let lane = 0; lane < THREAD_COUNT; lane++) {
    let t = rand() * 2; // scheduler start skew
    let fund = laneInsurance(opts.insurance, lane);
    const lr: LaneResult = {
      thread: lane,
      accounts: byLane[lane].length,
      liquidated: 0,
      badDebt: 0,
      insuranceStart: fund,
      insuranceEnd: fund,
      finishedAt: 0,
    };

    for (const a of byLane[lane]) {
      const risk = evaluateAccount(a, marks, mm);
      const checkMs = cost(costs.check);
      t += checkMs;
      events.push({ accountId: a.id, thread: lane, kind: "checked", debt: 0, at: t });
      const res: AccountResult = {
        accountId: a.id,
        thread: lane,
        outcome: risk.health === "warning" ? "warning" : "healthy",
        equity: risk.equity,
        badDebt: 0,
        uncovered: 0,
        checkedAt: t,
      };

      if (risk.health !== "liquidatable") {
        seqOps.push({ accountEnd: true, ms: checkMs });
      } else {
        seqOps.push({ accountEnd: false, ms: checkMs });
        const liqMs = cost(costs.liquidate);
        t += liqMs;
        lr.liquidated++;
        const fee = Math.min(Math.max(risk.equity, 0), risk.notional * LIQUIDATION_FEE);
        fund += fee;
        seized += Math.max(risk.equity, 0);
        events.push({ accountId: a.id, thread: lane, kind: "liquidated", debt: 0, at: t });
        res.outcome = "liquidated";

        if (risk.equity < 0) {
          seqOps.push({ accountEnd: false, ms: liqMs });
          const debt = -risk.equity;
          const covered = Math.min(debt, fund);
          fund -= covered;
          const settleMs = cost(costs.settle);
          t += settleMs;
          seqOps.push({ accountEnd: true, ms: settleMs });
          events.push({ accountId: a.id, thread: lane, kind: "settled", debt: covered, at: t });
          res.outcome = "settled";
          res.badDebt = debt;
          res.uncovered = debt - covered;
          lr.badDebt += debt;
          totalBadDebt += debt;
          uncoveredDebt += debt - covered;
        } else {
          seqOps.push({ accountEnd: true, ms: liqMs });
        }
      }
      results[a.id] = res;
    }

    const commitMs = cost(costs.commit);
    t += commitMs;
    seqOps.push({ accountEnd: false, ms: commitMs });
    lr.finishedAt = t;
    lr.insuranceEnd = fund;
    lanes.push(lr);
  }

  events.sort((x, y) => x.at - y.at);

  let seqT = 0;
  const sequentialDoneAt: number[] = [];
  for (const op of seqOps) {
    seqT += op.ms;
    if (op.accountEnd) sequentialDoneAt.push(seqT);
  }

  const elapsedMs = lanes.reduce((m, l) => Math.max(m, l.finishedAt), 0);
  const summary: ClearingRunSummary = {
    accounts: accounts.length,
    liquidated: lanes.reduce((s, l) => s + l.liquidated, 0),
    totalDebtSettled: totalBadDebt - uncoveredDebt,
    elapsedMs,
    perThread: lanes.map((l) => l.accounts),
  };

  return {
    events,
    summary,
    lanes,
    results,
    laneOrder,
    sequentialMs: seqT,
    sequentialDoneAt,
    totalBadDebt,
    uncoveredDebt,
    seizedCollateral: seized,
  };
}

/** How many accounts the sequential baseline has finished by time `t`. */
export function sequentialProgress(run: ClearingRun, t: number): number {
  const arr = run.sequentialDoneAt;
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
