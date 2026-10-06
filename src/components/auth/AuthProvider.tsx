"use client";

import type { ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { monadTestnet } from "@/lib/chain/monad";
import { NETWORK } from "@/lib/chain/config";
import { PRIVY_APP_ID, PRIVY_CLIENT_ID, PRIVY_ENABLED } from "@/lib/auth/config";
import { AuthContext } from "./AuthContext";

const DEMO = { privyEnabled: false };
const LIVE = { privyEnabled: true };
// Embedded wallet chain follows NEXT_PUBLIC_CHAIN_MODE (anvil / Monad testnet);
// sim mode keeps Monad testnet as before.
const PRIVY_CHAIN = NETWORK?.chain ?? monadTestnet;

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
        loginMethods: ["passkey"],
        appearance: { theme: "#07060c", accentColor: "#836ef9", walletChainType: "ethereum-only" },
        defaultChain: PRIVY_CHAIN,
        supportedChains: [PRIVY_CHAIN],
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
          // The embedded wallet signs without a confirmation popup (no session
          // keys / scoped permissions are implemented).
          showWalletUIs: false,
        },
      }}
    >
      <AuthContext value={LIVE}>{children}</AuthContext>
    </PrivyProvider>
  );
}
