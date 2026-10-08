// Small inline glyphs in the brand's own language: two faint lane quarter-turns (the logo's
// motif) behind a bold mark. They replace typographic ✓ / ! / ▲ / ▼ in the app so every status
// mark looks like Paraclr, not like a font's. Sized in em so they follow the surrounding text;
// colour is currentColor (the lanes take the accent at low opacity).

import type { CSSProperties } from "react";

interface GlyphProps {
  /** Height in px; width matches. Default 1em of the surrounding text. */
  size?: number | string;
  className?: string;
  style?: CSSProperties;
  /** Accessible name; omitted = decorative (the text next to it carries the meaning). */
  label?: string;
}

const LANES = (
  <g fill="none" stroke="var(--accent, #6E54FF)" strokeWidth={1.1} opacity={0.45}>
    <path d="M-1 10.5 H4.5 A6 6 0 0 0 10.5 4.5 V-1" />
    <path d="M-1 13.5 H4.5 A9 9 0 0 0 13.5 4.5 V-1" />
  </g>
);

function frame({ size = "1em", className, style, label }: GlyphProps, children: React.ReactNode) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={className}
      style={{ display: "inline-block", verticalAlign: "-0.15em", flex: "none", ...style }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {LANES}
      {children}
    </svg>
  );
}

/** Done / confirmed / matches. */
export function LaneCheck(props: GlyphProps) {
  return frame(
    props,
    <path d="M3.5 8.5 L6.8 11.8 L13 5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />,
  );
}

/** Attention / failed / doesn't match. */
export function LaneAlert(props: GlyphProps) {
  return frame(
    props,
    <>
      <path d="M8 3.5 V9" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" />
      <circle cx={8} cy={12.6} r={1.35} fill="currentColor" />
    </>,
  );
}

/** Up / above (price moved above the tag). */
export function LaneUp(props: GlyphProps) {
  return frame(props, <path d="M3.5 10.5 L8 5.5 L12.5 10.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />);
}

/** Down / below. */
export function LaneDown(props: GlyphProps) {
  return frame(props, <path d="M3.5 5.5 L8 10.5 L12.5 5.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />);
}

/** The bare caret path for use inside another SVG (the chart's price tags): 16-unit box, no lanes. */
export const CARET_PATH = { up: "M3.5 10.5 L8 5.5 L12.5 10.5", down: "M3.5 5.5 L8 10.5 L12.5 5.5" } as const;
