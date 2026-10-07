"use client";

// Desktop order column: a compact, read-only account summary under the order
// form (the phone layout has the Wallet tab for this). Chain modes show what
// was read from the clearinghouse; sim mode is labelled as simulated.

import { unrealizedPnl, useParaclr } from "@/lib/store";
import { fmtAusd, fmtSigned } from "./format";
import styles from "./AccountSummary.module.css";

function Row({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" | "warn" }) {
  return (
    <div className={styles.row}>
      <dt>{label}</dt>
      <dd className={`mono ${tone ? styles[tone] : ""}`}>{value}</dd>
    </div>
  );
}

export function AccountSummary() {
  const chainLive = useParaclr((s) => s.chain.status === "ready");
  const acct = useParaclr((s) => s.chain.account);
  const free = useParaclr((s) => s.ausdBalance);
  const positions = useParaclr((s) => s.positions);
  const prices = useParaclr((s) => s.prices);

  const pnl = positions.reduce((sum, p) => sum + unrealizedPnl(p, prices[p.symbol]?.price ?? p.entryPrice), 0);
  const posMargin = positions.reduce((sum, p) => sum + p.margin, 0);
  const pnlTone = pnl > 0 ? "up" : pnl < 0 ? "down" : undefined;
  const dash = (n: number | null | undefined) => (n == null ? "—" : fmtAusd(n));

  if (chainLive) {
    const equity = acct?.equity ?? null;
    const im = acct?.initialMargin ?? null;
    const usage = equity && equity > 0 && im !== null ? Math.max(0, Math.min(1, im / equity)) : 0;
    return (
      <section className={styles.panel} aria-label="Account">
        <header className={styles.head}>
          <span>Account</span>
          <span
            className={`${styles.tag} mono`}
            title={
              acct?.estimated
                ? "Valued at the latest Pyth price: the price stored on chain is older than the contract's views accept"
                : "Read from the clearinghouse contract"
            }
          >
            {acct?.estimated ? "est. at Pyth price" : acct?.block != null ? `on-chain · #${acct.block}` : "on-chain"}
          </span>
        </header>
        <dl className={styles.list}>
          <Row label="Equity" value={acct ? dash(equity) : "…"} />
          <Row label="Unrealized PnL" value={fmtSigned(pnl)} tone={pnlTone} />
          <Row label="Free collateral" value={acct ? dash(acct.freeCollateral) : "…"} />
          <Row label="Initial margin" value={acct ? dash(im) : "…"} />
          <Row label="Maintenance margin" value={acct ? dash(acct.maintenanceMargin) : "…"} />
          <Row label="Wallet AUSD (not deposited)" value={acct ? fmtAusd(acct.walletAusd) : "…"} />
          {acct?.reservedMarginUnits !== undefined && acct.reservedMarginUnits > BigInt(0) && (
            <Row label="Escrowed by pending orders" value={fmtAusd(Number(acct.reservedMarginUnits) / 1e6)} />
          )}
        </dl>
        <div className={styles.usage} title="Initial margin / equity">
          <div className={styles.usageLabel}>
            <span>Margin usage</span>
            <span className="mono">{(usage * 100).toFixed(1)}%</span>
          </div>
          <div className={styles.bar}>
            <span style={{ width: `${usage * 100}%` }} />
          </div>
        </div>
        {acct?.healthError && <p className={styles.note}>{acct.healthError}</p>}
      </section>
    );
  }

  const equity = free + posMargin + pnl;
  const usage = equity > 0 ? Math.max(0, Math.min(1, posMargin / equity)) : 0;
  return (
    <section className={styles.panel} aria-label="Account">
      <header className={styles.head}>
        <span>Account</span>
        <span className={`${styles.tag} ${styles.sim}`}>Simulated</span>
      </header>
      <dl className={styles.list}>
        <Row label="Equity" value={fmtAusd(equity)} />
        <Row label="Unrealized PnL" value={fmtSigned(pnl)} tone={pnlTone} />
        <Row label="Free collateral" value={fmtAusd(free)} />
        <Row label="Margin in positions" value={fmtAusd(posMargin)} />
      </dl>
      <div className={styles.usage} title="Margin in positions / equity">
        <div className={styles.usageLabel}>
          <span>Margin usage</span>
          <span className="mono">{(usage * 100).toFixed(1)}%</span>
        </div>
        <div className={styles.bar}>
          <span style={{ width: `${usage * 100}%` }} />
        </div>
      </div>
    </section>
  );
}
