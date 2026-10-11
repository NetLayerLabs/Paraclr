// The fair-liquidation API (auctions, backstop pools, solvency) is part of the
// generated clearinghouse ABI (contracts/src/ParaclrClearinghouse.sol →
// `npm run abi`). Re-exported under one name so the feature modules read as
// "the fair-liquidation calls" and stay type-checked against the contract.

export { paraclrClearinghouseAbi as fairAbi } from "./abi";

/**
 * Shown until the on-chain values (`auctionStepBps()`, `auctionMaxDiscountBps()`,
 * `backstopMinDiscountBps(lane)`) have been read, or if that read fails: the
 * live Monad testnet deployment's values (deployments/10143.json `params`, and
 * the demo stack in deployments/demo/10143.json), not the contract defaults
 * (25 bps step, docs/FAIR_LIQUIDATION_PLAN.md), so a slow RPC never shows a
 * step the testnet doesn't use.
 */
export const AUCTION_DEFAULTS = {
  stepBps: 5,
  maxDiscountBps: 500,
  backstopMinDiscountBps: 75,
} as const;
