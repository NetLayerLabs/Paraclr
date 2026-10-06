"use client";

// Top bar of the signed-in app. Desktop/tablet: brand, primary nav, network +
// keeper status, wallet chip, sign out. Phone: brand + network status only
// (navigation is the bottom tab bar there).

import Link from "next/link";
import { signOut, unrealizedPnl, useParaclr } from "@/lib/store";
import { shortAddress } from "@/lib/auth/demo";
import { KeeperPill, NetworkPill } from "@/components/chain/ChainUi";
import { useAuthContext } from "@/components/auth/AuthContext";
import { PrivySignOutButton } from "@/components/auth/PrivyAuth";
import { SolvencyBadge } from "@/components/solvency/SolvencyBadge";
import styles from "./AppShell.module.css";

export type Tab = "trade" | "clear" | "backstop" | "wallet";

export const TABS: { id: Tab; label: string }[] = [
  { id: "trade", label: "Trade" },
  { id: "clear", label: "Clearing" },
  { id: "backstop", label: "Backstop" },
  { id: "wallet", label: "Wallet" },
];

const fmtAusd = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function BackHome({ className }: { className?: string }) {
  return (
    <Link href="/" className={className ?? styles.home} title="Back to home" aria-label="Back to home">
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
        <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className={styles.homeText}>Home</span>
    </Link>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className ?? styles.wordmark}>
      para<span>clr</span>
    </span>
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
  const kind = session.method === "passkey" ? "Passkey wallet" : chainLive ? "Demo burner wallet" : "Demo account";
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
        <BackHome />
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
        <span className={styles.solvencySlot}>
          <SolvencyBadge />
        </span>
        <span className={styles.netSlot}>
          <NetworkPill />
        </span>
        <span className={styles.keeperSlot}>
          <KeeperPill />
        </span>
      </div>

      <div className={styles.account}>
        <WalletChip onOpen={() => onTab("wallet")} />
        <SignOut />
      </div>
    </header>
  );
}
