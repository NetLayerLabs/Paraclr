"use client";

// Top bar of the signed-in app. Desktop/tablet: brand, primary nav (pills),
// solvency / network / keeper status as one trust strip, theme toggle, wallet
// chip, sign out. Phone: brand + status + theme toggle (navigation is the
// bottom tab bar there).

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ParaclrLogo } from "@/components/brand/ParaclrLogo";
import { signOut, unrealizedPnl, useParaclr } from "@/lib/store";
import { shortAddress } from "@/lib/auth/demo";
import { NETWORK } from "@/lib/chain/config";
import { KeeperPill, NetworkPill } from "@/components/chain/ChainUi";
import { useAuthContext } from "@/components/auth/AuthContext";
import { PrivySignOutButton } from "@/components/auth/PrivyAuth";
import { SolvencyBadge } from "@/components/solvency/SolvencyBadge";
import { ThemeToggle } from "./theme";
import styles from "./AppShell.module.css";

export type Tab = "trade" | "clear" | "backstop" | "wallet";

export const TABS: { id: Tab; label: string }[] = [
  { id: "trade", label: "Trade" },
  { id: "clear", label: "Clearing" },
  { id: "backstop", label: "Backstop" },
  { id: "wallet", label: "Wallet" },
];

const fmtAusd = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The brand mark (8 lanes round one corner) + "Paraclr" in the display face; links to the landing page. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <Link href="/" className={className ?? styles.wordmark} title="Paraclr home" aria-label="Paraclr home">
      <ParaclrLogo tone="auto" height={26} className={styles.lockupFull} />
      <ParaclrLogo tone="auto" variant="mark" height={26} className={styles.lockupMark} />
    </Link>
  );
}

/**
 * Equity shown in the wallet chip. Chain modes: the clearinghouse's
 * collateral + uPnL read from chain. Sim: free AUSD + margin + uPnL.
 */
function useEquity(): number | null {
  const chainLive = useParaclr((s) => s.chain.status === "ready");
  const chainEquity = useParaclr((s) => s.chain.account?.equity ?? null);
  const free = useParaclr((s) => s.ausdBalance);
  const positions = useParaclr((s) => s.positions);
  const prices = useParaclr((s) => s.prices);
  if (chainLive) return chainEquity;
  return positions.reduce(
    (sum, p) => sum + p.margin + unrealizedPnl(p, prices[p.symbol]?.price ?? p.entryPrice),
    free,
  );
}

function WalletChip({ onOpen }: { onOpen: () => void }) {
  const session = useParaclr((s) => s.session);
  const chainLive = useParaclr((s) => s.chain.status === "ready");
  const equity = useEquity();
  if (!session) return null;
  const hue = Number.parseInt(session.address.slice(2, 8), 16) % 360 || 0;
  const kind =
    session.method === "passkey"
      ? "Passkey wallet"
      : chainLive
        ? NETWORK?.isMainnet
          ? "Rehearsal burner wallet (local fork)"
          : NETWORK?.isTestnetProd
            ? NETWORK.sandbox
              ? "Demo burner wallet (local sandbox)"
              : "Demo burner wallet (testnet, no real value)"
            : "Demo burner wallet"
        : "Demo account";
  return (
    <button
      type="button"
      className={styles.chip}
      onClick={onOpen}
      title={`${kind} · ${session.address}${chainLive ? " · equity in the clearinghouse (from chain)" : " · simulated equity"}`}
    >
      <span className={styles.avatar} style={{ background: `conic-gradient(from 90deg, hsl(${hue} 80% 62%), var(--accent), hsl(${(hue + 120) % 360} 70% 58%), hsl(${hue} 80% 62%))` }} aria-hidden />
      <span className={`${styles.chipAddr} mono`}>{shortAddress(session.address, 6, 4)}</span>
      <span className={styles.chipEquity}>
        <span className={styles.chipLabel}>Equity</span>
        <span className="mono">{equity === null ? "…" : fmtAusd(equity)}</span>
        <span className={styles.chipUnit}>AUSD</span>
      </span>
    </button>
  );
}

/** Copies the signed-in wallet's full address; the chip itself opens the Wallet screen. */
function CopyAddress() {
  const address = useParaclr((s) => s.session?.address ?? null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (!address) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      // No async clipboard (e.g. an insecure context): fall back to a hidden selection.
      const ta = document.createElement("textarea");
      ta.value = address;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      if (!ok) return;
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <button
      type="button"
      className={styles.copyBtn}
      onClick={copy}
      data-copied={copied || undefined}
      title={copied ? "Copied" : `Copy wallet address · ${address}`}
      aria-label={copied ? "Wallet address copied" : "Copy wallet address"}
    >
      {copied ? (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <rect x="5.25" y="5.25" width="8" height="8" rx="1.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.75 3.25v-.5a1.5 1.5 0 0 0-1.5-1.5h-5a1.5 1.5 0 0 0-1.5 1.5v5a1.5 1.5 0 0 0 1.5 1.5h.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

function SignOut() {
  const { privyEnabled } = useAuthContext();
  const method = useParaclr((s) => s.session?.method ?? null);
  if (privyEnabled && method === "passkey") return <PrivySignOutButton className={styles.signOut} />;
  return (
    <button type="button" className={styles.signOut} onClick={signOut}>
      Sign out
    </button>
  );
}

export function AppHeader({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <Wordmark />
      </div>

      <nav className={styles.nav} aria-label="Primary">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={t.id === tab ? styles.navActive : styles.navBtn}
            aria-current={t.id === tab ? "page" : undefined}
            onClick={() => onTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className={styles.status}>
        <div className={styles.trust} role="group" aria-label="Status">
          <span className={`${styles.slot} ${styles.solvencySlot}`}>
            <SolvencyBadge />
          </span>
          <span className={`${styles.slot} ${styles.netSlot}`}>
            <NetworkPill />
          </span>
          <span className={`${styles.slot} ${styles.keeperSlot}`}>
            <KeeperPill />
          </span>
        </div>
      </div>

      <ThemeToggle className={styles.themeBtn} />

      <div className={styles.account}>
        <WalletChip onOpen={() => onTab("wallet")} />
        <CopyAddress />
        <SignOut />
      </div>
    </header>
  );
}
