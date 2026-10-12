import React from "react";
import { Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { C, chromeText, display, mono } from "../theme";
import { clamp, expo, pop } from "../ui/motion";

/** In/out envelope for an overlay shown from `a` to `b` (frames). */
export const env = (f: number, a: number, b: number, inn = 14, out = 12) =>
  interpolate(f, [a, a + inn, b - out, b], [0, 1, 1, 0], { ...clamp, easing: expo });

/** A dark chip that reads on his purple background: near-black glass, a hairline, a soft shadow. */
const chip: React.CSSProperties = {
  background: "rgba(8,8,10,0.84)", backdropFilter: "blur(18px)", border: "1px solid rgba(255,255,255,0.12)",
  boxShadow: "0 24px 60px rgba(30,0,60,0.35)",
};
/** x >= 0: from the left edge; x < 0: |x| from the right edge (the card grows leftwards). */
const place = (x: number, y: number): React.CSSProperties => (x >= 0 ? { left: x, top: y } : { right: -x, top: y });
const origin = (x: number) => (x >= 0 ? "left top" : "right top");

/** Name lower third: a white bar wipes in, then the NetLayer mark, the name and the title. */
export const LowerThird: React.FC<{ a: number; b: number; name: string; title: string; left: number; bottom: number }> = ({ a, b, name, title, left, bottom }) => {
  const f = useCurrentFrame();
  const p = env(f, a, b, 18, 14);
  const bar = interpolate(f, [a, a + 16], [0, 1], { ...clamp, easing: expo });
  if (p <= 0) return null;
  return (
    <div style={{ position: "absolute", left, bottom, opacity: p }}>
      <div style={{ ...chip, display: "flex", alignItems: "center", gap: 24, padding: "22px 34px 22px 24px", borderRadius: 22, clipPath: `inset(0 ${(1 - bar) * 100}% 0 0 round 22px)` }}>
        <div style={{ width: 6, alignSelf: "stretch", borderRadius: 3, background: "linear-gradient(180deg,#fff,#8a8d92)" }} />
        <Img src={staticFile("brand/nl-mark.png")} style={{ height: 50 }} />
        <div>
          <div style={{ fontFamily: display, fontStretch: "115%", fontWeight: 800, fontSize: 54, letterSpacing: "-0.015em", lineHeight: 1, ...chromeText }}>{name}</div>
          <div style={{ marginTop: 10, fontFamily: mono, fontSize: 19, letterSpacing: "0.16em", textTransform: "uppercase", color: C.ink2 }}>{title}</div>
        </div>
      </div>
    </div>
  );
};

/** A fact card that pops in near a top corner: a chrome or white title over a mono subline; optional Paraclr mark (its own colour). */
export const Card: React.FC<{ a: number; b: number; title: string; sub?: string; x: number; y: number; paraclr?: boolean; big?: boolean }> = ({ a, b, title, sub, x, y, paraclr, big }) => {
  const f = useCurrentFrame();
  const p = env(f, a, b);
  const s = pop(f, a);
  if (p <= 0) return null;
  return (
    <div style={{ position: "absolute", ...place(x, y), opacity: p, transform: `scale(${0.88 + 0.12 * s})`, transformOrigin: origin(x) }}>
      <div style={{ ...chip, display: "flex", alignItems: "center", gap: 22, padding: "26px 36px", borderRadius: 26, maxWidth: 760 }}>
        {paraclr ? <Img src={staticFile("brand/paraclr-mark-512.png")} style={{ height: 80 }} /> : <div style={{ width: 7, height: big ? 100 : 80, borderRadius: 3, background: "linear-gradient(180deg,#fff,#8a8d92)" }} />}
        <div>
          <div style={{ fontFamily: display, fontStretch: "112%", fontWeight: 800, fontSize: big ? 74 : 54, letterSpacing: "-0.015em", lineHeight: 1.04, ...(big ? chromeText : { color: C.white }) }}>{title}</div>
          {sub ? <div style={{ marginTop: 12, fontFamily: mono, fontSize: 21, letterSpacing: "0.1em", textTransform: "uppercase", color: C.ink2, lineHeight: 1.4 }}>{sub}</div> : null}
        </div>
      </div>
    </div>
  );
};
