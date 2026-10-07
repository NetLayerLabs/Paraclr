"use client";

import { getState, signIn } from "@/lib/store";
import { demoSession } from "./demo";
import { loadOrCreateBurner } from "@/lib/chain/signer";
import { NETWORK } from "@/lib/chain/config";
import { PRIVY_ENABLED } from "./config";

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
        : NETWORK?.isTestnetProd
          ? NETWORK.sandbox
            ? "Demo burner wallet (local sandbox)"
            : "Demo burner wallet (testnet)"
          : opts.passkeySimulated
            ? "Demo burner wallet (passkey simulated)"
            : "Demo burner wallet",
    });
    return;
  }
  signIn(demoSession());
}

/**
 * Burner / demo sessions: never on a real (non-local) mainnet RPC. On the live
 * Monad testnet, Privy sign-in (passkey, email, social, wallet) replaces them;
 * a testnet deployment without Privy keeps the burner as its only way in. The
 * local sandbox, anvil and mainnet-fork rehearsals keep it (labelled).
 */
export function burnerAllowed(): boolean {
  if (NETWORK?.isMainnet && !NETWORK.local) return false;
  if (NETWORK?.isTestnetProd && !NETWORK.local && PRIVY_ENABLED) return false;
  return true;
}
