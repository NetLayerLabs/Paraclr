import React from "react";
import { AbsoluteFill } from "remotion";
import { C, mono, serif, sora } from "./theme";
import { Lockup, Mark } from "./ui/Brand";
import { NetLayer } from "./ui/NetLayer";
import { Lanes } from "./ui/Lanes";
import { Grain } from "./ui/Grain";

/** Thumbnail: the lockup, the landing's headline and the thesis, over the lanes. */
export const Poster: React.FC<{ label?: string }> = ({ label = "MONAD METROPOLIS · LIVE ON MONAD TESTNET · TEST FUNDS" }) => (
  <AbsoluteFill style={{ background: C.night, fontFamily: sora, color: C.dInk }}>
    <AbsoluteFill style={{ background: "radial-gradient(55% 50% at 30% 35%, rgba(110,84,255,0.28), transparent 75%)" }} />
    <Lanes y={830} gap={18} color="rgba(255,255,255,0.10)" tick="rgba(168,152,255,0.8)" stroke={2} hot={[{ lane: 3, at: -60, resolve: 999, color: "#FFB547" }]} />
    <div style={{ position: "absolute", right: 90, top: 150, opacity: 0.95, filter: "drop-shadow(0 0 60px rgba(110,84,255,0.45))" }}><Mark height={560} /></div>
    <div style={{ position: "absolute", left: 130, top: 120 }}><Lockup height={120} tone="white" /></div>
    <NetLayer height={22} labelColor={C.dInk3} style={{ position: "absolute", right: 60, bottom: 46 }} />
    <div style={{ position: "absolute", left: 130, top: 330, fontSize: 150, fontWeight: 800, letterSpacing: "-0.06em", lineHeight: 0.98 }}>
      Liquidations,<br /><span style={{ color: C.accentInkDark }}>auctioned.</span>
    </div>
    <div style={{ position: "absolute", left: 134, top: 680, fontSize: 44, fontWeight: 600, letterSpacing: "-0.03em", color: C.dInk2 }}>
      The race, replaced by a <span style={{ fontFamily: serif, fontStyle: "italic", fontWeight: 400, color: "#fff", fontSize: 54 }}>clock.</span>
    </div>
    <div style={{ position: "absolute", left: 134, bottom: 50, fontFamily: mono, fontSize: 20, letterSpacing: "0.1em", color: C.dInk3 }}>
      {label}
    </div>
    <Grain opacity={0.07} />
  </AbsoluteFill>
);
