"use client";

// Mounted once by AppShell. In chain modes it:
//   - registers the demo burner as the signer for demo sessions
//     (passkey sessions are bridged by <PrivyWalletBridge/>);
//   - re-reads the signed-in account on new blocks (throttled);
//   - calls the keeper faucet once per address after sign-in if unfunded
//     (never on the production contracts: there is no faucet there);
//   - production: re-reads pause flag / caps / funding and reconciles the
//     account's delayed orders on new blocks;
//   - polls keeper /health.
// In sim mode every effect is a no-op.

import { useEffect, useRef } from "react";
import type { Address } from "viem";
import { setChain, setChainWallet, setProd, useParaclr } from "@/lib/store";
import { coalesce, subscribeBlockErrors, subscribeBlocks } from "@/lib/chain/clients";
import { readableError } from "@/lib/chain/errors";
import { checkKeeper } from "@/lib/chain/runtime";
import { clearTxs } from "@/lib/chain/txs";
import { burnerSigner, loadOrCreateBurner, setSigner } from "@/lib/chain/signer";
import { refreshAccount, requestFaucet } from "@/lib/chain/trading";
import { refreshProd } from "@/lib/chain/prod/actions";
import { loadOrders, reconcileOrders, tickOrderPhases } from "@/lib/chain/prod/orders";

export function ChainSync() {
  const status = useParaclr((s) => s.chain.status);
  const address = useParaclr((s) => s.session?.address ?? null);
  const method = useParaclr((s) => s.session?.method ?? null);
  const production = useParaclr((s) => s.chain.status === "ready" && !!s.chain.contracts?.production);
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

  // Production: pause flag, caps, funding and the account's delayed orders.
  useEffect(() => {
    if (!production) {
      setProd(null);
      return;
    }
    loadOrders(address);
    // State first (it carries the account's pending order ids), then the orders.
    const sync = coalesce(async () => {
      await refreshProd();
      await reconcileOrders();
    }, 1_000);
    const off = subscribeBlocks(() => sync());
    // Countdowns cross the order window boundaries between blocks too.
    const tick = setInterval(tickOrderPhases, 500);
    return () => {
      off();
      clearInterval(tick);
    };
  }, [production, address]);

  // Auto-faucet once per address per page load (skipped if already funded).
  // Never on the production contracts.
  const fauceted = useRef(new Set<string>());
  useEffect(() => {
    if (!live || !address || production) return;
    const key = address.toLowerCase();
    if (fauceted.current.has(key)) return;
    fauceted.current.add(key);
    void requestFaucet(address as Address, { onlyIfLow: true });
  }, [live, address, production]);

  // Keeper health.
  useEffect(() => {
    if (!live) return;
    void checkKeeper();
    const id = setInterval(() => void checkKeeper(), 10_000);
    return () => clearInterval(id);
  }, [live]);

  return null;
}
