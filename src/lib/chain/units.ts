// Unit conversions for the clearinghouse (contracts/README.md "Units"):
//   AUSD amounts 6 decimals · prices 1e18 · position size 1e18.

import { formatUnits, parseUnits } from "viem";

export const AUSD_DP = 6;
export const PRICE_DP = 18;
export const SIZE_DP = 18;

export function ausdToNumber(v: bigint): number {
  return Number(formatUnits(v, AUSD_DP));
}

export function priceToNumber(v: bigint): number {
  return Number(formatUnits(v, PRICE_DP));
}

export function sizeToNumber(v: bigint): number {
  return Number(formatUnits(v, SIZE_DP));
}

export function nativeToNumber(v: bigint, decimals = 18): number {
  return Number(formatUnits(v, decimals));
}

/** Human AUSD → 6dp base units (truncates beyond 6 decimals). */
export function ausdToUnits(n: number): bigint {
  if (!Number.isFinite(n) || n <= 0) return BigInt(0);
  return parseUnits(n.toFixed(AUSD_DP), AUSD_DP);
}

/**
 * Keeper RunReport amounts are "AUSD 6dp, decimal string": an integer string
 * is base units; tolerate already-human decimals too.
 */
export function parseAusdString(s: string | number | null | undefined): number {
  if (s == null) return 0;
  if (typeof s === "number") return s;
  const t = s.trim();
  if (/^-?\d+$/.test(t)) return ausdToNumber(BigInt(t));
  const f = Number.parseFloat(t);
  return Number.isFinite(f) ? f : 0;
}

export function parseBigIntString(s: string | number | null | undefined): bigint {
  if (s == null) return BigInt(0);
  if (typeof s === "number") return Number.isFinite(s) ? BigInt(Math.trunc(s)) : BigInt(0);
  try {
    return BigInt(s.trim());
  } catch {
    return BigInt(0);
  }
}

export function fmtGas(g: bigint | number): string {
  const n = typeof g === "bigint" ? Number(g) : g;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export function shortHash(h: string, lead = 6, tail = 4): string {
  return h.length > lead + tail + 1 ? `${h.slice(0, lead)}…${h.slice(-tail)}` : h;
}
