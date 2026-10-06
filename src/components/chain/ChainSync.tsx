"use client";

// Mounted once by AppShell. In chain modes it:
//   - registers the demo burner as the signer for demo sessions
//     (passkey sessions are bridged by <PrivyWalletBridge/>);
//   - re-reads the signed-in account on new blocks (throttled);
//   - calls the keeper faucet once per address after sign-in if unfunded;
//   - polls keeper /health.
// In sim mode every effect is a no-op.

import { useEffect, useRef } from "react";
import type { Address } from "viem";
import { setChain, setChainWallet, useParaclr } from "@/lib/store";
import { coalesce, subscribeBlockErrors, subscribeBlocks } from "@/lib/chain/clients";
import { readableError } from "@/lib/chain/errors";
import { checkKeeper } from "@/lib/chain/runtime";
import { clearTxs } from "@/lib/chain/txs";
import { burnerSigner, loadOrCreateBurner, setSigner } from "@/lib/chain/signer";
import { refreshAccount, requestFaucet } from "@/lib/chain/trading";

export function ChainSync() {
  const status = useParaclr((s) => s.chain.status);
  const address = useParaclr((s) => s.session?.address ?? null);
  const method = useParaclr((s) => s.session?.method ?? null);
  const live = status === "ready";

  // Signer for demo sessions (burner). Cleared on sign-out.
  useEffect(() => {
    if (!address) {
      setSigner(null);
      clearTxs(); // don't show the previous account's transactions
      return;
    }
    if (!live || method !== "demo") return;
    const key = loadOrCreateBurner();
    if (key.address.toLowerCase() !== address.toLowerCase()) {
      setChainWallet({ kind: "burner", address, ready: false, error: "This session's burner key isn't in this browser." });
      return;
    }
    setSigner(burnerSigner(key));
    setChainWallet({ kind: "burner", address: key.address, ready: true, error: null, persisted: key.persisted });
  }, [live, address, method]);

  // Block height + RPC health, and account refresh on new blocks.
  useEffect(() => {
    if (!live) return;
    const refresh = coalesce(async () => {
      await refreshAccount();
    }, 1_000);
    const offBlocks = subscribeBlocks((b) => {
      setChain({ block: Number(b) });
      if (address) refresh();
    });
    const offErrors = subscribeBlockErrors((e) =>
      setChain({ rpcError: e ? `RPC error: ${readableError(e)}` : null }),
    );
    return () => {
      offBlocks();
      offErrors();
    };
  }, [live, address]);

  // Auto-faucet once per address per page load (skipped if already funded).
  const fauceted = useRef(new Set<string>());
  useEffect(() => {
    if (!live || !address) return;
    const key = address.toLowerCase();
    if (fauceted.current.has(key)) return;
    fauceted.current.add(key);
    void requestFaucet(address as Address, { onlyIfLow: true });
  }, [live, address]);

  // Keeper health.
  useEffect(() => {
    if (!live) return;
    void checkKeeper();
    const id = setInterval(() => void checkKeeper(), 10_000);
    return () => clearInterval(id);
  }, [live]);

  return null;
}
