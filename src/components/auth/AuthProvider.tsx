"use client";

import type { ReactNode } from "react";
import { PrivyProvider, addRpcUrlOverrideToChain } from "@privy-io/react-auth";
import { monadTestnet } from "@/lib/chain/monad";
import { MAINNET_MODE, NETWORK } from "@/lib/chain/config";
import { PRIVY_APP_ID, PRIVY_CLIENT_ID, PRIVY_ENABLED } from "@/lib/auth/config";
import { AuthContext } from "./AuthContext";

const DEMO = { privyEnabled: false };
const LIVE = { privyEnabled: true };
// Embedded wallet chain follows NEXT_PUBLIC_CHAIN_MODE (anvil / Monad testnet
// 10143 / Monad mainnet 143); sim mode keeps Monad testnet as before.
//
// RPC: Privy's embedded-wallet provider runs in this page - it fills nonce /
// gas and broadcasts through a viem client of its own, and only the signature
// comes from Privy's iframe. Its URL resolution is
// `rpcUrls.privyWalletOverride` → `rpcUrls.privy` (Privy's hosted RPC, which it
// injects for chains it knows, e.g. Monad mainnet) → `rpcUrls.default`. So the
// app's RPC is pinned as `privyWalletOverride`: transactions go where the app
// reads, including a localhost fork (the testnet sandbox, a mainnet-fork
// rehearsal) - otherwise a known chain's transactions would go to the real
// network's RPC instead of the fork.
const PRIVY_CHAIN = NETWORK ? addRpcUrlOverrideToChain(NETWORK.chain, NETWORK.rpcUrl) : monadTestnet;
// Real money: on mainnet every transaction shows Privy's confirmation UI.
// Demo chains keep the popup-free flow they were built with.
const SHOW_WALLET_UIS = MAINNET_MODE;

/**
 * Wraps the app with Privy (passkey login + embedded wallet on the active
 * chain) when NEXT_PUBLIC_PRIVY_APP_ID is set; otherwise renders children in
 * demo mode.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  if (!PRIVY_ENABLED) {
    return <AuthContext value={DEMO}>{children}</AuthContext>;
  }

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      clientId={PRIVY_CLIENT_ID}
      config={{
        // Passkey is the primary button; email, social accounts and external wallets open in
        // Privy's modal. A method also has to be enabled in the Privy dashboard to show there.
        loginMethods: ["passkey", "email", "google", "twitter", "discord", "github", "wallet"],
        appearance: { theme: "#08070D", accentColor: "#6E54FF", walletChainType: "ethereum-only" },
        defaultChain: PRIVY_CHAIN,
        supportedChains: [PRIVY_CHAIN],
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
          // Demo chains: the embedded wallet signs without a confirmation popup
          // (no session keys / scoped permissions are implemented). Mainnet:
          // confirmation UIs on.
          showWalletUIs: SHOW_WALLET_UIS,
        },
      }}
    >
      <AuthContext value={LIVE}>{children}</AuthContext>
    </PrivyProvider>
  );
}
