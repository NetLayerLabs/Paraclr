// Formatting for the arena page. AUSD amounts arrive as raw 6-decimal integer strings. The rules
// (units, minus sign, bps precision) are the app's: src/lib/format.ts.

import { fmtAusd as ausdText, fmtSigned as signedText, fmtMs } from "@/lib/format";

export function ausd(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    return Number(BigInt(raw)) / 1e6;
  } catch {
    return null;
  }
}

export function fmtAusd(n: number | null, digits = 2): string {
  if (n === null || !Number.isFinite(n)) return "-";
  return ausdText(n, digits);
}

export function shortAddr(a: string, head = 6, tail = 4): string {
  return a.length > head + tail + 2 ? `${a.slice(0, head)}…${a.slice(-tail)}` : a;
}

export function fmtSeconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "-";
  return fmtMs(ms);
}

/** Signed AUSD: "+12.30" / "−4.10" / "0.00". */
export function fmtSigned(n: number | null, digits = 2): string {
  if (n === null || !Number.isFinite(n)) return "-";
  return signedText(n, digits);
}
