import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, Sequence, interpolate, staticFile } from "remotion";
import { C, chromeText, display, mono } from "../theme";
import { clamp, expo, ramp } from "../ui/motion";
import { Count } from "../ui/Count";
import { Label } from "../ui/Label";
import { useScene } from "../ui/use";

const FW = 940, FH = FW * 9 / 16 + 34;

/** Real app frames, full colour and contrast, in a minimal browser shell. */
const Frame: React.FC<{ url: string; children: React.ReactNode }> = ({ url, children }) => (
  <div style={{ width: FW, height: FH, borderRadius: 12, overflow: "hidden", background: "#0b0b0b", boxShadow: "0 0 0 1px rgba(255,255,255,0.16), 0 50px 110px rgba(0,0,0,0.75)" }}>
    <div style={{ height: 34, display: "flex", alignItems: "center", gap: 8, padding: "0 14px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
      {[0, 1, 2].map((i) => <span key={i} style={{ width: 9, height: 9, borderRadius: 5, border: "1px solid rgba(255,255,255,0.3)" }} />)}
      <span style={{ marginLeft: 16, fontFamily: mono, fontSize: 13, letterSpacing: "0.06em", color: C.muted }}>{url}</span>
    </div>
    <div style={{ width: FW, height: FW * 9 / 16 }}>{children}</div>
  </div>
);

/** Paraclr, a NetLayer Labs product: what it does, over real frames from the live testnet app. */
export const Paraclr: React.FC = () => {
  const { f, rel, dur } = useScene("paraclr");
  const logo = ramp(f, rel("Paraclr.") - 6, rel("Paraclr.") + 18);
  const a1 = rel("per-block"), a2 = rel("eight"), a3 = rel("parallel"), a4 = rel("Live"), a5 = rel("measured.");
  const shots = [
    { url: "paraclr.xyz/trade", at: rel("Paraclr.") + 12, el: <Img src={staticFile("footage/app_position.png")} style={{ width: "100%" }} /> },
    { url: "paraclr.xyz/arena", at: a2 - 6, el: <Sequence from={a2 - 6} layout="none"><OffthreadVideo src={staticFile("footage/arena.mp4")} trimBefore={300} muted style={{ width: "100%" }} /></Sequence> },
    { url: "paraclr.xyz/arena · conflict x-ray", at: rel("every") - 8, el: <Sequence from={rel("every") - 8} layout="none"><OffthreadVideo src={staticFile("footage/arena_xray.mp4")} trimBefore={330} muted style={{ width: "100%" }} /></Sequence> },
  ];
  const row = (at: number) => ramp(f, at - 4, at + 16, expo);
  const drift = interpolate(f, [0, dur], [0, -14]);
  return (
    <AbsoluteFill style={{ background: C.black }}>
      <AbsoluteFill style={{ background: "radial-gradient(45% 55% at 72% 50%, rgba(255,255,255,0.07), transparent 70%)" }} />
      {/* product lockup: the only colour in the film */}
      <div style={{ position: "absolute", left: 140, top: 150, opacity: logo, transform: `translateY(${(1 - logo) * 12}px)` }}>
        <Img src={staticFile("brand/paraclr-header-white-192.png")} style={{ height: 58 }} />
        <Label size={16} style={{ marginTop: 18 }}>a NetLayer Labs product</Label>
      </div>
      {/* what it does */}
      <div style={{ position: "absolute", left: 140, top: 340, width: 720, fontFamily: display, color: C.white }}>
        <div style={{ opacity: row(a1), transform: `translateY(${(1 - row(a1)) * 18}px)`, fontStretch: "112%", fontWeight: 700, fontSize: 56, lineHeight: 1.05, letterSpacing: "-0.015em" }}>
          Liquidation as a <span style={{ ...chromeText, whiteSpace: "nowrap" }}>per-block auction</span>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 22, marginTop: 34, opacity: row(a2), transform: `translateY(${(1 - row(a2)) * 18}px)` }}>
          <span style={{ fontStretch: "125%", fontWeight: 800, fontSize: 132, lineHeight: 0.9, ...chromeText }}><Count to={8} at={a2} dur={14} /></span>
          <span style={{ fontStretch: "112%", fontWeight: 600, fontSize: 44 }}>lanes</span>
          <span style={{ fontFamily: mono, fontSize: 18, letterSpacing: "0.14em", color: C.ink2, opacity: row(a3), textTransform: "uppercase", lineHeight: 1.45 }}>for Monad's<br />parallel execution</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 44, fontFamily: mono, fontSize: 19, letterSpacing: "0.14em", textTransform: "uppercase", color: C.white, opacity: row(a4) }}>
          <span style={{ width: 10, height: 10, borderRadius: 5, background: "#fff", boxShadow: `0 0 ${8 + 6 * Math.sin(f / 6)}px rgba(255,255,255,0.9)` }} />
          Live on Monad testnet <span style={{ color: C.dim }}>·</span> <span style={{ color: C.ink2, textTransform: "none", letterSpacing: "0.06em" }}>paraclr.xyz</span>
        </div>
        <div style={{ marginTop: 16, paddingLeft: 24, fontFamily: mono, fontSize: 19, letterSpacing: "0.14em", textTransform: "uppercase", color: C.ink2, opacity: row(a5) }}>
          Every number measured
        </div>
      </div>
      {/* frames */}
      <div style={{ position: "absolute", left: 880, top: 230 + drift, width: FW, height: FH }}>
        {shots.map((s, i) => {
          // one frame at a time: each fades out fully before the next fades in
          const next = shots[i + 1]?.at ?? 1e6;
          const op = interpolate(f, [s.at, s.at + 10, next - 10, next], [0, 1, 1, 0], clamp);
          if (op <= 0) return null;
          const p = ramp(f, s.at, s.at + 20, expo);
          return (
            <div key={s.url} style={{ position: "absolute", inset: 0, opacity: op, transform: `translateY(${(1 - p) * 24}px) scale(${0.98 + 0.02 * p})` }}>
              <Frame url={s.url}>{s.el}</Frame>
            </div>
          );
        })}
        <div style={{ position: "absolute", left: 0, top: FH + 22, fontFamily: mono, fontSize: 13, letterSpacing: "0.18em", color: C.dim, opacity: ramp(f, rel("auction,"), rel("auction,") + 14) }}>
          REAL APP FRAMES <span style={{ marginLeft: 8, marginRight: 8 }}>·</span> MONAD TESTNET <span style={{ marginLeft: 8, marginRight: 8 }}>·</span> TEST FUNDS
        </div>
      </div>
    </AbsoluteFill>
  );
};
