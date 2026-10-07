// Which chain (if any) the app talks to. Resolved once from build-time env:
//
//   NEXT_PUBLIC_CHAIN_MODE = sim (default) | anvil | monad | monad-mainnet
//
// `sim` is the fully in-browser simulation and never touches an RPC. In the
// chain modes, NETWORK describes the target; whether it is actually usable
// (deployment present, RPC reachable, right chain id) is decided at runtime by
// runtime.ts, and the app falls back to the simulation if it isn't — except
// `monad-mainnet`, which never falls back to a simulation (real money: it
// fails closed and says why).
//
// Literal `process.env.NEXT_PUBLIC_*` reads so Next inlines them.

import type { Chain } from "viem";
import { monad, monadTestnet } from "viem/chains";
import { ANVIL_CHAIN_ID, ANVIL_DEFAULT_RPC, anvilChain } from "./anvil";

export type ChainMode = "sim" | "anvil" | "monad" | "monad-mainnet";

function parseMode(value: string | undefined): ChainMode {
  const m = (value ?? "").trim().toLowerCase();
  if (m === "monad-mainnet" || m === "mainnet") return "monad-mainnet";
  return m === "anvil" || m === "monad" ? m : "sim";
}

export const CHAIN_MODE: ChainMode = parseMode(process.env.NEXT_PUBLIC_CHAIN_MODE);
/** True when a chain mode was requested (it may still fall back to sim at runtime). */
export const CHAIN_MODE_ON = CHAIN_MODE !== "sim";
/** Monad mainnet (chain 143): real AUSD, Pyth, delayed orders. */
export const MAINNET_MODE = CHAIN_MODE === "monad-mainnet";

export interface NetworkInfo {
  mode: "anvil" | "monad" | "monad-mainnet";
  chain: Chain;
  chainId: number;
  rpcUrl: string;
  /** Block explorer base URL; null on anvil and on a local mainnet fork. */
  explorerUrl: string | null;
  /** Where on-chain numbers were measured. Never call anvil "Monad". */
  label: string;
  /** Compact label for badges and pills. */
  shortLabel: string;
  /** Executed by Monad itself (false for anvil, including a local fork of Monad mainnet). */
  isMonad: boolean;
  /** Monad mainnet mode (real or a local fork rehearsal of it). */
  isMainnet: boolean;
  /** The RPC is on this machine (anvil, or a local mainnet-fork rehearsal). */
  local: boolean;
  /** `RunReport.network` value the keeper reports for this chain. */
  reportNetwork: "anvil" | "monad-testnet" | "monad-mainnet";
  nativeSymbol: string;
  /** Block-number polling interval (ms). */
  pollMs: number;
  keeperUrl: string;
}

const KEEPER_URL = (process.env.NEXT_PUBLIC_KEEPER_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");

function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "0.0.0.0" || h === "[::1]";
  } catch {
    return false;
  }
}

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
    isMainnet: false,
    local: false,
    reportNetwork: "monad-testnet",
    nativeSymbol: monadTestnet.nativeCurrency.symbol,
    pollMs: 500,
    keeperUrl: KEEPER_URL,
  };
}

function monadMainnetNetwork(): NetworkInfo {
  const rpcUrl = process.env.NEXT_PUBLIC_MONAD_MAINNET_RPC_URL || monad.rpcUrls.default.http[0];
  const local = isLocalUrl(rpcUrl);
  // A local rehearsal (anvil fork of mainnet, or a private anvil started with
  // --chain-id 143) may not have Multicall3; parallel eth_calls are cheap there.
  const chain: Chain = local
    ? { ...monad, rpcUrls: { default: { http: [rpcUrl] } }, contracts: undefined }
    : { ...monad, rpcUrls: { default: { http: [rpcUrl] } } };
  return {
    mode: "monad-mainnet",
    chain,
    chainId: monad.id, // 143
    rpcUrl,
    explorerUrl: local ? null : monad.blockExplorers.default.url, // https://monadscan.com
    label: local ? "Monad mainnet fork — local rehearsal, not Monad" : "Monad mainnet",
    shortLabel: local ? "Mainnet fork (local)" : "Monad mainnet",
    isMonad: !local,
    isMainnet: true,
    local,
    reportNetwork: "monad-mainnet",
    nativeSymbol: monad.nativeCurrency.symbol,
    pollMs: local ? 1_000 : 500,
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
    isMainnet: false,
    local: true,
    reportNetwork: "anvil",
    nativeSymbol: chain.nativeCurrency.symbol,
    pollMs: 1_000,
    keeperUrl: KEEPER_URL,
  };
}

/** Target network for the chain modes; null in sim mode. */
export const NETWORK: NetworkInfo | null =
  CHAIN_MODE === "monad"
    ? monadNetwork()
    : CHAIN_MODE === "monad-mainnet"
      ? monadMainnetNetwork()
      : CHAIN_MODE === "anvil"
        ? anvilNetwork()
        : null;

/** "Monad testnet" / "Local anvil — not Monad" / "Monad mainnet" for pills and tags. */
export function networkName(net: NetworkInfo | null = NETWORK): string {
  if (!net) return "Simulation";
  if (net.mode === "anvil") return "Local anvil — not Monad";
  return net.label;
}

export function txUrl(hash: string): string | null {
  return NETWORK?.explorerUrl ? `${NETWORK.explorerUrl}/tx/${hash}` : null;
}

export function addressUrl(address: string): string | null {
  return NETWORK?.explorerUrl ? `${NETWORK.explorerUrl}/address/${address}` : null;
}

export function blockUrl(block: number | bigint): string | null {
  return NETWORK?.explorerUrl ? `${NETWORK.explorerUrl}/block/${block}` : null;
}

// ---- production-only settings ---------------------------------------------------

/**
 * Optional override for the Hermes-compatible base URL the production app
 * reads Pyth data from (update data for withdraw / cure / backstop calls, and
 * display prices). Default: the keeper's `/hermes` proxy, which holds the Pyth
 * API key server-side — a browser must never hold one. See prod/priceUpdate.ts.
 */
export const PYTH_HERMES_URL: string | null = process.env.NEXT_PUBLIC_PYTH_HERMES_URL
  ? process.env.NEXT_PUBLIC_PYTH_HERMES_URL.replace(/\/+$/, "")
  : null;

/** Agora AUSD on Monad mainnet (docs/PRODUCTION_PLAN.md "Fixed external facts"). */
export const AGORA_AUSD_MAINNET = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a";
