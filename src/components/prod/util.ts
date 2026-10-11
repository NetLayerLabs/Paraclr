"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useParaclr } from "@/lib/store";
import { STALE_FOR_ORDERS_MS } from "@/lib/chain/prod/pythPrices";

/**
 * Testnet after the Pyth data trial: the clearinghouse reads the keeper-signed
 * fallback oracle (contracts/src/testnet/KeeperSignedPyth.sol), so prices are
 * signed by the Paraclr keeper and NOT attested by Pyth. Copy must say so.
 */
export function useKeeperSigned(): boolean {
  return useParaclr((s) => s.chain.contracts?.oracleKind === "keeper-signed");
}

/** "Pyth price", or "keeper-signed price" after the testnet switch. */
export function usePriceName(): string {
  return useKeeperSigned() ? "keeper-signed price" : "Pyth price";
}

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

/** "45 s", "2 min 05 s", "1 h 20 min" (src/lib/format.ts). */
export { fmtDuration } from "@/lib/format";

/** Re-render every `ms` (countdowns). */
export function useNow(ms = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * True while the newest price for a market is older than STALE_FOR_ORDERS_MS (or missing), checked
 * every second. Used to hold orders and closes until the live feed is back.
 */
export function usePriceStale(observedAt: number | null | undefined): boolean {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const check = () => setStale(!observedAt || Date.now() - observedAt > STALE_FOR_ORDERS_MS);
    check();
    const id = setInterval(check, 1_000);
    return () => clearInterval(id);
  }, [observedAt]);
  return stale;
}
