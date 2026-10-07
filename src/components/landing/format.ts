// Number formatting for the landing page (deterministic: fixed en-US locale, UTC).

const INT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export const fmtInt = (n: number): string => INT.format(n);

/** 27274852 → "27.27M", 831083 → "831.1K". */
export function fmtCompact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return fmtInt(n);
}

export function fmtPct(part: number, whole: number): string {
  if (!whole) return "–";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

/** "2026-10-04T15:15:06.651Z" → "Oct 4, 2026 · 15:15 UTC" */
export function fmtRunDate(iso: string | null): string {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "–";
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return `${date} · ${time} UTC`;
}

/** 0x2fb403…9054 */
export function shortHash(h: string, head = 6, tail = 4): string {
  if (!h || h.length <= head + tail + 2) return h;
  return `${h.slice(0, head + 2)}…${h.slice(-tail)}`;
}

export function fmtBlocks(blocks: number[]): string {
  if (blocks.length === 0) return "–";
  if (blocks.length === 1) return `#${blocks[0]}`;
  const sorted = [...blocks].sort((a, b) => a - b);
  return `#${sorted[0]}–#${sorted[sorted.length - 1]} (${sorted.length} blocks)`;
}

/** 1234567.891 → "1,234,567.89"; ≥ 1e6 → "1.23M". AUSD amounts (already converted from 6dp). */
export function fmtAusd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

/** 150 → "150 bps (1.50%)" */
export function fmtBps(bps: number): string {
  return `${fmtInt(bps)} bps`;
}

/** 86400 → "24 h", 90 → "90 s", 300 → "5 min", 172800 → "48 h". */
export function fmtDuration(seconds: number): string {
  if (seconds < 120) return `${fmtNum(seconds)} s`;
  if (seconds < 7200) return `${fmtNum(seconds / 60)} min`;
  return `${fmtNum(seconds / 3600)} h`;
}

/** Up to 2 decimals, no trailing zeros: 50 → "50", 0.25 → "0.25", 1234.5 → "1,234.5". */
export function fmtNum(n: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);
}

/** Up to 6 significant decimals for small native amounts: 0.0125 → "0.0125". */
export function fmtSmall(n: number): string {
  return new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 }).format(n);
}
