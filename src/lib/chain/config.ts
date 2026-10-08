// Which chain (if any) the app talks to. Resolved once from build-time env:
//
//   NEXT_PUBLIC_CHAIN_MODE = sim (default) | anvil | monad | monad-testnet | monad-mainnet
//
// `sim` is the fully in-browser simulation and never touches an RPC. In the
// chain modes, NETWORK describes the target; whether it is actually usable
// (deployment present, RPC reachable, right chain id) is decided at runtime by
// runtime.ts, and the app falls back to the simulation if it isn't - except
// the two PRODUCTION modes, which never fall back to a simulation (they fail
// closed and say why):
//   monad-mainnet  production contracts on Monad mainnet (143), real money;
//   monad-testnet  the same production contracts on Monad testnet (10143) with
//                  Agora's testnet AUSD and real Pyth: test funds, no value.
//                  With a localhost RPC it is the local sandbox (an anvil fork
//                  of Monad testnet), labelled as such everywhere.
// `monad` is the older DEMO stack on Monad testnet (MockAUSD, MockOracle).
//
// Literal `process.env.NEXT_PUBLIC_*` reads so Next inlines them.

import type { Chain } from "viem";
import { monad, monadTestnet } from "viem/chains";
import { ANVIL_CHAIN_ID, ANVIL_DEFAULT_RPC, anvilChain } from "./anvil";

export type ChainMode = "sim" | "anvil" | "monad" | "monad-testnet" | "monad-mainnet";

function parseMode(value: string | undefined): ChainMode {
  const m = (value ?? "").trim().toLowerCase();
  if (m === "monad-mainnet" || m === "mainnet") return "monad-mainnet";
  if (m === "monad-testnet" || m === "testnet") return "monad-testnet";
  return m === "anvil" || m === "monad" ? m : "sim";
}

export const CHAIN_MODE: ChainMode = parseMode(process.env.NEXT_PUBLIC_CHAIN_MODE);
/** True when a chain mode was requested (it may still fall back to sim at runtime). */
export const CHAIN_MODE_ON = CHAIN_MODE !== "sim";
/** Monad mainnet (chain 143): real AUSD, Pyth, delayed orders. */
export const MAINNET_MODE = CHAIN_MODE === "monad-mainnet";
/** Production contracts on Monad testnet (chain 10143): Agora testnet AUSD, Pyth, delayed orders. No real value. */
export const TESTNET_PROD_MODE = CHAIN_MODE === "monad-testnet";
/**
 * A production mode (mainnet or testnet): only a `"production": true`
 * deployment file is accepted and the app never falls back to a simulation.
 */
export const PRODUCTION_MODE = MAINNET_MODE || TESTNET_PROD_MODE;

export interface NetworkInfo {
  mode: "anvil" | "monad" | "monad-testnet" | "monad-mainnet";
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
  /** Monad testnet production mode (real testnet, or the local sandbox fork of it). */
  isTestnetProd: boolean;
  /** Production mode: requires `"production": true` and never falls back to the simulation. */
  requiresProduction: boolean;
  /** monad-testnet mode on a localhost RPC: the local sandbox (anvil fork of Monad testnet), not live. */
  sandbox: boolean;
  /** The RPC is on this machine (anvil, a local mainnet-fork rehearsal, or the testnet sandbox). */
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
    isTestnetProd: false,
    requiresProduction: false,
    sandbox: false,
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
    label: local ? "Monad mainnet fork - local rehearsal, not Monad" : "Monad mainnet",
    shortLabel: local ? "Mainnet fork (local)" : "Monad mainnet",
    isMonad: !local,
    isMainnet: true,
    isTestnetProd: false,
    requiresProduction: true,
    sandbox: false,
    local,
    reportNetwork: "monad-mainnet",
    nativeSymbol: monad.nativeCurrency.symbol,
    pollMs: local ? 1_000 : 500,
    keeperUrl: KEEPER_URL,
  };
}

