import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { C, chromeText, display, mono } from "../theme";
import { Grain } from "../ui/Grain";

/** Thumbnail: the founder (a real 4K frame from the take) on the right, the pitch on black at the left. */
export const Thumb: React.FC<{ hi: boolean }> = () => (
  <AbsoluteFill style={{ background: C.black }}>
    <Img src={staticFile("footage/thumb-face.png")} style={{ position: "absolute", left: 520, top: 0, width: 1920, height: 1080, objectFit: "cover" }} />
    <AbsoluteFill style={{ background: "linear-gradient(90deg, #000 0%, #000 40%, rgba(0,0,0,0.75) 52%, rgba(0,0,0,0) 66%)" }} />
    <div style={{ position: "absolute", left: 110, top: 120, display: "flex", alignItems: "center", gap: 18 }}>
      <Img src={staticFile("brand/nl-mark.png")} style={{ height: 40 }} />
      <Img src={staticFile("brand/nl-word.png")} style={{ height: 30 }} />
    </div>
    <div style={{ position: "absolute", left: 104, top: 250, width: 1000 }}>
      <Img src={staticFile("brand/paraclr-header-white-192.png")} style={{ height: 96 }} />
      <div style={{ marginTop: 40, fontFamily: display, fontStretch: "115%", fontWeight: 800, fontSize: 96, letterSpacing: "-0.02em", lineHeight: 1.02, color: C.white, whiteSpace: "nowrap" }}>
        Fair liquidations<br /><span style={chromeText}>for Monad.</span>
      </div>
    </div>
    <div style={{ position: "absolute", left: 110, top: 800, fontFamily: display, fontStretch: "112%", fontWeight: 700, fontSize: 40, color: C.white }}>MrNetwork <span style={{ color: C.muted, fontWeight: 500 }}>· Founder, NetLayer Labs</span></div>
    <div style={{ position: "absolute", left: 110, top: 878, display: "flex", alignItems: "center", gap: 16, fontFamily: mono, fontSize: 22, letterSpacing: "0.2em", color: C.ink2 }}>
      <span style={{ color: C.white }}>■</span>TEAM PITCH <span style={{ color: C.dim }}>·</span> MONAD METROPOLIS
    </div>
    <Grain opacity={0.04} />
  </AbsoluteFill>
);
