import type { CSSProperties } from "react";
import s from "./Bend.module.css";

type Vars = CSSProperties & Record<`--${string}`, number>;

/**
 * Curved transition between a light and a dark section: the light block's
 * corner turns through a large quarter circle, and 8 thin lane stripes follow
 * that curve on the dark side (the brand mark's geometry at page scale).
 *
 *   into="dark"  - light section above ends with a rounded bottom corner.
 *   into="light" - light section below starts with a rounded top corner.
 *
 * Pure CSS (nested rounded borders share the corner's centre, so the lanes are
 * exactly concentric at every viewport width). Decorative: aria-hidden.
 */
export function Bend({ into, corner }: { into: "dark" | "light"; corner: "left" | "right" }) {
  return (
    <div
      className={`${s.bend} ${into === "dark" ? s.intoDark : s.intoLight} ${corner === "right" ? s.right : s.left}`}
      aria-hidden="true"
    >
      <div className={s.fill} />
      <div className={s.lanes}>
        {Array.from({ length: 8 }, (_, i) => (
          <i key={i} style={{ "--k": i + 1 } as Vars} />
        ))}
      </div>
    </div>
  );
}
