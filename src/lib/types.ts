// Shared domain types for Paraclr. Every feature module codes against these —
// change them only in coordination with all owners.

export type MarketSymbol = "MON/AUSD" | "SOL/AUSD" | "BTC/AUSD";

export const MARKETS: MarketSymbol[] = ["MON/AUSD", "SOL/AUSD", "BTC/AUSD"];

/**
 * One price observation: a Chainlink Data Streams report, a simulated
 * equivalent, or (chain modes) a read of the on-chain oracle contract the
 * clearinghouse settles against.
 */
export interface PriceTick {
  symbol: MarketSymbol;
  price: number; // quoted in AUSD
  /** Observation time, ms epoch. Oracle ticks use the on-chain `updatedAt` (1s resolution). */
  timestamp: number;
  source: "chainlink" | "simulated" | "oracle";
  /** Block the tick was read at (oracle source only). */
  block?: number;
}

export interface Candle {
  time: number; // bucket start, ms epoch
  open: number;
  high: number;
  low: number;
  close: number;
}

export type Side = "long" | "short";

export interface Position {
  id: string;
  owner: string; // address or demo account id
  symbol: MarketSymbol;
  side: Side;
  size: number; // base units
  entryPrice: number;
  margin: number; // AUSD collateral posted
  leverage: number;
  openedAt: number;
  /**
   * Chain modes only: cross-margin liquidation price computed from the
   * on-chain account (collateral + the other legs at current marks). When
   * absent, `liquidationPrice()` falls back to the isolated approximation.
   */
  liquidationPrice?: number;
  /** Chain modes only: bytes32 market id on the clearinghouse. */
  marketId?: string;
}

export type AccountHealth = "healthy" | "warning" | "liquidatable" | "liquidated";

/** A cross-margin account as seen by the clearinghouse. */
export interface ClearingAccount {
  id: string;
  /**
   * Conflict-free storage lane, 0..LANE_COUNT-1 (on chain: uint160(account) % 8).
   * Field name is historical — this is NOT a Monad execution thread; contracts
   * can't choose those. Lanes only guarantee disjoint storage per batch.
   */
  thread: number;
  collateral: number; // AUSD
  positions: Position[];
  health: AccountHealth;
}

/** Number of conflict-free lanes the clearinghouse shards risk state into. */
export const LANE_COUNT = 8;
/** @deprecated Historical name for LANE_COUNT (lanes are not Monad threads). */
export const THREAD_COUNT = LANE_COUNT;

/** Emitted by the clearing engine for the visualizer. */
export interface ClearingEvent {
  accountId: string;
  thread: number;
  kind: "checked" | "liquidated" | "settled";
  debt: number; // AUSD shortfall covered (0 if none)
  at: number; // ms since the clearing run started
}

export interface ClearingRunSummary {
  accounts: number;
  liquidated: number;
  totalDebtSettled: number;
  elapsedMs: number;
  perThread: number[]; // accounts processed per thread
}

export interface Session {
  address: string;
  method: "passkey" | "demo";
  displayName: string;
}
