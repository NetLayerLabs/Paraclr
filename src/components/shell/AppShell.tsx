"use client";

import { useState } from "react";
import { BuiltByBadge } from "@/components/brand/BuiltByBadge";
import { useParaclr } from "@/lib/store";
import { LoginScreen } from "@/components/auth/LoginScreen";
import { TradeScreen } from "@/components/trade/TradeScreen";
import { ClearingScreen } from "@/components/clearing/ClearingScreen";
import { WalletScreen } from "@/components/auth/WalletScreen";
import { BackstopScreen } from "@/components/backstop/BackstopScreen";
import { PriceFeedProvider } from "@/components/trade/PriceFeedProvider";
import { useAuthContext } from "@/components/auth/AuthContext";
import { PrivyWalletBridge } from "@/components/auth/PrivyAuth";
import { ChainSync } from "@/components/chain/ChainSync";
import { ChainStatusStrip } from "@/components/chain/ChainUi";
import { BetaBanner, MainnetUnavailable, PausedBanner, RiskAckModal } from "@/components/prod/ProdChrome";
import { MAINNET_MODE } from "@/lib/chain/config";
import type { RecordedXray } from "@/lib/chain/xray.server";
import { AppHeader, TABS, type Tab } from "./AppHeader";
import { ThemeSync } from "./theme";
import styles from "./AppShell.module.css";

/**
 * Full-viewport responsive app (no device frame): header + optional status
 * banner + the active screen; on phones a bottom tab bar replaces the header nav.
 */
export function AppShell({ recordedXray = null }: { recordedXray?: RecordedXray | null }) {
  const session = useParaclr((s) => s.session);
  const chainStatus = useParaclr((s) => s.chain.status);
  const [tab, setTab] = useState<Tab>("trade");
  const { privyEnabled } = useAuthContext();
  // Mainnet never falls back to the simulation: a blocking screen says why.
  const mainnetDown = MAINNET_MODE && chainStatus !== "ready";

  return (
    <div className={styles.app}>
      <ThemeSync />
      <PriceFeedProvider />
      <ChainSync />
      {privyEnabled && <PrivyWalletBridge />}
      <RiskAckModal />
      {mainnetDown ? (
        <>
          <BetaBanner />
          <MainnetUnavailable />
          <AppFooter />
        </>
      ) : !session ? (
        <>
          <BetaBanner />
          <ChainStatusStrip />
          <LoginScreen />
          <AppFooter />
        </>
      ) : (
        <>
          <AppHeader tab={tab} onTab={setTab} />
          <BetaBanner />
          <PausedBanner />
          <ChainStatusStrip />
          {/* Screens stay mounted so a clearing run survives a tab switch. */}
          <main className={styles.screen} data-tab="trade" hidden={tab !== "trade"}>
            <TradeScreen />
            <AppFooter />
          </main>
          <main className={styles.screen} data-tab="clear" hidden={tab !== "clear"}>
            <ClearingScreen active={tab === "clear"} recordedXray={recordedXray} />
            <AppFooter />
          </main>
          <main className={styles.screen} data-tab="backstop" hidden={tab !== "backstop"}>
            <BackstopScreen active={tab === "backstop"} />
            <AppFooter />
          </main>
          <main className={styles.screen} data-tab="wallet" hidden={tab !== "wallet"}>
            <WalletScreen />
            <AppFooter />
          </main>
          <nav className={styles.tabbar} aria-label="Primary">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={t.id === tab ? styles.tabActive : styles.tab}
                aria-current={t.id === tab ? "page" : undefined}
                onClick={() => setTab(t.id)}
              >
                <TabIcon id={t.id} />
                {t.label}
              </button>
            ))}
          </nav>
        </>
      )}
    </div>
  );
}

/** Shared app footer: the NetLayer Labs attribution at the end of each screen. */
function AppFooter() {
  return (
    <footer className={styles.appFooter}>
      <BuiltByBadge />
    </footer>
  );
}

function TabIcon({ id }: { id: Tab }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (id === "trade") {
    return (
      <svg {...common}>
        <path d="M7 4v16M17 4v16" />
        <rect x="4.5" y="8" width="5" height="7" rx="1" />
        <rect x="14.5" y="6" width="5" height="9" rx="1" />
      </svg>
    );
  }
  if (id === "clear") {
    return (
      <svg {...common}>
        <path d="M4 6h16M4 10h12M4 14h16M4 18h9" />
      </svg>
    );
  }
  if (id === "backstop") {
    return (
      <svg {...common}>
        <path d="M12 3.5l7 2.8v5.3c0 4.3-2.9 7.9-7 8.9-4.1-1-7-4.6-7-8.9V6.3l7-2.8z" />
        <path d="M8.5 12.5h7M12 9v7" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="3.5" y="6" width="17" height="13" rx="2.5" />
      <path d="M3.5 10h17M16 14.5h1.5" />
    </svg>
  );
}
