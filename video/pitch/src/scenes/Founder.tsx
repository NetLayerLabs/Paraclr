import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile } from "remotion";
import { C, chromeText, display, mono } from "../theme";
import { clamp, expo, ramp } from "../ui/motion";
import { Spotlight } from "../ui/Spotlight";
import { Label } from "../ui/Label";
import { useScene } from "../ui/use";

const S = 470; // picture size

/** The founder's picture in a clean monochrome frame, the lower third, then what the studio builds. */
export const Founder: React.FC = () => {
  const { f, rel, dur } = useScene("founder");
  const frame = ramp(f, 0, 26);
  const pic = ramp(f, 8, 34);
  const name = ramp(f, rel("MrNetwork.") - 6, rel("MrNetwork.") + 22);
  const builds = [
    ["Autonomous agents", "autonomous"],
    ["Onchain infrastructure", "onchain"],
    ["The apps on top", "apps"],
  ] as const;
  const drift = interpolate(f, [0, dur], [0, -10]);
  const tick = (pos: React.CSSProperties) => <div style={{ position: "absolute", width: 22, height: 22, borderColor: "rgba(255,255,255,0.75)", borderStyle: "solid", borderWidth: 0, ...pos }} />;
  return (
    <AbsoluteFill style={{ background: C.black }}>
      <Spotlight x={0.27} angle={-6} intensity={0.75} width={760} poolY={0.84} />
      {/* picture frame */}
      <div style={{ position: "absolute", left: 250, top: 196 + drift, width: S + 36, height: S + 36, opacity: frame, transform: `scale(${0.96 + 0.04 * frame})` }}>
        <div style={{ position: "absolute", inset: 0, border: "1px solid rgba(255,255,255,0.16)" }} />
        {tick({ left: -1, top: -1, borderLeftWidth: 2, borderTopWidth: 2 })}
        {tick({ right: -1, top: -1, borderRightWidth: 2, borderTopWidth: 2 })}
        {tick({ left: -1, bottom: -1, borderLeftWidth: 2, borderBottomWidth: 2 })}
        {tick({ right: -1, bottom: -1, borderRightWidth: 2, borderBottomWidth: 2 })}
        <div style={{ position: "absolute", left: 18, top: 18, width: S, height: S, overflow: "hidden", background: "#0a0a0a", boxShadow: "0 0 0 1px rgba(255,255,255,0.28), 0 40px 90px rgba(0,0,0,0.7)" }}>
          <Img src={staticFile("brand/pfp.jpg")} style={{ width: S, height: S, opacity: pic, filter: `blur(${(1 - pic) * 10}px)`, transform: `scale(${1.06 - 0.06 * pic})` }} />
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, top: S + 52, display: "flex", justifyContent: "space-between", fontFamily: mono, fontSize: 14, letterSpacing: "0.16em", color: C.muted }}>
          <span>FIG. 01</span><span>FOUNDER</span>
        </div>
      </div>
      {/* lower third */}
      <div style={{ position: "absolute", left: 870, top: 236, opacity: name, transform: `translateX(${(1 - name) * 30}px)` }}>
        <Label size={18}>Founded by</Label>
        <div style={{ fontFamily: display, fontStretch: "118%", fontWeight: 800, fontSize: 112, letterSpacing: "-0.02em", lineHeight: 1.05, marginTop: 14, ...chromeText }}>MrNetwork</div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 12, fontFamily: mono, fontSize: 20, letterSpacing: "0.16em", color: C.ink2 }}>
          <span style={{ width: 40, height: 1, background: C.ink2 }} />FOUNDER <span style={{ color: C.dim }}>·</span> NETLAYER LABS
        </div>
      </div>
      {/* what we build */}
      <div style={{ position: "absolute", left: 870, top: 540, width: 800 }}>
        {builds.map(([t, cue], i) => {
          const p = ramp(f, rel(cue) - 4, rel(cue) + 18, expo);
          return (
            <div key={t} style={{ display: "flex", alignItems: "center", gap: 22, height: 78, borderTop: `1px solid rgba(255,255,255,${0.16 * p})`, ...(i === 2 ? { borderBottom: `1px solid rgba(255,255,255,${0.16 * p})` } : {}) }}>
              <span style={{ fontFamily: mono, fontSize: 15, color: C.dim, width: 34, opacity: p }}>0{i + 1}</span>
              <span style={{ fontFamily: display, fontStretch: "112%", fontSize: 40, fontWeight: 600, color: C.white, opacity: p, transform: `translateY(${(1 - p) * 14}px)`, filter: p < 1 ? `blur(${(1 - p) * 6}px)` : undefined }}>{t}</span>
              <span style={{ marginLeft: "auto", color: C.white, fontSize: 14, opacity: interpolate(f, [rel(cue) + 8, rel(cue) + 12], [0, 1], clamp) }}>■</span>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
