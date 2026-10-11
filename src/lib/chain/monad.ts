// Monad testnet chain definition. We re-export viem's canonical definition
// (viem@2.56 `viem/chains` → monadTestnet: id 10143, RPC
// https://testnet-rpc.monad.xyz, explorer https://testnet.monadexplorer.com,
// blocks measured at ~0.35 s: MONAD_BLOCK_S in landing/content.ts) so the chain id / RPC never drift from upstream.

import { createPublicClient, http, type Address, type Hash } from "viem";
import { monadTestnet } from "viem/chains";

export { monadTestnet };

export const MONAD_CHAIN_ID = monadTestnet.id; // 10143
export const MONAD_EXPLORER_URL = monadTestnet.blockExplorers.default.url;

/** Optional RPC override (e.g. a private Monad endpoint). */
const RPC_URL = process.env.NEXT_PUBLIC_MONAD_RPC_URL || monadTestnet.rpcUrls.default.http[0];

/** Read-only client for Monad testnet. Lazily created; safe to import anywhere. */
let client: ReturnType<typeof makeClient> | null = null;
function makeClient() {
  return createPublicClient({ chain: monadTestnet, transport: http(RPC_URL) });
}
export function monadPublicClient() {
  if (!client) client = makeClient();
  return client;
}

export function explorerAddressUrl(address: Address | string): string {
  return `${MONAD_EXPLORER_URL}/address/${address}`;
}

export function explorerTxUrl(hash: Hash | string): string {
  return `${MONAD_EXPLORER_URL}/tx/${hash}`;
}
