"use client";

// Auction parameters read once per connection from the clearinghouse
// (owner-configurable; plan defaults until the read lands).

import { useEffect, useSyncExternalStore } from "react";
import type { Address } from "viem";
import { useParaclr } from "../store";
import { DEFAULT_CHAIN_PARAMS, readAuctionParams, type ChainAuctionParams } from "./fair";

let params: ChainAuctionParams = DEFAULT_CHAIN_PARAMS;
let loadedFor: Address | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load(address: Address) {
  if (loadedFor === address || loading) return;
  loading = readAuctionParams(address)
    .then((p) => {
      params = p;
      loadedFor = address;
      listeners.forEach((l) => l());
    })
    .catch(() => {
      /* pre-auction deployment or RPC hiccup: keep the plan defaults */
    })
    .finally(() => {
      loading = null;
    });
}

/** On-chain auction parameters (plan defaults until read). */
export function useAuctionParams(): ChainAuctionParams {
  const live = useParaclr((s) => s.chain.status === "ready");
  const clearinghouse = useParaclr((s) => s.chain.contracts?.clearinghouse ?? null);
  useEffect(() => {
    if (live && clearinghouse) load(clearinghouse);
  }, [live, clearinghouse]);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => params,
    () => DEFAULT_CHAIN_PARAMS,
  );
}