/** Label for the local production sandbox (an anvil fork of Monad testnet). Never call it live. */
export const SANDBOX_LABEL = "Local sandbox (fork of Monad testnet) · not live";

function monadTestnetProdNetwork(): NetworkInfo {
  // Own override first (the sandbox points it at the local fork), then the
  // legacy testnet override, then the public RPC.
  const rpcUrl =
    process.env.NEXT_PUBLIC_MONAD_TESTNET_RPC_URL ||
    process.env.NEXT_PUBLIC_MONAD_RPC_URL ||
    monadTestnet.rpcUrls.default.http[0];
  const local = isLocalUrl(rpcUrl);
  // A fork of Monad testnet has Multicall3 (forked state); a bare local anvil
  // started with --chain-id 10143 may not, so a local RPC uses parallel eth_calls.
  const chain: Chain = local
    ? { ...monadTestnet, rpcUrls: { default: { http: [rpcUrl] } }, contracts: undefined }
    : { ...monadTestnet, rpcUrls: { default: { http: [rpcUrl] } } };
  return {
    mode: "monad-testnet",
    chain,
    chainId: monadTestnet.id, // 10143
    rpcUrl,
    explorerUrl: local ? null : monadTestnet.blockExplorers.default.url, // https://testnet.monadexplorer.com
    label: local ? SANDBOX_LABEL : "Monad testnet",
    shortLabel: local ? "Local sandbox" : "Monad testnet",
    isMonad: !local,
    isMainnet: false,
    isTestnetProd: true,
    requiresProduction: true,
    sandbox: local,
    local,
    reportNetwork: "monad-testnet",
    nativeSymbol: monadTestnet.nativeCurrency.symbol,
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
    label: "local anvil - not Monad",
    shortLabel: "Local anvil",
    isMonad: false,
    isMainnet: false,
    isTestnetProd: false,
    requiresProduction: false,
    sandbox: false,
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
      : CHAIN_MODE === "monad-testnet"
        ? monadTestnetProdNetwork()
        : CHAIN_MODE === "anvil"
          ? anvilNetwork()
          : null;

/** "Monad testnet" / "Local anvil - not Monad" / "Monad mainnet" / the sandbox label for pills and tags. */
export function networkName(net: NetworkInfo | null = NETWORK): string {
  if (!net) return "Simulation";
  if (net.mode === "anvil") return "Local anvil - not Monad";
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
 * API key server-side - a browser must never hold one. See prod/priceUpdate.ts.
 */
export const PYTH_HERMES_URL: string | null = process.env.NEXT_PUBLIC_PYTH_HERMES_URL
  ? process.env.NEXT_PUBLIC_PYTH_HERMES_URL.replace(/\/+$/, "")
  : null;

/** Agora AUSD on Monad mainnet (docs/PRODUCTION_PLAN.md "Fixed external facts"). */
export const AGORA_AUSD_MAINNET = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a";

/**
 * Agora AUSD on Monad testnet (Agora docs → contract deployments; checked on
 * chain 2026-10-07: symbol AUSD, 6 decimals). Test funds, no real value.
 */
export const AGORA_AUSD_TESTNET = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";

/**
 * Agora's AUSD faucet on Monad testnet. A contract, no web page (Agora's docs
 * list only the address): `requestFunds(recipient)` sends 10,000 AUSD; one
 * drip per minute across all callers; refused once the recipient holds
 * 100,000. See prod/agoraFaucet.ts.
 */
export const AGORA_AUSD_FAUCET_TESTNET = "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C";
/** Agora's developer docs page that lists the testnet AUSD + faucet addresses. */
export const AGORA_DEPLOYMENTS_DOCS = "https://docs.agora.finance/developer/contract-deployments";
/** Monad's official testnet faucet (testnet MON for gas). */
export const MONAD_TESTNET_FAUCET_URL = "https://faucet.monad.xyz";
/** Explorer for links that must point at the real testnet even from the sandbox (e.g. the faucet contract). */
export const MONAD_TESTNET_EXPLORER = monadTestnet.blockExplorers.default.url;
