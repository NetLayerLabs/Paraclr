import React from "react";
import { AbsoluteFill, interpolate } from "remotion";
import { C, sora } from "../theme";
import { useScene } from "../ui/use";
import { Words } from "../ui/Words";
import { Lockup, Mark } from "../ui/Brand";
import { clamp, expo } from "../ui/motion";

/** The 8 lanes sweep in and become the real mark, then the lockup and the line. */
export const Turn: React.FC = () => {
  const { f, rel } = useScene("turn");
  const tName = rel("Paraclr"), tClock = rel("clock."), tLiq = rel("Liquidations,");
  // mark.png is 745x755; its 8 lanes sit at y = 155 + 63k (stroke 30) and run straight to about x = 420.
  const MH = 380, k = MH / 755, MW = 745 * k;
  const mx = 960 - MW / 2, my = 300 - MH / 2;
  const sweep = (i: number) => interpolate(f, [2 + i * 2, 22 + i * 2], [0, 1], { ...clamp, easing: expo });
  const toMark = interpolate(f, [tName - 10, tName + 2], [0, 1], clamp);
  const toLockup = interpolate(f, [tName + 10, tName + 26], [0, 1], { ...clamp, easing: expo });
  const lift = interpolate(f, [tLiq - 10, tLiq + 8], [0, -40], { ...clamp, easing: expo });
  return (
    <AbsoluteFill style={{ background: C.white, fontFamily: sora, color: C.ink }}>
      <AbsoluteFill style={{ background: "radial-gradient(50% 45% at 50% 30%, #F1EEFF, transparent 75%)" }} />
      <svg width={1920} height={1080} style={{ position: "absolute", opacity: 1 - toMark }}>
        {Array.from({ length: 8 }, (_, i) => {
          const y = my + (155 + 63 * i) * k;
          const x2 = mx + 420 * k;
          const p = sweep(i);
          return <line key={i} x1={-40} x2={-40 + (x2 + 40) * p} y1={y} y2={y} stroke={C.accent} strokeWidth={30 * k} strokeLinecap="round" opacity={0.35 + 0.65 * p} />;
        })}
      </svg>
      <div style={{ position: "absolute", left: mx, top: my, opacity: toMark * (1 - toLockup), transform: `scale(${1 - 0.1 * toLockup})` }}><Mark height={MH} /></div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 300 - 95 + lift, display: "flex", justifyContent: "center", opacity: toLockup, transform: `scale(${0.94 + 0.06 * toLockup})` }}>
        <Lockup height={190} tone="ink" />
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 520 + lift, textAlign: "center", fontSize: 58, fontWeight: 700, letterSpacing: "-0.04em", color: C.display2 }}>
        <Words text="replaces the race with a clock." at={rel("replaces")} every={5} accent={{ "clock.": C.accent }} />
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 640 + lift, textAlign: "center", fontSize: 128, fontWeight: 800, letterSpacing: "-0.055em", lineHeight: 1 }}>
        <Words text="Liquidations," at={tLiq} />
        <span style={{ color: C.accent }}><Words text="auctioned." at={rel("auctioned.")} /></span>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 4, background: C.accent, transform: `scaleX(${interpolate(f, [tClock, tClock + 60], [0, 1], clamp)})`, transformOrigin: "left" }} />
    </AbsoluteFill>
  );
};
