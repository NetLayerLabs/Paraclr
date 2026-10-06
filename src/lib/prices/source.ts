import type { Candle, MarketSymbol, PriceTick } from "../types";

export type TickHandler = (tick: PriceTick) => void;

export interface MarketHistory {
  candles: Candle[];
  /** Reference price ~24h ago, for the change % readout. */
  dayOpen: number;
}

/**
 * Anything that can stream PriceTicks for the Paraclr markets.
 * `start` begins streaming and returns a stop function.
 */
export interface PriceSource {
  readonly kind: PriceTick["source"];
  start(onTick: TickHandler): () => void;
  /** Optional backfill so the chart isn't empty on first paint. */
  history?(bucketMs: number, count: number): Partial<Record<MarketSymbol, MarketHistory>>;
  /**
   * Optional async backfill (e.g. from on-chain logs). The feed provider
   * seeds it before calling `start`, bounded by a timeout.
   */
  backfill?(bucketMs: number, count: number): Promise<Partial<Record<MarketSymbol, MarketHistory>>>;
}
