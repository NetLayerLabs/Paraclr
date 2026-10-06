import type { Candle } from "../types";

export function bucketStart(ts: number, bucketMs: number): number {
  return Math.floor(ts / bucketMs) * bucketMs;
}

/**
 * Fold one price into a candle series. Returns a NEW array (safe for
 * useSyncExternalStore snapshots). Gaps are filled with flat candles at the
 * previous close so the x-axis stays evenly spaced; the series is trimmed to
 * `max` candles.
 */
export function applyTick(
  candles: Candle[],
  price: number,
  ts: number,
  bucketMs: number,
  max: number,
): Candle[] {
  const t = bucketStart(ts, bucketMs);
  const last = candles[candles.length - 1];

  if (!last) return [{ time: t, open: price, high: price, low: price, close: price }];

  if (t === last.time) {
    const next = candles.slice();
    next[next.length - 1] = {
      ...last,
      high: Math.max(last.high, price),
      low: Math.min(last.low, price),
      close: price,
    };
    return next;
  }

  // Out-of-order tick for an older bucket — ignore rather than rewrite history.
  if (t < last.time) return candles;

  const next = candles.slice();
  const gaps = Math.min(max, Math.round((t - last.time) / bucketMs) - 1);
  for (let i = 1; i <= gaps; i++) {
    const c = last.close;
    next.push({ time: last.time + i * bucketMs, open: c, high: c, low: c, close: c });
  }
  const open = last.close;
  next.push({
    time: t,
    open,
    high: Math.max(open, price),
    low: Math.min(open, price),
    close: price,
  });
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Aggregate a raw (ts, price) path into candles. */
export function aggregate(
  path: { ts: number; price: number }[],
  bucketMs: number,
  max: number,
): Candle[] {
  let out: Candle[] = [];
  for (const p of path) out = applyTick(out, p.price, p.ts, bucketMs, max);
  return out;
}
