import React from "react";
import { AbsoluteFill, interpolate } from "remotion";
import { C, mono, sora } from "../theme";
import { useScene } from "../ui/use";
import { Words } from "../ui/Words";
import { Count } from "../ui/Count";
import { Label } from "../ui/Label";
import { clamp, expo, ramp } from "../ui/motion";
import data from "../data.json";
import { num } from "../ui/format";

/** The measured crash on Monad testnet: what the auctions took vs a fixed fee. */
export const Kept: React.FC = () => {
  const { f, rel } = useScene("kept");
  const k = data.kept;
  const t28 = rel("twenty-eight"), tFixed = rel("fixed"), tBack = rel("Whatever");
  const MAXW = 1100;
  const bar = (v: number, at: number) => (MAXW * v / k.fixed) * interpolate(f, [at, at + 26], [0, 1], { ...clamp, easing: expo });
  const fmt = (v: number) => num(v, 2);
  return (
    <AbsoluteFill style={{ background: C.accent, fontFamily: sora, color: "#fff" }}>
      <AbsoluteFill style={{ background: "radial-gradient(60% 60% at 85% 20%, rgba(255,255,255,0.14), transparent 70%)" }} />
      <Label color="rgba(255,255,255,0.8)" style={{ position: "absolute", left: 150, top: 130, opacity: ramp(f, rel("measured") - 4, rel("measured") + 10) }}>
        measured on Monad testnet · −20% oracle shock · {k.liquidated} accounts liquidated · 10 Oct 2026
      </Label>
      <div style={{ position: "absolute", left: 140, top: 170, display: "flex", alignItems: "baseline", gap: 30 }}>
        <div style={{ fontSize: 300, fontWeight: 800, letterSpacing: "-0.07em", lineHeight: 1, opacity: ramp(f, t28 - 6, t28 + 4) }}>
          <Count to={Math.round(k.pctLess)} at={t28 - 4} dur={30} suffix="%" />
        </div>
        <div style={{ fontSize: 76, fontWeight: 800, letterSpacing: "-0.05em", lineHeight: 1.0 }}>
          <Words text="less taken from traders" at={rel("less") - 2} every={4} accent={{ less: "#fff" }} />
        </div>
      </div>
      <div style={{ position: "absolute", left: 150, top: 560 }}>
        {[
          { label: "Taken by the auctions", v: k.taken, at: rel("auctions") + 6, solid: true },
          { label: "A fixed 1% fee would have taken", v: k.fixed, at: tFixed - 4, solid: false },
        ].map((r, i) => (
          <div key={i} style={{ marginBottom: 34, opacity: ramp(f, r.at - 4, r.at + 8) }}>
            <div style={{ display: "flex", justifyContent: "space-between", width: MAXW, fontSize: 24, fontWeight: 600, letterSpacing: "-0.01em", marginBottom: 10 }}>
              <span>{r.label}</span>
              <span style={{ fontFamily: mono, fontWeight: 500 }}>{fmt(r.v)} AUSD</span>
            </div>
            <div style={{ width: bar(r.v, r.at), height: 30, borderRadius: 8, background: r.solid ? "#fff" : "transparent", border: r.solid ? "none" : "2.5px dashed rgba(255,255,255,0.85)" }} />
          </div>
        ))}
      </div>
      <div style={{ position: "absolute", left: 1330, top: 600, width: 440, padding: "22px 26px", borderRadius: 18, background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.3)",
        opacity: ramp(f, tBack - 4, tBack + 12), transform: `translateY(${(1 - ramp(f, tBack - 4, tBack + 12)) * 24}px)` }}>
        <div style={{ fontFamily: mono, fontSize: 14, letterSpacing: "0.08em", color: "rgba(255,255,255,0.8)" }}>RETURNED TO TRADERS</div>
        <div style={{ fontSize: 54, fontWeight: 800, letterSpacing: "-0.05em", marginTop: 6 }}><Count to={k.returned} at={tBack} dur={30} decimals={2} /> <span style={{ fontSize: 24 }}>AUSD</span></div>
        <div style={{ fontSize: 18, color: "rgba(255,255,255,0.85)", marginTop: 4 }}>the equity the auctions didn't need</div>
      </div>
      <Label color="rgba(255,255,255,0.8)" style={{ position: "absolute", left: 150, top: 900, textTransform: "none" }}>evidence · {k.file}</Label>
    </AbsoluteFill>
  );
};
