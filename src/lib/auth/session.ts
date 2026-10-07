"use client";

import { getState, signIn } from "@/lib/store";
import { demoSession } from "./demo";
import { loadOrCreateBurner } from "@/lib/chain/signer";
import { NETWORK } from "@/lib/chain/config";

/**
 * "Try demo mode". With the chain live, the demo account is a real burner
 * wallet generated in (and stored by) this browser; otherwise it's the
 * in-memory simulated account, exactly as in sim mode.
 */
export function startDemoSession(opts: { passkeySimulated?: boolean } = {}) {
  // Real mainnet: never a browser burner key (it would hold real money in
  // localStorage). A local mainnet-fork rehearsal may use one.
  if (!burnerAllowed()) return;
  if (getState().chain.status === "ready") {
    const key = loadOrCreateBurner();
    const rehearsal = NETWORK?.isMainnet === true;
    signIn({
      address: key.address,
      method: "demo",
      displayName: rehearsal
        ? "Rehearsal burner wallet (local fork)"
        : opts.passkeySimulated
          ? "Demo burner wallet (passkey simulated)"
          : "Demo burner wallet",
    });
    return;
  }
  signIn(demoSession());
}

/** Burner / demo sessions are allowed everywhere except a real (non-local) mainnet RPC. */
export function burnerAllowed(): boolean {
  return !(NETWORK?.isMainnet && !NETWORK.local);
}
