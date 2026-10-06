"use client";

import { getState, signIn } from "@/lib/store";
import { demoSession } from "./demo";
import { loadOrCreateBurner } from "@/lib/chain/signer";

/**
 * "Try demo mode". With the chain live, the demo account is a real burner
 * wallet generated in (and stored by) this browser; otherwise it's the
 * in-memory simulated account, exactly as in sim mode.
 */
export function startDemoSession(opts: { passkeySimulated?: boolean } = {}) {
  if (getState().chain.status === "ready") {
    const key = loadOrCreateBurner();
    signIn({
      address: key.address,
      method: "demo",
      displayName: opts.passkeySimulated ? "Demo burner wallet (passkey simulated)" : "Demo burner wallet",
    });
    return;
  }
  signIn(demoSession());
}
