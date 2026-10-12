import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

/** Fine moving grain with a faint halftone dot screen, over the whole frame. */
export const Grain: React.FC<{ opacity?: number }> = ({ opacity = 0.06 }) => {
  const f = useCurrentFrame();
  const seed = (f % 6) + 1;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill style={{ mixBlendMode: "overlay", opacity }}>
        <svg width="100%" height="100%">
          <filter id={`g${seed}`}>
            <feTurbulence type="fractalNoise" baseFrequency="0.95" numOctaves="2" seed={seed} stitchTiles="stitch" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <rect width="100%" height="100%" filter={`url(#g${seed})`} />
        </svg>
      </AbsoluteFill>
      <AbsoluteFill style={{ opacity: opacity * 0.5, mixBlendMode: "soft-light", backgroundImage: "radial-gradient(rgba(255,255,255,0.55) 0.6px, transparent 0.9px)", backgroundSize: "4px 4px" }} />
    </AbsoluteFill>
  );
};
