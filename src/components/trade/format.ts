import type { MarketSymbol } from "@/lib/types";
import { MARKET_META } from "@/lib/prices/markets";

const nf = (min: number, max = min) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });

const cache = new Map<string, Intl.NumberFormat>();
function fmt(n: number, min: number, max = min): string {
  const key = `${min}:${max}`;
  let f = cache.get(key);
  if (!f) {
    f = nf(min, max);
    cache.set(key, f);
  }
  return f.format(n);
}

export function fmtPrice(symbol: MarketSymbol, p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "—";
  const d = MARKET_META[symbol].priceDecimals;
  return fmt(p, d);
}

export function fmtAusd(n: number, d = 2): string {
  return fmt(n, d);
}

/** Signed with a real minus sign, e.g. "+12.30" / "−4.05". */
export function fmtSigned(n: number, d = 2): string {
  const s = fmt(Math.abs(n), d);
  if (Math.abs(n) < 0.5 * 10 ** -d) return s;
  return (n > 0 ? "+" : "−") + s;
}

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
