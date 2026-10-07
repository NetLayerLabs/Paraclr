// The Paraclr mark: 8 parallel lanes bending around one solid corner, in a
// rounded tile. Same geometry as the section bends (brand/Bend.tsx): lanes run
// in from the left, take a quarter turn and leave through the top.
// Usage rules live in docs/DESIGN.md ("Logo").
import { useId } from "react";

/** Lane radii on the 32-unit grid, all centred on (LANE_C, LANE_C). Exported for icon/OG generators. */
export const LANE_C = 9;
export const LANE_RADII = [4.2, 6.65, 9.1, 11.55, 14, 16.45, 18.9, 21.35] as const;
export const LANE_STROKE = 1.3;
export const TILE_RX = 8.5;

/** Path for one lane: in from the left edge, quarter turn, out through the top edge. */
export function lanePath(r: number): string {
  const c = LANE_C;
  return `M-1 ${c + r} H${c} A${r} ${r} 0 0 0 ${c + r} ${c} V-1`;
}

type Tone = "brand" | "ink" | "paper";

const TONES: Record<Tone, { tile: string; lane: string }> = {
  brand: { tile: "#6E54FF", lane: "#FFFFFF" }, // default, on light and on dark
  ink: { tile: "#0B0A12", lane: "#FFFFFF" }, // one-colour, on light
  paper: { tile: "#FFFFFF", lane: "#0B0A12" }, // one-colour, on dark or on purple
};

export function Mark({ className, tone = "brand", title }: { className?: string; tone?: Tone; title?: string }) {
  const id = useId();
  const clip = `pc-mark-${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const t = TONES[tone];
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <clipPath id={clip}>
          <rect width="32" height="32" rx={TILE_RX} />
        </clipPath>
      </defs>
      <rect width="32" height="32" rx={TILE_RX} fill={t.tile} />
      <g clipPath={`url(#${clip})`} stroke={t.lane} strokeWidth={LANE_STROKE}>
        {LANE_RADII.map((r) => (
          <path key={r} d={lanePath(r)} />
        ))}
      </g>
    </svg>
  );
}

/** Mark + "Paraclr" set in the display face. Size it with font-size on `className`; the mark follows (1.25em). */
export function Wordmark({
  className,
  markClassName,
  textClassName,
}: {
  className?: string;
  markClassName?: string;
  textClassName?: string;
}) {
  return (
    <span className={className}>
      <Mark className={markClassName} />
      <span className={textClassName}>Paraclr</span>
    </span>
  );
}
