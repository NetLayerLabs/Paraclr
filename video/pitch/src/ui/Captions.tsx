import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { C, display } from "../theme";
import { T } from "../timing";
import { clamp } from "./motion";

/** Burned-in captions: the current phrase on a dark frosted pill, each word lighting as it is spoken. */
export const Captions: React.FC<{ hidden?: (frame: number) => boolean; bottom?: number }> = ({ hidden, bottom = 78 }) => {
  const frame = useCurrentFrame();
  if (hidden?.(frame)) return null;
  const line = T.scenes.flatMap((s) => s.lines).find((l) => frame >= l.words[0].start - 6 && frame <= l.words[l.words.length - 1].end + 14);
  if (!line) return null;
  const chunks: (typeof line.words)[] = [];
  let cur: typeof line.words = [];
  for (const w of line.words) {
    cur.push(w);
    if ((/[.,:;?]$/.test(w.word) && cur.length >= 3) || cur.length >= 8) { chunks.push(cur); cur = []; }
  }
  if (cur.length) chunks.push(cur);
  let shown = chunks[0];
  for (const c of chunks) if (frame >= c[0].start - 3) shown = c;
  const first = line.words[0].start, lastEnd = line.words[line.words.length - 1].end;
  const op = interpolate(frame, [first - 6, first + 2, lastEnd + 6, lastEnd + 14], [0, 1, 1, 0], clamp);
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom, display: "flex", justifyContent: "center", opacity: op, pointerEvents: "none" }}>
      <div style={{
        maxWidth: 1240, textAlign: "center", fontFamily: display, fontStretch: "100%", fontSize: 30, fontWeight: 500, lineHeight: 1.3, letterSpacing: "-0.005em",
        padding: "10px 26px", borderRadius: 14, background: C.pill, backdropFilter: "blur(20px)",
        boxShadow: "0 0 0 1px rgba(255,255,255,0.10), 0 14px 40px rgba(0,0,0,0.5)",
      }}>
        {shown.map((w, i) => (
          <span key={i} style={{ color: C.white, opacity: frame >= w.start - 2 ? 1 : 0.34 }}>{w.word} </span>
        ))}
      </div>
    </div>
  );
};
