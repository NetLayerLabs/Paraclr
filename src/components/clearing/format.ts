export function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

export function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`;
}

/** Compact mark price for the clearing screen's marks row. */
export function fmtMark(p: number): string {
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (p >= 10) return p.toFixed(2);
  return p.toFixed(4);
}

/**
 * Lane visualizer columns on wide layouts: cells are sized so the longest lane
 * spans the full track (lanes stay directly comparable); longer lanes wrap.
 * Phones ignore this and use fixed 7px cells.
 */
export function laneColumns(lengths: number[]): number {
  return Math.max(24, Math.min(100, Math.max(0, ...lengths)));
}
