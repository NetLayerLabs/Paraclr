import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { C, mono } from "../theme";
import { clamp } from "./motion";

/**
 * Corner furniture: the flat NetLayer mark top left and the event top right.
 * No scene names or timecode (the founder's rule for both films).
 */
export const Chrome: React.FC<{ showFrom: number; hideAfter: number }> = ({ showFrom, hideAfter }) => {
  const f = useCurrentFrame();
  const op = interpolate(f, [showFrom, showFrom + 18, hideAfter, hideAfter + 14], [0, 1, 1, 0], clamp);
  const lab: React.CSSProperties = { fontFamily: mono, fontSize: 14, letterSpacing: "0.16em", textTransform: "uppercase", color: C.muted };
  return (
    <AbsoluteFill style={{ pointerEvents: "none", opacity: op }}>
      <div style={{ position: "absolute", left: 52, top: 40, display: "flex", alignItems: "center", gap: 12 }}>
        <Img src={staticFile("brand/nl-mark.png")} style={{ height: 20, opacity: 0.92 }} />
        <Img src={staticFile("brand/nl-word.png")} style={{ height: 14, opacity: 0.92 }} />
      </div>
      <div style={{ ...lab, position: "absolute", right: 52, top: 44 }}>Monad Metropolis <span style={{ color: C.dim }}>·</span> team pitch</div>
    </AbsoluteFill>
  );
};
