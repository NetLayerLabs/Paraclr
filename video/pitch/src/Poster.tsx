import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { C, chromeText, display, mono } from "./theme";
import { Grain } from "./ui/Grain";

/** Thumbnail: the chrome lockup on its stage, the pitch line and the event. */
export const Poster: React.FC = () => (
  <AbsoluteFill style={{ background: C.black }}>
    <div style={{ position: "absolute", left: -40, top: 20, width: 2000, height: 2000 * 724 / 2172,
      WebkitMaskImage: "linear-gradient(180deg, transparent 0%, #000 14%, #000 76%, transparent 100%)", maskImage: "linear-gradient(180deg, transparent 0%, #000 14%, #000 76%, transparent 100%)" }}>
      <Img src={staticFile("brand/header-logo.png")} style={{ width: "100%" }} />
    </div>
    <div style={{ position: "absolute", left: 120, top: 780, fontFamily: display, fontStretch: "118%", fontWeight: 800, fontSize: 92, letterSpacing: "-0.02em", color: C.white }}>
      Team pitch. <span style={chromeText}>Builders of Paraclr.</span>
    </div>
    <div style={{ position: "absolute", left: 124, top: 920, display: "flex", alignItems: "center", gap: 18, fontFamily: mono, fontSize: 24, letterSpacing: "0.2em", color: C.ink2 }}>
      <span style={{ color: C.white }}>■</span>MONAD METROPOLIS <span style={{ color: C.dim }}>·</span> NETLAYERLABS.COM
    </div>
    <div style={{ position: "absolute", right: 120, top: 70, fontFamily: mono, fontSize: 20, letterSpacing: "0.2em", color: C.muted }}>
      <span style={{ color: C.dim, marginRight: 12 }}>/</span>INDEPENDENT STUDIO · ITALY
    </div>
    <Grain opacity={0.06} />
  </AbsoluteFill>
);
