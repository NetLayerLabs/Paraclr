import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { clamp, expo } from "./motion";
import { num } from "./format";

/** A figure that counts from `from` to its real value between frames `at` and `at + dur`. */
export const Count: React.FC<{ to: number; from?: number; at: number; dur?: number; decimals?: number; prefix?: string; suffix?: string; style?: React.CSSProperties }> = ({ to, from = 0, at, dur = 36, decimals = 0, prefix = "", suffix = "", style }) => {
  const f = useCurrentFrame();
  const v = interpolate(f, [at, at + dur], [from, to], { ...clamp, easing: expo });
  // lands exactly on `to` at the end of the count
  return <span style={{ fontVariantNumeric: "tabular-nums", ...style }}>{prefix}{num(f >= at + dur ? to : v, decimals)}{suffix}</span>;
};
