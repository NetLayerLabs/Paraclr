import type { MarketSymbol } from "@/lib/types";
import { MARKET_META } from "@/lib/prices/markets";
import { fmtNumber, fmtSigned } from "@/lib/format";

// The rules (grouping, minus sign, units) are the app-wide ones in src/lib/format.ts.

const fmt = (n: number, min: number, max = min): string => fmtNumber(n, min, max);

export function fmtPrice(symbol: MarketSymbol, p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "-";
  const d = MARKET_META[symbol].priceDecimals;
  return fmt(p, d);
}

export function fmtAusd(n: number, d = 2): string {
  return fmt(n, d);
}

/** Signed with a real minus sign, e.g. "+12.30" / "−4.05" (src/lib/format.ts). */
export { fmtSigned };

export function fmtPct(n: number, d = 2): string {
  return fmtSigned(n, d) + "%";
}

export function fmtSize(symbol: MarketSymbol, n: number): string {
  const d = MARKET_META[symbol].sizeDecimals;
  return fmt(n, d);
}

export function fmtCompact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return fmt(n / 1e6, 2) + "M";
  if (a >= 1e4) return fmt(n / 1e3, 1) + "K";
  return fmt(n, 2);
}

export function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function baseOf(symbol: MarketSymbol): string {
  return MARKET_META[symbol].base;
}
