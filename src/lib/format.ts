// Shared number and unit formatting: the app, the Arena, the Clearing console and the PnL card use
// these so the same kind of value reads the same everywhere. Fixed en-US locale (deterministic on
// server and client). The rules:
//
//   units       a number, a space, the unit: "42 s", "120 ms", "5 min", "2 h" (as the README's
//               "~0.35 s"). Countdowns of a minute or more read as a clock: "3:00".
//   negatives   a real minus sign (U+2212), never a hyphen: "−4.05", "−20%". Signed values carry
//               "+" when positive; zero is unsigned.
//   grouping    en-US thousands separators: "1,234.50", "#70,008,340".
//   AUSD        always 2 decimals: "1,234.50".
//   MON         up to 4 decimals, trailing zeros trimmed ("0.3", "0.1234"); a non-zero amount
//               below 0.0001 keeps 2 significant digits ("0.0000012") so a tiny fee never reads 0.
//   bps as %    a measured or live value (discount now, a take, an average, a haircut): always 2
//               decimals, "0.45%", "1.00%" (fmtBps). A configured rate (step, max, pool minimum,
//               fixed penalty, trading fee): trailing zeros trimmed, "0.05%", "0.75%", "1%"
//               (fmtBpsParam).
//   leverage    "10x" (letter x, no space); "×" is kept for multiplication ("d × notional") and
//               ratios ("3.2× faster").

export const MINUS = "−";

const cache = new Map<string, Intl.NumberFormat>();
function nf(min: number, max: number): Intl.NumberFormat {
  const key = `${min}:${max}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });
    cache.set(key, f);
  }
  return f;
}

/** Grouped, between `min` and `max` decimals, with a real minus sign: 1234.5 → "1,234.5". */
export function fmtNumber(n: number, min = 0, max = min): string {
  const s = nf(min, max).format(Math.abs(n));
  return n < 0 && Number(s.replace(/,/g, "")) !== 0 ? MINUS + s : s;
}

/** AUSD: grouped, 2 decimals. */
export function fmtAusd(n: number, d = 2): string {
  return fmtNumber(n, d, d);
}

/** Signed with "+" / "−": "+12.30", "−4.05", "0.00". */
export function fmtSigned(n: number, d = 2): string {
  const s = nf(d, d).format(Math.abs(n));
  if (Math.abs(n) < 0.5 * 10 ** -d) return s;
  return (n > 0 ? "+" : MINUS) + s;
}

/** MON: up to 4 decimals, trimmed; a tiny non-zero amount keeps 2 significant digits. */
export function fmtMon(n: number): string {
  if (!Number.isFinite(n)) return "-";
  const a = Math.abs(n);
  if (a === 0) return "0";
  const s =
    a < 0.0001
      ? a.toLocaleString("en-US", { maximumSignificantDigits: 2, maximumFractionDigits: 20 })
      : nf(0, 4).format(a);
  return n < 0 ? MINUS + s : s;
}

/** A measured / live basis-point value as a percent, 2 decimals: 45 → "0.45%", 100 → "1.00%". */
export function fmtBps(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps)) return "-";
  return `${fmtNumber(bps / 100, 2, 2)}%`;
}

/** A configured basis-point rate as a percent, trailing zeros trimmed: 5 → "0.05%", 100 → "1%". */
export function fmtBpsParam(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps)) return "-";
  return `${fmtNumber(bps / 100, 0, 2)}%`;
}

/** Elapsed or remaining seconds: "42 s", "2 min 05 s", "1 h 20 min". */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h} h ${String(m).padStart(2, "0")} min`;
}

/** A countdown: "42 s" under a minute, else a clock "3:00". */
export function fmtCountdown(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, "0")}` : `${s} s`;
}

/** Milliseconds: "120 ms" under a second, "1.25 s" under 10 s, whole seconds above: "25 s". */
export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return ms < 10_000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms / 1000)} s`;
}

/** "just now", "42 s ago", "4 min ago", "2 h ago", "3 d ago". */
export function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
