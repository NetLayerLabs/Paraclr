"use client";

// The collateral token as the chain reports it. Production with Agora AUSD on
// Monad mainnet shows plain "AUSD"; Agora's testnet AUSD (monad-testnet mode)
// gets a TESTNET tag; every other chain deployment (the demo MockAUSD reports
// symbol "AUSD" too) gets a visible TEST tag so a test token is never mistaken
// for the real one. Sim mode is labelled simulated elsewhere.

import { useParaclr } from "@/lib/store";
import styles from "./Prod.module.css";

export interface CollateralLabel {
  symbol: string;
  /** Chain deployment whose token isn't Agora AUSD on mainnet (no real value). */
  test: boolean;
  /** Agora's AUSD on Monad testnet: tagged TESTNET. */
  testnet: boolean;
  /** One-line description for footnotes / titles. */
  description: string;
}

export function useCollateral(): CollateralLabel {
  const token = useParaclr((s) => (s.chain.status === "ready" ? s.chain.contracts?.token ?? null : null));
  const production = useParaclr((s) => s.chain.status === "ready" && !!s.chain.contracts?.production);
  if (!token) return { symbol: "AUSD", test: false, testnet: false, description: "AUSD" };
  const test = token.test;
  return {
    symbol: token.symbol,
    test,
    testnet: token.testnet,
    description: token.testnet
      ? `Agora's testnet ${token.symbol} on Monad testnet — test funds, no real value`
      : test
        ? `test ${token.symbol}${token.name ? ` (${token.name})` : ""}${production ? " — not Agora AUSD" : ""}`
        : `Agora ${token.symbol} on Monad mainnet`,
  };
}

/** "AUSD" plus a TESTNET tag (Agora's testnet AUSD) or a TEST tag (any other test token). */
export function TokenSymbol({ className }: { className?: string }) {
  const t = useCollateral();
  return (
    <span className={className} title={t.description}>
      {t.symbol}
      {t.testnet ? (
        <span className={styles.tokenTest} data-kind="testnet">
          TESTNET
        </span>
      ) : (
        t.test && <span className={styles.tokenTest}>TEST</span>
      )}
    </span>
  );
}
