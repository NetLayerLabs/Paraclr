import React from "react";
import { AbsoluteFill, interpolate } from "remotion";
import { C, mono, sora } from "../theme";
import { useScene } from "../ui/use";
import { Words } from "../ui/Words";
import { Lanes } from "../ui/Lanes";
import { Lockup } from "../ui/Brand";
import { NetLayer } from "../ui/NetLayer";
import { clamp, expo, pop, ramp } from "../ui/motion";

/** Logo, line, URL, event. */
export const Close: React.FC = () => {
  const { f, rel, dur } = useScene("close");
  const tName = rel("Paraclr."), tCrash = rel("Crash"), tUrl = rel("paraclr");
  const logo = ramp(f, tName - 6, tName + 16);
  const url = Math.min(1, pop(f, tUrl - 4));
  return (
    <AbsoluteFill style={{ background: C.night, fontFamily: sora, color: C.dInk }}>
      <AbsoluteFill style={{ background: "radial-gradient(55% 45% at 50% 40%, rgba(110,84,255,0.20), transparent 75%)" }} />
      <Lanes y={850} gap={14} color="rgba(255,255,255,0.07)" tick="rgba(168,152,255,0.6)" stroke={1.5} hot={[{ lane: 5, at: 40, resolve: 120, color: C.accentInkDark }]} />
      <div style={{ position: "absolute", left: 0, right: 0, top: 200, display: "flex", justifyContent: "center", opacity: logo, transform: `scale(${0.94 + 0.06 * logo})`, filter: logo < 1 ? `blur(${(1 - logo) * 10}px)` : undefined }}>
        <Lockup height={180} tone="white" />
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 440, textAlign: "center", fontSize: 76, fontWeight: 800, letterSpacing: "-0.05em" }}>
        <Words text="Fair liquidations for Monad." at={rel("Fair")} every={6} accent={{ "Monad.": C.accentInkDark }} />
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 590, display: "flex", justifyContent: "center", gap: 20, alignItems: "center", opacity: ramp(f, tCrash - 4, tCrash + 10) }}>
        <div style={{ fontSize: 30, fontWeight: 600, color: C.dInk2, letterSpacing: "-0.02em" }}>Crash it yourself</div>
        <div style={{ padding: "16px 34px", borderRadius: 40, background: C.accent, color: "#fff", fontSize: 40, fontWeight: 700, letterSpacing: "-0.03em", transform: `scale(${0.9 + 0.1 * url})` }}>paraclr.xyz</div>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 740, display: "flex", justifyContent: "center", alignItems: "center", gap: 18, opacity: ramp(f, tUrl + 20, tUrl + 40) }}>
        <NetLayer height={30} labelColor={C.dInk3} />
        <div style={{ width: 1, height: 50, background: "rgba(255,255,255,0.18)", margin: "0 18px" }} />
        <div style={{ fontFamily: mono, fontSize: 17, color: C.dInk3, letterSpacing: "0.08em" }}>MONAD METROPOLIS · ONCHAIN FINANCE &amp; TRADING</div>
      </div>
    </AbsoluteFill>
  );
};
