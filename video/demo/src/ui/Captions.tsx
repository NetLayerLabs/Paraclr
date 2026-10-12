import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { sora, SCENE_TONE, TONE } from "../theme";
import { useTiming } from "../timing";
import { clamp } from "./motion";

/** Narration captions: the current phrase on a frosted pill, each word lighting up as it is spoken. */
export const Captions: React.FC<{ hidden?: (frame: number) => boolean; bottom?: number }> = ({ hidden, bottom = 84 }) => {
  const frame = useCurrentFrame();
  const T = useTiming();
  if (hidden?.(frame)) return null;
  const sc = T.scenes.find((s) => frame >= s.from && frame < s.from + s.durationInFrames);
  const line = T.scenes.flatMap((s) => s.lines).find((l) => frame >= l.startFrame - 4 && frame <= l.words[l.words.length - 1].end + 14);
  if (!line || !sc) return null;
  const tone = TONE[SCENE_TONE[sc.id] ?? "light"];
  const chunks: (typeof line.words)[] = [];
  let cur: typeof line.words = [];
  for (const w of line.words) {
    cur.push(w);
    if ((/[.,:;?]$/.test(w.word) && cur.length >= 4) || cur.length >= 9) { chunks.push(cur); cur = []; }
  }
  if (cur.length) chunks.push(cur);
  let shown = chunks[0];
  for (const c of chunks) if (frame >= c[0].start - 3) shown = c;
  const lastEnd = line.words[line.words.length - 1].end;
  const op = interpolate(frame, [line.startFrame - 4, line.startFrame + 4, lastEnd + 6, lastEnd + 14], [0, 1, 1, 0], clamp);
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom, display: "flex", justifyContent: "center", opacity: op, pointerEvents: "none" }}>
      <div style={{
        maxWidth: 1300, textAlign: "center", fontFamily: sora, fontSize: 29, fontWeight: 500, lineHeight: 1.35, letterSpacing: "-0.015em",
        padding: "10px 26px", borderRadius: 16, background: tone.pill, backdropFilter: "blur(22px)",
        boxShadow: "0 0 0 1px " + tone.line + ", 0 12px 34px rgba(0,0,0,0.18)",
      }}>
        {shown.map((w, i) => (
          <span key={i} style={{ color: tone.ink, opacity: frame >= w.start - 2 ? 1 : 0.38 }}>{w.word} </span>
        ))}
      </div>
    </div>
  );
};
