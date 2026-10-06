// Local anvil chain definition (dev & CI). Kept alongside monad.ts so every
// chain-mode module picks its chain from one place (see config.ts).
//
// Anvil numbers are NEVER Monad numbers: anything measured here must be
// labelled "local anvil — not Monad" (NETWORK.label does that).

import { defineChain } from "viem";

export const ANVIL_CHAIN_ID = 31_337;
export const ANVIL_DEFAULT_RPC = "http://127.0.0.1:8545";

export function anvilChain(rpcUrl: string = ANVIL_DEFAULT_RPC) {
  return defineChain({
    id: ANVIL_CHAIN_ID,
    name: "Anvil (local)",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    testnet: true,
  });
}
