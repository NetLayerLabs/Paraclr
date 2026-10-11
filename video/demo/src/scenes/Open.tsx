import React from "react";
import { AbsoluteFill, Easing, interpolate } from "remotion";
import { C, mono, sora } from "../theme";
import { useScene } from "../ui/use";
import { Words } from "../ui/Words";
import { Lanes } from "../ui/Lanes";
import { Label } from "../ui/Label";
import { clamp, expo, ramp } from "../ui/motion";
import data from "../data.json";
import { num } from "../ui/format";

/** Cold open: the largest liquidation day on record, as a tally that will not stop climbing. */
export const Open: React.FC = () => {
  const { f, rel } = useScene("open");
  const o = data.open;
  const tUsd = rel("nineteen"), tTr = rel("One"), tH = rel("twenty-four");
  // The tally races from the first frame and lands on the real figure as it is spoken.
  const usd = interpolate(f, [0, tUsd + 24], [0, o.usdBillions], { ...clamp, easing: Easing.bezier(0.5, 0, 0.2, 1) });
  const tr = interpolate(f, [0, tTr + 30], [0, o.traders], { ...clamp, easing: Easing.bezier(0.5, 0, 0.2, 1) });
  const lit = (t: number) => ramp(f, t - 4, t + 10);
  // Liquidation flashes racing along the lanes.
  const hot = Array.from({ length: 26 }, (_, k) => ({ lane: (k * 5 + 3) % 8, at: 6 + k * 15, resolve: 6 + k * 15 + 9, color: C.negDark }));
  return (
    <AbsoluteFill style={{ background: C.night, fontFamily: sora, color: C.dInk }}>
      <AbsoluteFill style={{ background: "radial-gradient(60% 50% at 30% 40%, rgba(110,84,255,0.10), transparent 70%)" }} />
      <Lanes y={880} gap={16} color="rgba(255,255,255,0.08)" tick="rgba(255,90,122,0.55)" hot={hot} stroke={1.5} speed={2.2} opacity={0.9} />
      <div style={{ position: "absolute", left: 120, top: 190, fontSize: 132, fontWeight: 800, letterSpacing: "-0.055em", lineHeight: 1 }}>
        <Words text="October 2025." at={rel("October")} every={14} />
      </div>
      <div style={{ position: "absolute", left: 122, top: 345, fontSize: 60, fontWeight: 700, letterSpacing: "-0.04em", color: C.dDisplay2 }}>
        <Words text="Crypto's largest liquidation day ever." at={rel("Crypto's")} every={10} accent={{ "ever.": C.accentInkDark }} />
      </div>
      <div style={{ position: "absolute", left: 120, top: 520, display: "flex", gap: 64, alignItems: "flex-end" }}>
        <div>
          <Label color={C.dInk3} dot={C.negDark}>liquidated · 24h</Label>
          <div style={{ fontSize: 150, fontWeight: 800, letterSpacing: "-0.06em", lineHeight: 1, marginTop: 14, color: f >= tUsd ? C.dInk : C.dInk2, fontVariantNumeric: "tabular-nums" }}>
            ${(f >= tUsd + 24 ? o.usdBillions : usd).toFixed(2)}<span style={{ fontSize: 64, letterSpacing: "-0.03em", marginLeft: 18 }}>billion</span>
          </div>
        </div>
        <div style={{ opacity: 0.35 + 0.65 * lit(tTr) }}>
          <Label color={C.dInk3}>liquidated</Label>
          <div style={{ fontSize: 88, fontWeight: 800, letterSpacing: "-0.05em", lineHeight: 1, marginTop: 14, fontVariantNumeric: "tabular-nums" }}>
            {num(f >= tTr + 30 ? o.traders : Math.round(tr))}<span style={{ fontSize: 40, letterSpacing: "-0.02em", marginLeft: 14, color: C.dInk2 }}>traders</span>
          </div>
        </div>
        <div style={{ opacity: lit(tH), transform: `translateY(${(1 - lit(tH)) * 20}px)` }}>
          <Label color={C.dInk3}>window</Label>
          <div style={{ fontSize: 96, fontWeight: 800, letterSpacing: "-0.05em", lineHeight: 1, marginTop: 14 }}>24<span style={{ fontSize: 60, color: C.dInk3 }}> h</span></div>
        </div>
      </div>
      <div style={{ position: "absolute", left: 120, top: 760, fontFamily: mono, fontSize: 15, letterSpacing: "0.06em", color: C.dInk3, opacity: ramp(f, tUsd, tUsd + 16, expo) }}>
        Source: {o.source} · 10–11 Oct 2025 · CoinGlass notes the true total is likely higher
      </div>
    </AbsoluteFill>
  );
};
