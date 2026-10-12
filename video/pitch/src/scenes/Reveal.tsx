import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile } from "remotion";
import { C, mono } from "../theme";
import { clamp, ramp, soft } from "../ui/motion";
import { Spotlight } from "../ui/Spotlight";
import { Label } from "../ui/Label";
import { useScene } from "../ui/use";

const W = 760; // displayed width of the chrome mark crop (1254 px source)
const K = W / 1254;

/** Black; a stage light sweeps in, the chrome mark lights up, then the wordmark, then who we are. */
export const Reveal: React.FC = () => {
  const { f, rel, dur } = useScene("reveal");
  const sweep = ramp(f, 0, 70, soft);
  const lit = ramp(f, 22, 62, soft);
  const sheen = interpolate(f, [34, 84], [-0.4, 1.4], clamp);
  const word = ramp(f, rel("NetLayer") - 4, rel("NetLayer") + 26);
  const sub = ramp(f, rel("independent") - 4, rel("independent") + 20);
  const italy = ramp(f, rel("Italy.") - 4, rel("Italy.") + 18);
  const push = interpolate(f, [0, dur], [1, 1.045]);
  return (
    <AbsoluteFill style={{ background: C.black }}>
      <AbsoluteFill style={{ transform: `scale(${push})` }}>
        <Spotlight x={0.5} angle={interpolate(sweep, [0, 1], [42, 0])} intensity={sweep * 0.95} width={900} poolY={0.8} />
        {/* the chrome mark, lit by the beam; a specular band crosses it (overlay brightens only the lit metal) */}
        <div style={{ position: "absolute", left: (1920 - W) / 2, top: 96, width: W, height: 600 * K, opacity: lit, mixBlendMode: "screen", filter: `brightness(${0.25 + 0.8 * lit}) blur(${(1 - lit) * 6}px)` }}>
          <Img src={staticFile("brand/mark-chrome.png")} style={{ width: "100%" }} />
          <div style={{ position: "absolute", inset: 0, mixBlendMode: "overlay", background: `linear-gradient(105deg, transparent ${sheen * 100 - 18}%, rgba(255,255,255,0.95) ${sheen * 100}%, transparent ${sheen * 100 + 18}%)` }} />
        </div>
        {/* NETLAYER LABS: the chrome wordmark, wiped in from the centre */}
        <div style={{ position: "absolute", left: (1920 - 1000 * K) / 2, top: 96 + 590 * K, width: 1000 * K, height: 230 * K,
          clipPath: `inset(0 ${(1 - word) * 50}% 0 ${(1 - word) * 50}%)`, opacity: word, mixBlendMode: "screen", filter: `blur(${(1 - word) * 5}px)` }}>
          <Img src={staticFile("brand/word-chrome.png")} style={{ width: "100%" }} />
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, top: 690, display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
          <Label size={20} color={C.ink2} style={{ opacity: sub, transform: `translateY(${(1 - sub) * 10}px)` }}>Independent product studio + research lab</Label>
          <div style={{ fontFamily: mono, fontSize: 17, letterSpacing: "0.22em", color: C.muted, opacity: italy, transform: `translateY(${(1 - italy) * 8}px)` }}>
            <span style={{ color: C.white, marginRight: 12 }}>■</span>ITALY <span style={{ color: C.dim }}>·</span> EUROPE
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
