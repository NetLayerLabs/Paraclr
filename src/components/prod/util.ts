"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

export const SLIPPAGE_CHOICES = [0.3, 0.5, 1];
const SLIP_KEY = "paraclr.slippagePct";
const DEFAULT_SLIP = 0.5;

let slipCache: number | null = null;
const slipListeners = new Set<() => void>();

function readSlip(): number {
  if (slipCache !== null) return slipCache;
  try {
    const v = Number.parseFloat(window.localStorage.getItem(SLIP_KEY) ?? "");
    slipCache = v > 0 && v <= 5 ? v : DEFAULT_SLIP;
  } catch {
    slipCache = DEFAULT_SLIP;
  }
  return slipCache;
}

function writeSlip(v: number) {
  slipCache = v;
  try {
    window.localStorage.setItem(SLIP_KEY, String(v));
  } catch {
    /* storage blocked: this page load only */
  }
  slipListeners.forEach((l) => l());
}

/** Slippage tolerance in percent, shared by every order form and remembered in this browser. */
export function useSlippage(): [number, (v: number) => void] {
  const slip = useSyncExternalStore(
    (l) => {
      slipListeners.add(l);
      return () => slipListeners.delete(l);
    },
    readSlip,
    () => DEFAULT_SLIP,
  );
  return [slip, writeSlip];
}

/** "45s", "2m 05s", "1h 20m". */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/** Re-render every `ms` (countdowns). */
export function useNow(ms = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
