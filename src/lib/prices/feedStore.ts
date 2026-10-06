"use client";

// Per-market feed telemetry that the global store doesn't carry: candle
// history, tick direction, 24h reference and delivery latency. Written only by
// PriceFeedProvider; read by the trading UI.

import { useSyncExternalStore } from "react";
import { MARKETS, type Candle, type MarketSymbol, type PriceTick } from "../types";
import { applyTick } from "./candles";
import { CANDLE_MS, MAX_CANDLES } from "./markets";
import type { MarketHistory } from "./source";

export interface MarketFeed {
  candles: Candle[];
  last: number | null;
  dir: 1 | -1 | 0;
  dayOpen: number | null;
  /** Observation timestamp of the last tick (ms). */
  observedAt: number;
  /** Delivery latency of the last tick: arrival − observation (ms). */
  latencyMs: number;
  source: PriceTick["source"] | null;
  ticks: number;
  /** Block of the last tick (oracle source only). */
  block: number | null;
}

const empty = (): MarketFeed => ({
  candles: [],
  last: null,
  dir: 0,
  dayOpen: null,
  observedAt: 0,
  latencyMs: 0,
  source: null,
  ticks: 0,
  block: null,
});

const initial = Object.fromEntries(MARKETS.map((s) => [s, empty()])) as Record<
  MarketSymbol,
  MarketFeed
>;

let feeds = initial;
const listeners = new Set<() => void>();

function update(symbol: MarketSymbol, next: MarketFeed) {
  feeds = { ...feeds, [symbol]: next };
  listeners.forEach((l) => l());
}

export function subscribeFeed(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getFeed(symbol: MarketSymbol): MarketFeed {
  return feeds[symbol];
}

export function useMarketFeed(symbol: MarketSymbol): MarketFeed {
  return useSyncExternalStore(
    subscribeFeed,
    () => feeds[symbol],
    () => initial[symbol],
  );
}

/** Drop all candles/telemetry (used when switching price sources). */
export function resetFeeds() {
  feeds = initial;
  listeners.forEach((l) => l());
}

export function seedHistory(history: Partial<Record<MarketSymbol, MarketHistory>>) {
  for (const s of MARKETS) {
    const h = history[s];
    if (!h) continue;
    const prev = feeds[s];
    update(s, {
      ...prev,
      candles: h.candles,
      dayOpen: h.dayOpen,
      last: prev.last ?? h.candles[h.candles.length - 1]?.close ?? null,
    });
  }
}

export function ingestTick(tick: PriceTick, arrivedAt = Date.now()) {
  const prev = feeds[tick.symbol];
  const dir: MarketFeed["dir"] =
    prev.last == null || tick.price === prev.last ? prev.dir : tick.price > prev.last ? 1 : -1;
  update(tick.symbol, {
    candles: applyTick(prev.candles, tick.price, tick.timestamp, CANDLE_MS, MAX_CANDLES),
    last: tick.price,
    dir,
    dayOpen: prev.dayOpen ?? tick.price,
    observedAt: tick.timestamp,
    latencyMs: Math.max(0, arrivedAt - tick.timestamp),
    source: tick.source,
    ticks: prev.ticks + 1,
    block: tick.block ?? prev.block,
  });
}
