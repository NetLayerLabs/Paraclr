import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { serif } from "../theme";
import { clamp, expo } from "./motion";

/**
 * Kinetic type: each word rises and sharpens in turn from `at` (frame in the
 * parent Sequence), `every` frames apart. Words named in `accent` are set in the
 * italic serif in that colour: the film's one emphasised word per line.
 */
export const Words: React.FC<{
  text: string; at: number; every?: number; accent?: Record<string, string>; out?: number; style?: React.CSSProperties; serifScale?: number;
}> = ({ text, at, every = 3, accent = {}, out, style, serifScale = 1.14 }) => {
  const f = useCurrentFrame();
  const words = text.split(" ");
  const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9'%$.]/g, "").replace(/\.$/, "");
  const acc = Object.fromEntries(Object.entries(accent).map(([k, v]) => [norm(k), v]));
  const fade = out != null ? interpolate(f, [out, out + 10], [1, 0], clamp) : 1;
  return (
    <span style={{ display: "inline", opacity: fade, ...style }}>
      {words.map((w, i) => {
        const t = at + i * every;
        const p = interpolate(f, [t, t + 14], [0, 1], { ...clamp, easing: expo });
        const a = acc[norm(w)];
        return (
          <span key={i} style={{
            display: "inline-block", opacity: p, transform: `translateY(${(1 - p) * 0.4}em)`, filter: p < 1 ? `blur(${(1 - p) * 8}px)` : undefined,
            marginRight: "0.22em",
            ...(a ? { fontFamily: serif, fontStyle: "italic", fontWeight: 400, color: a, fontSize: `${serifScale}em`, letterSpacing: "-0.02em", lineHeight: 0.9 } : {}),
          }}>{w}</span>
        );
      })}
    </span>
  );
};
