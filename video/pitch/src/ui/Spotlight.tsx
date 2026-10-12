import React from "react";
import { AbsoluteFill } from "remotion";

/**
 * A soft stage light: a cone from above at `x` (0..1 of the width), tilted by `angle` degrees,
 * plus the pool it leaves on the floor. Screen-blended so it only ever lifts the black.
 */
export const Spotlight: React.FC<{ x: number; angle?: number; intensity?: number; width?: number; poolY?: number }> = ({ x, angle = 0, intensity = 1, width = 760, poolY = 0.86 }) => (
  <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: "screen", opacity: intensity }}>
    <div style={{ position: "absolute", left: `${x * 100}%`, top: -260, width, height: 1500, marginLeft: -width / 2, transformOrigin: "50% 0%", transform: `rotate(${angle}deg)`, filter: "blur(40px)" }}>
      <div style={{
        position: "absolute", inset: 0,
        background: "linear-gradient(180deg, rgba(255,255,255,0.30) 0%, rgba(255,255,255,0.10) 38%, rgba(255,255,255,0.02) 75%, transparent 100%)",
        clipPath: "polygon(44% 0, 56% 0, 100% 100%, 0 100%)",
      }} />
    </div>
    <div style={{
      position: "absolute", left: `${x * 100}%`, top: `${poolY * 100}%`, width: width * 1.5, height: 220, marginLeft: (-width * 1.5) / 2, marginTop: -110,
      transform: `translateX(${-Math.sin((angle * Math.PI) / 180) * (poolY * 1080 + 260)}px)`,
      background: "radial-gradient(50% 50% at 50% 50%, rgba(255,255,255,0.13), transparent 70%)", filter: "blur(10px)",
    }} />
  </AbsoluteFill>
);
