// The fair-liquidation API (auctions, backstop pools, solvency) is part of the
// generated clearinghouse ABI (contracts/src/ParaclrClearinghouse.sol →
// `npm run abi`). Re-exported under one name so the feature modules read as
// "the fair-liquidation calls" and stay type-checked against the contract.

export { paraclrClearinghouseAbi as fairAbi } from "./abi";

/**
 * Plan defaults (docs/FAIR_LIQUIDATION_PLAN.md), used until the on-chain
 * values (`auctionStepBps()`, `auctionMaxDiscountBps()`,
 * `backstopMinDiscountBps(lane)`) have been read.
 */
export const AUCTION_DEFAULTS = {
  stepBps: 25,
  maxDiscountBps: 500,
  backstopMinDiscountBps: 150,
} as const;
