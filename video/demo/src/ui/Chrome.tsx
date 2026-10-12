import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { useTiming } from "../timing";
import { mono, SCENE_TONE, TESTNET_SCENES, TONE } from "../theme";
import { clamp } from "./motion";
import { NetLayer } from "./NetLayer";

/**
 * Corner furniture: the testnet label bottom left in every product and proof scene,
 * and "Built by NetLayer Labs" bottom right, tinted per scene (white on dark, ink on light).
 */
export const Chrome: React.FC<{ hideAfter?: number }> = ({ hideAfter }) => {
  const f = useCurrentFrame();
  const T = useTiming();
  const sc = T.scenes.find((s) => f >= s.from && f < s.from + s.durationInFrames) ?? T.scenes[T.scenes.length - 1];
  const toneId = SCENE_TONE[sc.id] ?? "light";
  const tone = TONE[toneId];
  const op = hideAfter != null ? interpolate(f, [hideAfter, hideAfter + 12], [1, 0], clamp) : 1;
  const testnet = TESTNET_SCENES.has(sc.id);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {testnet && (
        <div style={{ position: "absolute", left: 48, bottom: 34, fontFamily: mono, fontSize: 13, letterSpacing: "0.05em", textTransform: "uppercase", color: tone.ink2, opacity: op, display: "inline-flex", alignItems: "center", gap: 9 }}>
          <span style={{ width: 7, height: 7, borderRadius: 4, background: toneId === "violet" ? "#fff" : "#3DDC97" }} />
          Monad testnet · test funds
        </div>
      )}
      <NetLayer height={20} dark={NL_DARK[toneId]} labelColor={tone.muted} style={{ position: "absolute", right: 52, bottom: 30, opacity: op }} />
    </AbsoluteFill>
  );
};

/** Ink-tinted NetLayer on light scenes; white on dark and on the violet scenes (where ink reads muddy). */
const NL_DARK: Record<string, boolean> = { light: true, dark: false, violet: false };
