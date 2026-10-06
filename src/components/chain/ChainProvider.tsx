"use client";

import { useEffect, type ReactNode } from "react";
import { CHAIN_MODE_ON } from "@/lib/chain/config";
import { connectChain } from "@/lib/chain/runtime";
import type { DeploymentLoad } from "@/lib/chain/deployments.server";

let lastInput: { raw: unknown; loadError: string | null } = { raw: null, loadError: null };

/** Re-run the chain probe (e.g. after starting anvil / deploying). */
export function retryChainConnect() {
  void connectChain(lastInput);
}

/**
 * Receives the server-read deployment JSON and probes the chain once on the
 * client. In sim mode it does nothing.
 */
export function ChainProvider({ deployment, children }: { deployment: DeploymentLoad | null; children: ReactNode }) {
  useEffect(() => {
    if (!CHAIN_MODE_ON) return;
    lastInput = { raw: deployment?.raw ?? null, loadError: deployment?.error ?? null };
    void connectChain(lastInput);
  }, [deployment]);

  return children;
}
