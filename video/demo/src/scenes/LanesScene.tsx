import React from "react";
import { AbsoluteFill, interpolate } from "remotion";
import { C, mono, sora } from "../theme";
import { useScene } from "../ui/use";
import { Words } from "../ui/Words";
import { Lanes } from "../ui/Lanes";
import { Label } from "../ui/Label";
import { clamp, ramp } from "../ui/motion";

/** The motif, full frame: one lane lights up and resolves while the other seven keep running. */
export const LanesScene: React.FC = () => {
  const { f, rel } = useScene("lanes");
  const tCrash = rel("crash"), tAnother = rel("another."), tStore = rel("storage."), tPar = rel("parallel");
  const LX = 150, LY = 420, GAP = 54, W = 1620;
  const hot = [{ lane: 3, at: tCrash - 2, resolve: tAnother + 34, color: C.warnDark }];
  const speed = interpolate(f, [tPar - 6, tPar + 20], [1, 2.4], clamp);
  const store = ramp(f, tStore - 6, tStore + 10);
  const others = ramp(f, tAnother - 6, tAnother + 10);
  return (
    <AbsoluteFill style={{ background: C.accent, fontFamily: sora, color: "#fff" }}>
      <AbsoluteFill style={{ background: "radial-gradient(70% 60% at 20% 10%, rgba(255,255,255,0.12), transparent 70%)" }} />
      <div style={{ position: "absolute", left: LX, top: 140, fontSize: 70, fontWeight: 800, letterSpacing: "-0.05em", lineHeight: 1.05, width: 1500 }}>
        <Words text="Every account lives in one of eight lanes." at={rel("Every")} every={4} accent={{ eight: "#fff" }} />
      </div>
      <Label color="rgba(255,255,255,0.75)" style={{ position: "absolute", left: LX, top: 330 }}>lane = uint160(account) % 8 · each with its own ledger, pool and open interest</Label>
      <Lanes x={LX} y={LY} width={W} gap={GAP} labels color="rgba(255,255,255,0.28)" tick="rgba(255,255,255,0.95)" labelColor="rgba(255,255,255,0.8)" stroke={3} hot={hot} drawIn={[0, 24]} speed={speed} fadeLeft={false} />
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} style={{ position: "absolute", left: LX + W + 20, top: LY + i * GAP - 13, fontFamily: mono, fontSize: 14, letterSpacing: "0.06em", color: "rgba(255,255,255,0.85)",
          opacity: store * (i === 3 ? 1 : 0.75), transform: `translateX(${(1 - store) * 16}px)`, border: "1px solid rgba(255,255,255,0.45)", borderRadius: 5, padding: "3px 8px" }}>
          slots L{i}
        </div>
      ))}
      <div style={{ position: "absolute", left: LX + W * 0.22 + 120, top: LY + 3 * GAP - 14, padding: "3px 10px", borderRadius: 6, background: C.accentStrong, fontFamily: mono, fontSize: 16, letterSpacing: "0.06em", color: C.warnDark, opacity: ramp(f, tCrash, tCrash + 10) * (1 - ramp(f, tAnother + 40, tAnother + 54)) }}>
        L3 · auction running · its own storage only
      </div>
      <div style={{ position: "absolute", left: LX, top: LY + 8 * GAP + 10, fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em", opacity: others }}>
        The other seven never wait.
      </div>
      <div style={{ position: "absolute", left: LX, top: LY + 8 * GAP + 58, fontFamily: mono, fontSize: 16, letterSpacing: "0.06em", color: "rgba(255,255,255,0.8)", opacity: ramp(f, tPar - 4, tPar + 12) }}>
        DISJOINT STORAGE → NO SHARED SLOT → THE SHAPE MONAD'S PARALLEL EXECUTION REWARDS
      </div>
    </AbsoluteFill>
  );
};
