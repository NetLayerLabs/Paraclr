// Formatting for the arena page. AUSD amounts arrive as raw 6-decimal integer strings.

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
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtBps(bps: number | null): string {
  if (bps === null || !Number.isFinite(bps)) return "-";
  return `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}

export function shortAddr(a: string, head = 6, tail = 4): string {
  return a.length > head + tail + 2 ? `${a.slice(0, head)}…${a.slice(-tail)}` : a;
}

export function fmtCountdown(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}:${String(r).padStart(2, "0")}` : `${r}s`;
}

export function fmtSeconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "-";
  return ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`;
}

/** "just now", "42 s ago", "4 min ago", "2 h ago". */
export function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/** Signed AUSD: "+12.30" / "-4.10" / "0.00". */
export function fmtSigned(n: number | null, digits = 2): string {
  if (n === null || !Number.isFinite(n)) return "-";
  if (Math.abs(n) < 0.5 * 10 ** -digits) return (0).toFixed(digits);
  return `${n > 0 ? "+" : "-"}${fmtAusd(Math.abs(n), digits)}`;
}
