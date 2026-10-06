"use client";

// Solvency proof, read from the clearinghouse every block while anything
// renders it (the header badge is always mounted in chain modes):
// `solvency()` plus the eight per-lane ledgers in one batch.

import { useEffect, useSyncExternalStore } from "react";
import type { Address } from "viem";
import { useParaclr } from "../store";
import { coalesce, subscribeBlocks } from "./clients";
import { readableError } from "./errors";
import { isMissingFunction, readSolvency, type SolvencySnapshot } from "./fair";

export interface SolvencyState {
  status: "idle" | "loading" | "ready" | "unsupported" | "error";
  snapshot: SolvencySnapshot | null;
  error: string | null;
}

const EMPTY: SolvencyState = { status: "idle", snapshot: null, error: null };
let state: SolvencyState = EMPTY;
const listeners = new Set<() => void>();
let refs = 0;
let stop: (() => void) | null = null;
let watching: Address | null = null;

function set(patch: Partial<SolvencyState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function start(address: Address) {
  let cancelled = false;
  watching = address;
  set({ status: "loading", snapshot: null, error: null });
  const load = coalesce(async () => {
    if (state.status === "unsupported") return;
    try {
      const snap = await readSolvency(address, lastBlock);
      if (!cancelled) set({ status: "ready", snapshot: snap, error: null });
    } catch (e) {
      if (cancelled) return;
      if (isMissingFunction(e)) set({ status: "unsupported", snapshot: null, error: null });
      // Keep the last good snapshot on a transient RPC error.
      else set({ status: state.snapshot ? "ready" : "error", error: readableError(e) });
    }
  }, 900);
  let lastBlock: number | null = null;
  const off = subscribeBlocks((b) => {
    lastBlock = Number(b);
    load();
  });
  stop = () => {
    cancelled = true;
    off();
    watching = null;
  };
}

/** Subscribe to the solvency proof while `enabled` (chain live). */
export function useSolvency(enabled: boolean): SolvencyState {
  const clearinghouse = useParaclr((s) => s.chain.contracts?.clearinghouse ?? null);
  useEffect(() => {
    if (!enabled || !clearinghouse) return;
    refs++;
    if (watching && watching !== clearinghouse) {
      stop?.();
      stop = null;
    }
    if (!stop) start(clearinghouse);
    return () => {
      refs = Math.max(0, refs - 1);
      if (refs === 0 && stop) {
        stop();
        stop = null;
      }
    };
  }, [enabled, clearinghouse]);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => EMPTY,
  );
}
