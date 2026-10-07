import type { XrayDesign } from "./benchResults.server";

/** Gap around each edge cell, in matrix units (one unit = one transaction). */
const CELL_INSET = 0.08;

export interface Band {
  lane: number | null;
  start: number;
  count: number;
}

/** Consecutive runs of transactions from the same lane (txs are sorted by lane). */
export function bands(design: XrayDesign): Band[] {
  const out: Band[] = [];
  design.txs.forEach((t, i) => {
    const last = out.at(-1);
    if (last && last.lane === t.lane) last.count += 1;
    else out.push({ lane: t.lane, start: i, count: 1 });
  });
  return out;
}

export interface MatrixClasses {
  svg?: string;
  bg: string;
  band: string;
  sep: string;
  diag: string;
  same: string;
  cross: string;
}

/**
 * Dependency matrix drawn from a committed X-ray: row = earlier tx that wrote
 * a slot, column = later tx in the same block that read or wrote it. Shaded
 * squares on the diagonal are one lane's transactions.
 */
export function MatrixSvg({ design, label, classes }: { design: XrayDesign; label: string; classes: MatrixClasses }) {
  const n = design.txs.length;
  const bs = bands(design);
  return (
    <svg className={classes.svg} viewBox={`0 0 ${n} ${n}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <rect x="0" y="0" width={n} height={n} className={classes.bg} />
      {bs.map((band) => (
        <rect
          key={`b${band.start}`}
          x={band.start}
          y={band.start}
          width={band.count}
          height={band.count}
          className={classes.band}
        />
      ))}
      {bs.slice(1).map((band) => (
        <g key={`l${band.start}`} className={classes.sep}>
          <line x1={band.start} y1="0" x2={band.start} y2={n} />
          <line x1="0" y1={band.start} x2={n} y2={band.start} />
        </g>
      ))}
      <line x1="0" y1="0" x2={n} y2={n} className={classes.diag} />
      {design.edges.map((e, i) => (
        <rect
          key={i}
          x={e.to + CELL_INSET}
          y={e.from + CELL_INSET}
          width={1 - 2 * CELL_INSET}
          height={1 - 2 * CELL_INSET}
          rx={0.14}
          className={e.crossLane ? classes.cross : classes.same}
        />
      ))}
    </svg>
  );
}
