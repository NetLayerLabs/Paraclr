import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, interpolate, staticFile, useCurrentFrame } from "remotion";
import footage from "../footage.json";
import { C, mono, sora } from "../theme";
import { clamp, soft } from "./motion";

export interface Rect { x: number; y: number; w: number; h: number }
export interface Clip { file: string; width: number; height: number; durationFrames: number; marks?: Record<string, number>; rects?: Record<string, Rect> }
const LIB = footage as unknown as Record<string, Clip>;
export const clip = (name: string): Clip | undefined => LIB[name];
export const markOf = (name: string, m: string): number => LIB[name]?.marks?.[m] ?? 0;

/** The page the footage was recorded at, in CSS pixels (device scale 2). */
export const PAGE = { w: 1600, h: 900 };

/** A frosted mask over part of the page (CSS px), shown between frames `from` and `to` of the clip. */
export interface Mask extends Rect { from?: number; to?: number }

/**
 * A browser window playing a recorded clip of the live site. The camera moves from
 * the whole page to `focus` (page CSS px) over `focusAt`, at `zoom` times the fit.
 * `masks` blur regions of the page (the sign-in email and code) in every frame they cover.
 */
export const Browser: React.FC<{
  name: string; url: string; width: number; left: number; top: number;
  startFrom?: number; focus?: Rect; zoom?: number; focusAt?: [number, number]; unfocusAt?: [number, number];
  still?: string; enter?: number; exit?: number; masks?: Mask[]; dark?: boolean; tilt?: number;
  /** dims everything outside `focus` while zoomed, so no cut-off page text shows around it */
  spotlight?: boolean;
}> = ({ name, url, width, left, top, startFrom = 0, focus, zoom = 1.8, focusAt = [0, 1], unfocusAt, still, enter = 0, exit, masks = [], dark = true, tilt = 0, spotlight = false }) => {
  const f = useCurrentFrame();
  const c = clip(name);
  const bar = 44;
  const vh = (width * PAGE.h) / PAGE.w;
  const k = width / PAGE.w;
  let p = focus ? interpolate(f, focusAt, [0, 1], { ...clamp, easing: soft }) : 0;
  if (focus && unfocusAt) p *= interpolate(f, unfocusAt, [1, 0], { ...clamp, easing: soft });
  const s = 1 + (zoom - 1) * p;
  const cx = focus ? focus.x + focus.w / 2 : PAGE.w / 2;
  const cy = focus ? focus.y + focus.h / 2 : PAGE.h / 2;
  const tx = Math.min(0, Math.max(width - PAGE.w * k * s, width / 2 - cx * k * s)) * (p > 0 ? 1 : 0);
  const ty = Math.min(0, Math.max(vh - PAGE.h * k * s, vh / 2 - cy * k * s)) * (p > 0 ? 1 : 0);
  const inP = interpolate(f, [enter, enter + 18], [0, 1], { ...clamp, easing: soft });
  const outP = exit != null ? interpolate(f, [exit - 12, exit], [1, 0], clamp) : 1;
  const clipFrame = f + startFrom;
  return (
    <div style={{
      position: "absolute", left, top, width, height: vh + bar, borderRadius: 18, overflow: "hidden",
      background: dark ? C.surface : C.white,
      boxShadow: dark ? "0 0 0 1px rgba(255,255,255,0.10), 0 40px 100px rgba(0,0,0,0.55)" : "0 0 0 1px rgba(11,10,18,0.08), 0 40px 90px rgba(40,30,110,0.18)",
      opacity: inP * outP, transform: `translateY(${(1 - inP) * 36}px) perspective(2400px) rotateX(${tilt * (1 - inP)}deg)`,
    }}>
      <div style={{ height: bar, display: "flex", alignItems: "center", gap: 8, padding: "0 18px", background: dark ? "#14131C" : "#F3F2F7", borderBottom: dark ? "1px solid rgba(255,255,255,0.07)" : "1px solid #E9E8F0" }}>
        {[0, 1, 2].map((i) => <span key={i} style={{ width: 11, height: 11, borderRadius: 6, background: dark ? "rgba(255,255,255,0.16)" : "rgba(11,10,18,0.14)" }} />)}
        <div style={{ marginLeft: 16, flex: 1, maxWidth: 520, height: 26, borderRadius: 13, background: dark ? "rgba(255,255,255,0.06)" : "#E9E8F0", display: "flex", alignItems: "center", padding: "0 14px", fontFamily: mono, fontSize: 13.5, color: dark ? C.dInk3 : C.ink3 }}>{url}</div>
      </div>
      <div style={{ position: "relative", width, height: vh, overflow: "hidden", background: dark ? C.night : C.white }}>
        <div style={{ position: "absolute", left: 0, top: 0, width: PAGE.w, height: PAGE.h, transformOrigin: "0 0", transform: `translate(${tx}px, ${ty}px) scale(${k * s})` }}>
          {c ? (
            <OffthreadVideo src={staticFile(c.file)} startFrom={startFrom} muted style={{ width: PAGE.w, height: PAGE.h, display: "block" }} />
          ) : still ? (
            <Img src={staticFile(still)} style={{ width: PAGE.w, height: PAGE.h }} />
          ) : (
            <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", fontFamily: sora, color: C.dInk3, fontSize: 28 }}>footage “{name}” pending</AbsoluteFill>
          )}
          {masks.filter((m) => clipFrame >= (m.from ?? -1e9) && clipFrame <= (m.to ?? 1e9)).map((m, i) => (
            <div key={i} style={{ position: "absolute", left: m.x, top: m.y, width: m.w, height: m.h, borderRadius: 8, backdropFilter: "blur(14px)", background: "rgba(20,19,28,0.55)" }} />
          ))}
          {spotlight && focus && p > 0 && (
            <div style={{ position: "absolute", left: focus.x - 2, top: focus.y - 2, width: focus.w + 4, height: focus.h + 4, borderRadius: 18,
              boxShadow: `0 0 0 3000px rgba(8,7,13,${p})`, pointerEvents: "none" }} />
          )}
        </div>
      </div>
    </div>
  );
};
