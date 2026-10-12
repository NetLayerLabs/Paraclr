import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { C, display, mono } from "../theme";
import { clamp, ramp, soft } from "../ui/motion";
import { Words } from "../ui/Words";

/** End card on black: the NetLayer lockup under its light, the line, both sites and the event. */
export const EndCard: React.FC = () => {
  const f = useCurrentFrame();
  const fade = ramp(f, 0, 12);
  const lock = ramp(f, 4, 34, soft);
  const foot = ramp(f, 26, 44);
  const push = interpolate(f, [0, 150], [1.05, 1.0], clamp);
  return (
    <AbsoluteFill style={{ background: C.black, opacity: fade }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: 96, textAlign: "center", fontFamily: display, fontStretch: "115%", fontWeight: 700, fontSize: 58, letterSpacing: "-0.01em", color: C.white }}>
        <Words text="Deterministic safety. Real numbers." at={8} every={4} chrome={["numbers."]} />
      </div>
      <div style={{ position: "absolute", left: (1920 - 1440) / 2, top: 196, width: 1440, height: 1440 * 724 / 2172, opacity: lock, transform: `scale(${push})`, mixBlendMode: "screen",
        filter: `brightness(${0.3 + 0.7 * lock}) blur(${(1 - lock) * 8}px)`,
        WebkitMaskImage: "radial-gradient(75% 90% at 50% 45%, #000 60%, transparent 100%)", maskImage: "radial-gradient(75% 90% at 50% 45%, #000 60%, transparent 100%)" }}>
        <Img src={staticFile("brand/header-logo.png")} style={{ width: "100%" }} />
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 726, display: "flex", justifyContent: "center", alignItems: "center", gap: 46, opacity: foot, transform: `translateY(${(1 - foot) * 10}px)` }}>
        <span style={{ fontFamily: mono, fontSize: 30, letterSpacing: "0.06em", color: C.white }}>netlayerlabs.com</span>
        <span style={{ width: 1, height: 48, background: "rgba(255,255,255,0.25)" }} />
        <span style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <Img src={staticFile("brand/paraclr-header-white-192.png")} style={{ height: 46 }} />
          <span style={{ fontFamily: mono, fontSize: 30, letterSpacing: "0.06em", color: C.white }}>paraclr.xyz</span>
        </span>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 830, textAlign: "center", fontFamily: mono, fontSize: 17, letterSpacing: "0.22em", color: C.muted, opacity: foot }}>
        <span style={{ color: C.white, marginRight: 12 }}>■</span>MONAD METROPOLIS <span style={{ color: C.dim }}>·</span> LIVE ON MONAD TESTNET
      </div>
    </AbsoluteFill>
  );
};
