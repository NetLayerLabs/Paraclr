import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { chromeText } from "../theme";
import { clamp, expo } from "./motion";

/**
 * Kinetic type: each word rises and sharpens in turn from `at`, `every` frames apart
 * (or on its own frame when `times` is given, so words land as they are spoken).
 * Words listed in `chrome` are filled with the chrome ramp: one emphasised word per line.
 */
export const Words: React.FC<{
  text: string; at: number; every?: number; times?: number[]; chrome?: string[]; out?: number; style?: React.CSSProperties;
}> = ({ text, at, every = 3, times, chrome = [], out, style }) => {
  const f = useCurrentFrame();
  const words = text.split(" ");
  const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9'$]/g, "");
  const acc = new Set(chrome.map(norm));
  const fade = out != null ? interpolate(f, [out, out + 10], [1, 0], clamp) : 1;
  return (
    <span style={{ display: "inline", opacity: fade, ...style }}>
      {words.map((w, i) => {
        const t = times?.[i] ?? at + i * every;
        const p = interpolate(f, [t, t + 14], [0, 1], { ...clamp, easing: expo });
        return (
          <span key={i} style={{
            display: "inline-block", opacity: p, transform: `translateY(${(1 - p) * 0.35}em)`, filter: p < 1 ? `blur(${(1 - p) * 8}px)` : undefined,
            marginRight: "0.24em", ...(acc.has(norm(w)) ? chromeText : {}),
          }}>{w}</span>
        );
      })}
    </span>
  );
};
