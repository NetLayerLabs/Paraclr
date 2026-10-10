// "What you kept": an auction liquidation compared with the fixed-penalty liquidation it replaces.
// Pure (no React, no chain), so the app, the PnL card, the Arena and tests can share one formula.

/**
 * The fixed penalty of the baseline liquidation: `LIQUIDATION_FEE_BPS = 100` (1% of notional,
 * capped at the remaining equity), the old `liquidateBatch` / expiry close-out in
 * contracts/src/ParaclrClearinghouse.sol (`_closeOut`) and contracts/src/prod/ParaclrClearinghouseProd.sol
 * (`_closeOut`). The naive baseline (contracts/src/NaiveClearinghouseDemo.sol) is the same code.
 */
export const FIXED_PENALTY_BPS = 100;

const BPS = BigInt(10_000);
const ZERO = BigInt(0);
const MICRO = 1e6;

export interface KeptRawInput {
  /** Account notional when the auction started (AuctionStarted.notional), AUSD 6-decimal units. */
  notional: bigint;
  /** Account equity when the auction started (AuctionStarted.equity, signed), AUSD 6-decimal units. */
  equityAtStart: bigint;
  /** What the take returned to the trader (AuctionTaken.traderResidual). The measured outcome. */
  traderResidual?: bigint | null;
  /**
   * Discount the account is (or would be) taken at. Used only without `traderResidual`, as a
   * projection: the contract pays the taker min(notional × discount, max(equity, 0)).
   */
  discountBps?: number | null;
  /** Notional at the take, for the projection (defaults to `notional`). */
  notionalAtTake?: bigint | null;
  /** Fixed penalty in bps (defaults to FIXED_PENALTY_BPS). */
  feeBps?: number;
}

export interface KeptRaw {
  /** What the fixed-penalty liquidation would have taken: min(notional × fee, max(equity, 0)). */
  fixedPenalty: bigint;
  /** What the auction took from the trader: max(equity, 0) − traderResidual (or the projected payment). */
  auctionCost: bigint;
  /** fixedPenalty − auctionCost. Negative when the auction cost the trader more than the penalty. */
  kept: bigint;
  /** "residual" = measured from the take; "discount" = projected from a discount. */
  basis: "residual" | "discount";
}

/**
 * The bench's per-account comparison, in the contract's integer units (exactly
 * keeper/src/crash.ts `summarizeAuctions`, reported by bench/run.ts as `vsLegacy` /
 * `legacyCounterfactual.traderLoss` and in the README's "Taken from traders: auction vs old
 * fixed-fee path" column):
 *
 *   eq           = max(equityAtStart, 0)
 *   fixedPenalty = min(notional × feeBps / 10000, eq)        (integer division, as on chain)
 *   auctionCost  = eq − traderResidual
 *   kept         = fixedPenalty − auctionCost
 *
 * Equity and notional are the AuctionStarted values: the fixed-penalty path would have closed the
 * account at that moment. Null when there is neither a residual nor a discount to measure from.
 */
export function keptVsFixedRaw(i: KeptRawInput): KeptRaw | null {
  const fee = BigInt(Math.round(i.feeBps ?? FIXED_PENALTY_BPS));
  if (i.notional < ZERO || fee < ZERO) return null;
  const eq = i.equityAtStart > ZERO ? i.equityAtStart : ZERO;
  const penalty = (i.notional * fee) / BPS;
  const fixedPenalty = penalty < eq ? penalty : eq;
  let auctionCost: bigint;
  let basis: KeptRaw["basis"];
  if (i.traderResidual != null) {
    if (i.traderResidual < ZERO) return null;
    auctionCost = eq - i.traderResidual;
    basis = "residual";
  } else if (i.discountBps != null && Number.isFinite(i.discountBps) && i.discountBps >= 0) {
    const n = i.notionalAtTake ?? i.notional;
    if (n < ZERO) return null;
    const pay = (n * BigInt(Math.round(i.discountBps))) / BPS;
    auctionCost = pay < eq ? pay : eq;
    basis = "discount";
  } else return null;
  return { fixedPenalty, auctionCost, kept: fixedPenalty - auctionCost, basis };
}

export interface KeptInput {
  /** Account notional when the auction started, AUSD. */
  notional: number;
  /** Account equity when the auction started, AUSD (may be negative). */
  equityAtStart: number;
  /** What the take returned to the trader, AUSD (AuctionTaken.traderResidual). Preferred. */
  traderResidual?: number | null;
  /** Discount for a projection when there is no residual (e.g. "if taken now"). */
  discountBps?: number | null;
  /** Notional at the take, AUSD, for the projection (defaults to `notional`). */
  notionalAtTake?: number | null;
  /** Fixed penalty in bps (defaults to FIXED_PENALTY_BPS = 100, i.e. 1%). */
  feeBps?: number;
}

export interface KeptResult {
  /** AUSD a fixed-penalty liquidation would have taken. */
  fixedPenalty: number;
  /** AUSD the auction took (or would take, for basis "discount"). */
  auctionCost: number;
  /** fixedPenalty − auctionCost, AUSD. Negative = the auction cost more than the fixed penalty. */
  kept: number;
  basis: "residual" | "discount";
}

const toRaw = (n: number | null | undefined): bigint | null =>
  n == null || !Number.isFinite(n) ? null : BigInt(Math.round(n * MICRO));
const fromRaw = (n: bigint): number => Number(n) / MICRO;

/**
 * `keptVsFixedRaw` on AUSD numbers (rounded to the contract's 6 decimals first, so the result
 * matches the bench to the micro-AUSD). Null when an input is missing or not finite: never a
 * made-up number.
 */
export function keptVsFixed(i: KeptInput): KeptResult | null {
  const notional = toRaw(i.notional);
  const equityAtStart = toRaw(i.equityAtStart);
  if (notional === null || equityAtStart === null) return null;
  const residual = toRaw(i.traderResidual);
  if (i.traderResidual != null && residual === null) return null;
  const r = keptVsFixedRaw({
    notional,
    equityAtStart,
    traderResidual: residual,
    discountBps: i.discountBps,
    notionalAtTake: toRaw(i.notionalAtTake),
    feeBps: i.feeBps,
  });
  if (!r) return null;
  return { fixedPenalty: fromRaw(r.fixedPenalty), auctionCost: fromRaw(r.auctionCost), kept: fromRaw(r.kept), basis: r.basis };
}

/** "1%" for 100 bps, "0.5%" for 50. */
export function fmtPenaltyPct(feeBps: number = FIXED_PENALTY_BPS): string {
  return `${(feeBps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}
