import type { MarketSymbol } from "../types";

/** Static per-market metadata used by the feed and the trading UI. */
export interface MarketMeta {
  symbol: MarketSymbol;
  base: string;
  name: string;
  /** Plausible spot price (AUSD ≈ USD) used to seed the simulator. */
  seedPrice: number;
  /** Decimals shown for prices. */
  priceDecimals: number;
  /** Decimals shown for base-asset size. */
  sizeDecimals: number;
  /** Per-tick (250ms) log-return stdev of the simulator — demo-amplified. */
  tickVol: number;
}

export const MARKET_META: Record<MarketSymbol, MarketMeta> = {
  "MON/AUSD": {
    symbol: "MON/AUSD",
    base: "MON",
    name: "Monad",
    seedPrice: 0.04,
    priceDecimals: 5,
    sizeDecimals: 0,
    tickVol: 0.0009,
  },
  "SOL/AUSD": {
    symbol: "SOL/AUSD",
    base: "SOL",
    name: "Solana",
    seedPrice: 180,
    priceDecimals: 2,
    sizeDecimals: 3,
    tickVol: 0.0005,
  },
  "BTC/AUSD": {
    symbol: "BTC/AUSD",
    base: "BTC",
    name: "Bitcoin",
    seedPrice: 110_000,
    priceDecimals: 1,
    sizeDecimals: 5,
    tickVol: 0.00032,
  },
};

/** Candle bucket width used by the live chart. */
export const CANDLE_MS = 5_000;
/** Number of candles kept per market (5 minutes of 5s candles). */
export const MAX_CANDLES = 60;
