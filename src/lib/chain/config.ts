// Which chain (if any) the app talks to. Resolved once from build-time env:
//
//   NEXT_PUBLIC_CHAIN_MODE = sim (default) | anvil | monad
//
// `sim` is the fully in-browser simulation and never touches an RPC. In the
// chain modes, NETWORK describes the target; whether it is actually usable
// (deployment present, RPC reachable, right chain id) is decided at runtime by
// runtime.ts, and the app falls back to the simulation if it isn't.
//
// Literal `process.env.NEXT_PUBLIC_*` reads so Next inlines them.

import type { Chain } from "viem";
import { monadTestnet } from "viem/chains";
import { ANVIL_CHAIN_ID, ANVIL_DEFAULT_RPC, anvilChain } from "./anvil";

export type ChainMode = "sim" | "anvil" | "monad";

function parseMode(value: string | undefined): ChainMode {
  const m = (value ?? "").trim().toLowerCase();
  return m === "anvil" || m === "monad" ? m : "sim";
}

export const CHAIN_MODE: ChainMode = parseMode(process.env.NEXT_PUBLIC_CHAIN_MODE);
/** True when a chain mode was requested (it may still fall back to sim at runtime). */
export const CHAIN_MODE_ON = CHAIN_MODE !== "sim";

export interface NetworkInfo {
  mode: "anvil" | "monad";
  chain: Chain;
  chainId: number;
  rpcUrl: string;
  /** Block explorer base URL; null on anvil. */
  explorerUrl: string | null;
  /** Where on-chain numbers were measured. Never call anvil "Monad". */
  label: string;
  /** Compact label for badges. */
  shortLabel: string;
  isMonad: boolean;
  /** `RunReport.network` value the keeper reports for this chain. */
  reportNetwork: "anvil" | "monad-testnet";
  nativeSymbol: string;
  /** Block-number polling interval (ms). */
  pollMs: number;
  keeperUrl: string;
}

const KEEPER_URL = (process.env.NEXT_PUBLIC_KEEPER_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");

function monadNetwork(): NetworkInfo {
  const rpcUrl = process.env.NEXT_PUBLIC_MONAD_RPC_URL || monadTestnet.rpcUrls.default.http[0];
  const chain: Chain = { ...monadTestnet, rpcUrls: { default: { http: [rpcUrl] } } };
  return {
    mode: "monad",
    chain,
    chainId: monadTestnet.id,
    rpcUrl,
    explorerUrl: monadTestnet.blockExplorers.default.url,
    label: "Monad testnet",
    shortLabel: "Monad testnet",
    isMonad: true,
    reportNetwork: "monad-testnet",
    nativeSymbol: monadTestnet.nativeCurrency.symbol,
    pollMs: 500,
    keeperUrl: KEEPER_URL,
  };
}

function anvilNetwork(): NetworkInfo {
  const rpcUrl = process.env.NEXT_PUBLIC_ANVIL_RPC_URL || ANVIL_DEFAULT_RPC;
  const chain = anvilChain(rpcUrl);
  return {
    mode: "anvil",
    chain,
    chainId: ANVIL_CHAIN_ID,
    rpcUrl,
    explorerUrl: null,
    label: "local anvil — not Monad",
    shortLabel: "Local anvil",
    isMonad: false,
    reportNetwork: "anvil",
    nativeSymbol: chain.nativeCurrency.symbol,
    pollMs: 1_000,
    keeperUrl: KEEPER_URL,
  };
}

/** Target network for the chain modes; null in sim mode. */
export const NETWORK: NetworkInfo | null =
  CHAIN_MODE === "monad" ? monadNetwork() : CHAIN_MODE === "anvil" ? anvilNetwork() : null;

export function txUrl(hash: string): string | null {
  return NETWORK?.explorerUrl ? `${NETWORK.explorerUrl}/tx/${hash}` : null;
}

export function addressUrl(address: string): string | null {
  return NETWORK?.explorerUrl ? `${NETWORK.explorerUrl}/address/${address}` : null;
}

export function blockUrl(block: number | bigint): string | null {
  return NETWORK?.explorerUrl ? `${NETWORK.explorerUrl}/block/${block}` : null;
}
