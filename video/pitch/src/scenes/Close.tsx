import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile } from "remotion";
import { C, display, mono } from "../theme";
import { ramp, soft } from "../ui/motion";
import { Words } from "../ui/Words";
import { useScene } from "../ui/use";
import { scene } from "../timing";

/** The NetLayer lockup returns under its stage light, with the line, the site and the event. */
export const Close: React.FC = () => {
  const { f, rel, dur } = useScene("close");
  const s = scene("close");
  const times = s.lines[0].words.slice(0, 4).map((w) => w.start - s.from);
  const nl = rel("NetLayer");
  const lock = ramp(f, nl - 10, nl + 30, soft);
  const push = interpolate(f, [nl - 10, dur], [1.06, 1.0]);
  const foot = ramp(f, nl + 18, nl + 36);
  const line = ramp(f, 0, 1) * interpolate(f, [nl - 6, nl + 10], [1, 0.5], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: C.black }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: 120, textAlign: "center", fontFamily: display, fontStretch: "115%", fontWeight: 700, fontSize: 60, letterSpacing: "-0.01em", color: C.white, opacity: line }}>
        <Words text="Deterministic safety. Real numbers." at={0} times={times} chrome={["numbers."]} />
      </div>
      <div style={{ position: "absolute", left: (1920 - 1560) / 2, top: 236, width: 1560, height: 1560 * 724 / 2172, opacity: lock, filter: `brightness(${0.3 + 0.7 * lock}) blur(${(1 - lock) * 8}px)`, transform: `scale(${push})`, mixBlendMode: "screen",
        WebkitMaskImage: "radial-gradient(75% 90% at 50% 45%, #000 60%, transparent 100%)", maskImage: "radial-gradient(75% 90% at 50% 45%, #000 60%, transparent 100%)" }}>
        <Img src={staticFile("brand/header-logo.png")} style={{ width: "100%" }} />
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 812, display: "flex", flexDirection: "column", alignItems: "center", gap: 18, opacity: foot, transform: `translateY(${(1 - foot) * 10}px)` }}>
        <div style={{ fontFamily: mono, fontSize: 30, letterSpacing: "0.08em", color: C.white }}>netlayerlabs.com</div>
        <div style={{ fontFamily: mono, fontSize: 16, letterSpacing: "0.22em", color: C.muted }}>
          <span style={{ color: C.white, marginRight: 12 }}>■</span>MONAD METROPOLIS <span style={{ color: C.dim }}>·</span> BUILDERS OF PARACLR
        </div>
      </div>
    </AbsoluteFill>
  );
};
