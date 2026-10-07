// Who signs chain-mode transactions.
//
//   passkey → Privy embedded wallet, via its EIP-1193 provider (registered by
//             <PrivyWalletBridge/>, which lives under PrivyProvider);
//   demo    → a burner key generated in this browser and kept in localStorage,
//             always labelled "Demo burner wallet" in the UI.

import { rateLimitedFetch } from "./clients";
import {
  createWalletClient,
  custom,
  http,
  type Account,
  type Address,
  type Chain,
  type EIP1193Provider,
  type Hex,
  type Transport,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NETWORK } from "./config";

export type ChainWalletClient = WalletClient<Transport, Chain, Account>;

export interface ChainSigner {
  kind: "privy" | "burner";
  address: Address;
  walletClient(): Promise<ChainWalletClient>;
}

let current: ChainSigner | null = null;

export function setSigner(signer: ChainSigner | null) {
  current = signer;
}

export function getSigner(): ChainSigner | null {
  return current;
}

// ---- burner ----------------------------------------------------------------

const BURNER_KEY = (chainId: number) => `paraclr.burner.v1.${chainId}`;

export interface BurnerKey {
  privateKey: Hex;
  address: Address;
  /** False when localStorage is unavailable (key lives only in memory). */
  persisted: boolean;
}

let memoryBurner: BurnerKey | null = null;

/** Load this browser's burner for the active chain, creating one if needed. */
export function loadOrCreateBurner(): BurnerKey {
  const chainId = NETWORK?.chainId ?? 0;
  try {
    const stored = window.localStorage.getItem(BURNER_KEY(chainId));
    if (stored && /^0x[0-9a-fA-F]{64}$/.test(stored)) {
      const pk = stored as Hex;
      return { privateKey: pk, address: privateKeyToAccount(pk).address, persisted: true };
    }
    const pk = generatePrivateKey();
    window.localStorage.setItem(BURNER_KEY(chainId), pk);
    return { privateKey: pk, address: privateKeyToAccount(pk).address, persisted: true };
  } catch {
    if (!memoryBurner) {
      const pk = generatePrivateKey();
      memoryBurner = { privateKey: pk, address: privateKeyToAccount(pk).address, persisted: false };
    }
    return memoryBurner;
  }
}

export function burnerSigner(key: BurnerKey): ChainSigner {
  if (!NETWORK) throw new Error("No chain configured");
  const net = NETWORK;
  const account = privateKeyToAccount(key.privateKey);
  let wc: ChainWalletClient | null = null;
  return {
    kind: "burner",
    address: account.address,
    walletClient: async () => {
      if (!wc) wc = createWalletClient({ account, chain: net.chain, transport: http(net.rpcUrl, { fetchFn: rateLimitedFetch }) });
      return wc;
    },
  };
}

// ---- Privy embedded wallet ---------------------------------------------------

/** The subset of Privy's ConnectedWallet we use (keeps this module Privy-free). */
export interface Eip1193Wallet {
  address: string;
  chainId: string; // CAIP-2, e.g. "eip155:10143"
  switchChain(chainId: number): Promise<void>;
  getEthereumProvider(): Promise<{ request(args: { method: string; params?: unknown[] }): Promise<unknown> }>;
}

export function privySigner(wallet: Eip1193Wallet): ChainSigner {
  if (!NETWORK) throw new Error("No chain configured");
  const net = NETWORK;
  let wc: ChainWalletClient | null = null;
  return {
    kind: "privy",
    address: wallet.address as Address,
    walletClient: async () => {
      if (wallet.chainId !== `eip155:${net.chainId}`) {
        // Per Privy: switch first, then (re-)request the provider.
        await wallet.switchChain(net.chainId);
        wc = null;
      }
      if (!wc) {
        const provider = (await wallet.getEthereumProvider()) as unknown as EIP1193Provider;
        wc = createWalletClient({
          account: wallet.address as Address,
          chain: net.chain,
          transport: custom(provider),
        }) as unknown as ChainWalletClient;
      }
      return wc;
    },
  };
}
