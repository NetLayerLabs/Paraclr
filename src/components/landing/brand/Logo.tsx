// The Paraclr mark: 8 parallel lanes bending around one solid corner, in a
// rounded tile. Same geometry as the section bends (brand/Bend.tsx): lanes run
// in from the left, take a quarter turn and leave through the top.
// Usage rules live in docs/DESIGN.md ("Logo").
import { ParaclrLogo } from "@/components/brand/ParaclrLogo";

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


/**
 * The Paraclr mark: the brand artwork (eight lanes into the gate, six out), public/brand/
 * paraclr-mark-128.png. The lane geometry above is a separate motif (section bends, glyphs).
 * `tone` is kept for call sites; the artwork has one colourway.
 */
export function Mark({ className, title }: { className?: string; tone?: Tone; title?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static brand artwork
    <img className={className} src="/brand/paraclr-mark-128.png" alt={title ?? ""} aria-hidden={title ? undefined : true} style={{ objectFit: "contain" }} />
  );
}

/** The full lockup (mark + wordmark), following the theme. Size it with height on `className`. */
export function Wordmark({ className }: { className?: string; markClassName?: string; textClassName?: string }) {
  return <ParaclrLogo tone="auto" height={26} className={className} />;
}
