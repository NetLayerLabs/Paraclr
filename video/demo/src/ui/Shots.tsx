import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame } from "remotion";
import { C, mono } from "../theme";
import { Browser, Mask, Rect } from "./Browser";

/**
 * One piece of a footage scene: from scene frame `from` to `to`, play `clip` so that clip frame
 * `at` shows at scene frame `from` (continuous playback; use the same base for consecutive
 * segments of one clip). Optional camera (focus/zoom/focusAt in scene frames), spotlight,
 * masks (page CSS px), a hold (freeze) from clip frame `hold`, and the label above the window.
 */
export interface Seg {
  from: number; to: number; clip: string; at: number; url: string; label?: string;
  focus?: Rect; zoom?: number; focusAt?: [number, number]; unfocusAt?: [number, number]; spotlight?: boolean;
  masks?: Mask[]; hold?: number; light?: boolean;
}

export const W = 1400, L = 260, TOP = 112;

export const Shots: React.FC<{ segs: Seg[]; children?: React.ReactNode; bg?: string }> = ({ segs, children, bg = C.night }) => {
  const f = useCurrentFrame();
  const cur = segs.find((s) => f >= s.from && f < s.to) ?? segs[segs.length - 1];
  return (
    <AbsoluteFill style={{ background: bg }}>
      <AbsoluteFill style={{ background: "radial-gradient(60% 50% at 50% 0%, rgba(110,84,255,0.16), transparent 70%)" }} />
      {segs.map((s, i) => (
        <Sequence key={i} from={s.from} durationInFrames={Math.max(1, s.to - s.from)} layout="none">
            <Browser name={s.clip} url={s.url} width={W} left={L} top={TOP} startFrom={Math.max(0, s.at)} enter={-100}
              dark={!s.light} masks={s.masks} spotlight={s.spotlight} holdFrom={s.hold != null ? Math.max(0, s.hold - s.at) : undefined}
              {...(s.focus ? { focus: s.focus, zoom: s.zoom ?? 1.5, focusAt: (s.focusAt ? [s.focusAt[0] - s.from, s.focusAt[1] - s.from] : [0, 1]) as [number, number],
                unfocusAt: s.unfocusAt ? ([s.unfocusAt[0] - s.from, s.unfocusAt[1] - s.from] as [number, number]) : undefined } : {})} />
        </Sequence>
      ))}
      {cur?.label && (
        <div style={{ position: "absolute", left: L, top: TOP - 38, fontFamily: mono, fontSize: 15, letterSpacing: "0.08em", color: C.dInk3, textTransform: "uppercase" }}>{cur.label}</div>
      )}
      {children}
    </AbsoluteFill>
  );
};
