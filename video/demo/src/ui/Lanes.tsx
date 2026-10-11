import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { C, mono } from "../theme";
import { clamp, expo, soft } from "./motion";

/** One Monad block, in frames (~0.33 s at 30 fps): the film's clock. */
export const BLOCK = 10;

export interface Hot {
  lane: number;
  /** frame the lane lights up (scene-local) */
  at: number;
  /** frame the lane's auction is taken and the lane settles back */
  resolve: number;
  color?: string;
}

/**
 * The motif: eight thin parallel lanes (Paraclr's 8 lanes, from the logo artwork)
 * with block ticks running along them. Lanes never cross. A `hot` lane lights up,
 * runs its own auction (a marker sliding right, block by block) and resolves in
 * place while the other seven keep running.
 */
export const Lanes: React.FC<{
  x?: number; y?: number; width?: number; gap?: number; color?: string; tick?: string; opacity?: number;
  /** draw-in: lanes grow from the left, staggered, between these frames */
  drawIn?: [number, number];
  hot?: Hot[]; labels?: boolean; labelColor?: string; stroke?: number; speed?: number; fadeLeft?: boolean;
}> = ({ x = 0, y = 0, width = 1920, gap = 22, color = "rgba(255,255,255,0.22)", tick = "rgba(255,255,255,0.75)", opacity = 1,
  drawIn, hot = [], labels = false, labelColor, stroke = 2, speed = 1, fadeLeft = true }) => {
  const f = useCurrentFrame();
  const uid = React.useId().replace(/:/g, "");
  const gid = `lf${uid}`, mid = `lm${uid}`;
  const h = gap * 7;
  const lx = labels ? 64 : 0;
  const w = width - lx;
  const step = 96; // px between block ticks
  return (
    <svg width={width} height={h + 40} style={{ position: "absolute", left: x, top: y - 20, overflow: "visible", opacity }}>
      <defs>
        <linearGradient id={gid} x1="0" x2="1">
          <stop offset="0" stopColor="#fff" stopOpacity={fadeLeft ? 0 : 1} />
          <stop offset="0.12" stopColor="#fff" stopOpacity="1" />
          <stop offset="0.92" stopColor="#fff" stopOpacity="1" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id={mid} maskUnits="userSpaceOnUse" x={0} y={0} width={width} height={h + 40}><rect x={lx} y={0} width={w} height={h + 40} fill={`url(#${gid})`} /></mask>
      </defs>
      {Array.from({ length: 8 }, (_, i) => {
        const ly = 20 + i * gap;
        const d = drawIn ? interpolate(f, [drawIn[0] + i * 3, drawIn[1] + i * 3], [0, 1], { ...clamp, easing: expo }) : 1;
        const H = hot.find((q) => q.lane === i);
        const lit = H ? interpolate(f, [H.at, H.at + 6, H.resolve, H.resolve + 18], [0, 1, 1, 0], clamp) : 0;
        const hc = H?.color ?? C.warnDark;
        // ticks: one per block, travelling right; each lane has its own phase
        const off = ((f * speed * (step / BLOCK)) + i * 37) % step;
        const ticks = [];
        for (let tx = off - step; tx < w; tx += step) ticks.push(tx);
        // the hot lane's auction marker: starts at 22% of the width and slides right block by block
        const blocks = H ? Math.max(0, Math.floor((Math.min(f, H.resolve) - H.at) / BLOCK)) : 0;
        const mx = lx + w * 0.22 + blocks * 14;
        const taken = H ? interpolate(f, [H.resolve, H.resolve + 14], [0, 1], { ...clamp, easing: expo }) : 0;
        return (
          <g key={i} mask={`url(#${mid})`}>
            <line x1={lx} x2={lx + w * d} y1={ly} y2={ly} stroke={color} strokeWidth={stroke} />
            {d >= 1 && ticks.map((tx, k) => <line key={k} x1={lx + tx} x2={lx + tx + 18} y1={ly} y2={ly} stroke={tick} strokeWidth={stroke} strokeLinecap="round" />)}
            {lit > 0 && (
              <g opacity={lit}>
                <line x1={lx + w * 0.22} x2={mx} y1={ly} y2={ly} stroke={hc} strokeWidth={stroke * 2.2} strokeLinecap="round" />
                <circle cx={mx} cy={ly} r={stroke * 3.2} fill={hc} />
                <circle cx={mx} cy={ly} r={stroke * 3.2 + taken * 26} fill="none" stroke={hc} strokeWidth={1.5} opacity={1 - taken} />
              </g>
            )}
          </g>
        );
      })}
      {labels && Array.from({ length: 8 }, (_, i) => (
        <text key={i} x={0} y={20 + i * gap + 5} fontFamily={mono} fontSize={15} fill={labelColor ?? tick} letterSpacing="0.06em">L{i}</text>
      ))}
    </svg>
  );
};

/** 0..1 helper for a soft fade window. */
export const win = (f: number, a: number, b: number, fi = 12, fo = 12) => interpolate(f, [a, a + fi, b - fo, b], [0, 1, 1, 0], { ...clamp, easing: soft });
