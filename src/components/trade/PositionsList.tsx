"use client";

import { useState, type CSSProperties } from "react";
import type { Position } from "@/lib/types";
import { closePosition, liquidationPrice, unrealizedPnl, useParaclr } from "@/lib/store";
import { readableError } from "@/lib/chain/errors";
import { closePositionOnChain } from "@/lib/chain/trading";
import { Notice } from "@/components/chain/ChainUi";
import { MQ_FINE_POINTER, MQ_TABLE, useMedia } from "@/components/shell/useMedia";
import { baseOf, fmtAusd, fmtPct, fmtPrice, fmtSigned, fmtSize } from "./format";
import styles from "./PositionsList.module.css";

export interface ClosedMeta {
  block?: number;
}

type OnClosed = (p: Position, realized: number, meta?: ClosedMeta) => void;

/** Everything one position row/card shows, plus its close action. */
function usePositionModel(p: Position, onClosed: OnClosed) {
  const mark = useParaclr((s) => s.prices[p.symbol]?.price ?? p.entryPrice);
  const chainLive = useParaclr((s) => s.chain.status === "ready");
  const walletReady = useParaclr((s) => s.chain.wallet.ready);
  const inAuction = useParaclr((s) => s.chain.status === "ready" && (s.chain.account?.auction?.active ?? false));
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pnl = unrealizedPnl(p, mark);
  const roe = (pnl / p.margin) * 100;
  const liq = liquidationPrice(p);
  // 1 = at entry, 0 = at liquidation.
  const health = Math.max(0, Math.min(1, (mark - liq) / (p.entryPrice - liq || 1)));
  const liquidatable = health <= 0;

  const close = async () => {
    if (!chainLive) {
      closePosition(p.id);
      onClosed(p, Math.max(-p.margin, pnl));
      return;
    }
    setError(null);
    setClosing(true);
    try {
      const r = await closePositionOnChain(p.symbol);
      onClosed(p, r.realizedPnl, { block: r.block });
    } catch (e) {
      setError(readableError(e));
    } finally {
      setClosing(false);
    }
  };

  return {
    mark,
    pnl,
    roe,
    liq,
    health,
    liquidatable,
    up: pnl >= 0,
    closing,
    error,
    close,
    inAuction,
    closeDisabled: closing || (chainLive && !walletReady) || inAuction,
  };
}

function HealthBar({ health }: { health: number }) {
  return (
    <div className={styles.healthBar}>
      <div className={styles.healthFill} style={{ "--h": health } as CSSProperties} />
    </div>
  );
}

/** Phones / narrow screens: one card per position. */
function PositionCard({ p, onClosed }: { p: Position; onClosed: OnClosed }) {
  const m = usePositionModel(p, onClosed);

  return (
    <article className={`${styles.card} ${m.liquidatable ? styles.cardLiq : ""}`}>
      <div className={styles.top}>
        <div className={styles.ident}>
          <span className={p.side === "long" ? styles.badgeLong : styles.badgeShort}>
            {p.side === "long" ? "LONG" : "SHORT"} {p.leverage}x
          </span>
          <span className={styles.sym}>
            {baseOf(p.symbol)}
            <span className={styles.symQuote}>/AUSD</span>
          </span>
        </div>
        <div className={`${styles.pnl} ${m.up ? styles.up : styles.down}`}>
          <span className="mono">{fmtSigned(m.pnl)}</span>
          <span className={`mono ${styles.roe}`}>{fmtPct(m.roe)}</span>
        </div>
      </div>

      <dl className={styles.grid}>
        <div>
          <dt>Size</dt>
          <dd className="mono">
            {fmtSize(p.symbol, p.size)} {baseOf(p.symbol)}
          </dd>
        </div>
        <div>
          <dt>Entry</dt>
          <dd className="mono">{fmtPrice(p.symbol, p.entryPrice)}</dd>
        </div>
        <div>
          <dt>Mark</dt>
          <dd className="mono">{fmtPrice(p.symbol, m.mark)}</dd>
        </div>
        <div>
          <dt>Margin</dt>
          <dd className="mono">{fmtAusd(p.margin)}</dd>
        </div>
        <div>
          <dt>Liq. price</dt>
          <dd className={`mono ${styles.liq}`}>{fmtPrice(p.symbol, Math.max(0, m.liq))}</dd>
        </div>
        <div>
          <dt>Notional</dt>
          <dd className="mono">{fmtAusd(p.size * m.mark)}</dd>
        </div>
      </dl>

      <div className={styles.bottom}>
        <div className={styles.healthWrap} title="Distance to liquidation">
          <div className={styles.healthLabel}>
            <span>{m.inAuction ? "In liquidation auction" : m.liquidatable ? "Liquidatable" : "Margin health"}</span>
            <span className="mono">{Math.round(m.health * 100)}%</span>
          </div>
          <HealthBar health={m.health} />
        </div>
        <button
          type="button"
          className={styles.close}
          disabled={m.closeDisabled}
          onClick={m.close}
          title={m.inAuction ? "Frozen during the liquidation auction — cure it from the banner above" : undefined}
        >
          {m.closing ? "Closing…" : m.inAuction ? "Frozen" : "Close"}
        </button>
      </div>
      {m.error && <Notice tone="error">{m.error}</Notice>}
    </article>
  );
}

const COLUMNS = 10;

/** Wider screens (>=720px): one table row per position. */
function PositionRow({ p, onClosed }: { p: Position; onClosed: OnClosed }) {
  const m = usePositionModel(p, onClosed);
  const base = baseOf(p.symbol);

  return (
    <>
      <tr className={m.liquidatable ? styles.rowLiq : undefined}>
        <td>
          <span className={styles.marketCell}>
            <span className={styles.sym}>
              {base}
              <span className={styles.symQuote}>/AUSD</span>
            </span>
            <span className={styles.lev}>{p.leverage}x</span>
            {/* Narrow tables fold the Side column in here. */}
            <span className={`${p.side === "long" ? styles.badgeLong : styles.badgeShort} ${styles.sideInline}`}>
              {p.side === "long" ? "LONG" : "SHORT"}
            </span>
          </span>
        </td>
        <td className={styles.colSide}>
          <span className={p.side === "long" ? styles.badgeLong : styles.badgeShort}>
            {p.side === "long" ? "LONG" : "SHORT"}
          </span>
        </td>
        <td className={`mono ${styles.num}`}>
          {fmtSize(p.symbol, p.size)} <span className={styles.unit}>{base}</span>
        </td>
        <td className={`mono ${styles.num}`}>{fmtPrice(p.symbol, p.entryPrice)}</td>
        <td className={`mono ${styles.num}`}>{fmtPrice(p.symbol, m.mark)}</td>
        <td className={`mono ${styles.num} ${styles.liq}`}>{fmtPrice(p.symbol, Math.max(0, m.liq))}</td>
        <td className={`mono ${styles.num}`}>{fmtAusd(p.margin)}</td>
        <td className={`mono ${styles.num} ${m.up ? styles.up : styles.down}`}>
          <span className={styles.pnlCell}>
            <b>{fmtSigned(m.pnl)}</b>
            <span>{fmtPct(m.roe)}</span>
          </span>
        </td>
        <td className={`${styles.healthCell} ${styles.colHealth}`} title="Distance to liquidation">
          <HealthBar health={m.health} />
          <span className="mono">{m.inAuction ? "AUCTION" : m.liquidatable ? "LIQ" : `${Math.round(m.health * 100)}%`}</span>
        </td>
        <td className={styles.actionCell}>
          <button
            type="button"
            className={styles.closeSm}
            disabled={m.closeDisabled}
            onClick={m.close}
            title={m.inAuction ? "Frozen during the liquidation auction — cure it from the banner above" : undefined}
          >
            {m.closing ? "Closing…" : m.inAuction ? "Frozen" : "Close"}
          </button>
        </td>
      </tr>
      {m.error && (
        <tr className={styles.errorRow}>
          <td colSpan={COLUMNS}>
            <Notice tone="error">{m.error}</Notice>
          </td>
        </tr>
      )}
    </>
  );
}

export function PositionsList({ onClosed }: { onClosed: OnClosed }) {
  const positions = useParaclr((s) => s.positions);
  const chainLive = useParaclr((s) => s.chain.status === "ready");
  const acctBlock = useParaclr((s) => s.chain.account?.block ?? null);
  const accountError = useParaclr((s) => s.chain.accountError);
  const prices = useParaclr((s) => s.prices);
  const wide = useMedia(MQ_TABLE);
  const clickToTrade = useMedia(MQ_FINE_POINTER);
  const total = positions.reduce(
    (acc, p) => acc + unrealizedPnl(p, prices[p.symbol]?.price ?? p.entryPrice),
    0,
  );
  const ordered = [...positions].reverse();
  // Matches the order panel: a submit button for mouse users, swipe on touch.
  const where = clickToTrade ? "from the order panel" : "above";
  const verb = clickToTrade ? "Place an order" : "Swipe";

  return (
    <section className={styles.section}>
      <header className={styles.head}>
        <h2 className={styles.title}>
          Positions <span className={styles.count}>{positions.length}</span>
          {chainLive && acctBlock !== null && (
            <span className={styles.chainNote} title="Read from the clearinghouse contract">
              on-chain · #{acctBlock}
            </span>
          )}
        </h2>
        {positions.length > 0 && (
          <span className={styles.totalWrap}>
            <span className={styles.totalLabel}>Unrealized</span>
            <span className={`mono ${styles.total} ${total >= 0 ? styles.up : styles.down}`}>
              {fmtSigned(total)} AUSD
            </span>
          </span>
        )}
      </header>

      {chainLive && accountError && <Notice tone="warn">Couldn&apos;t read your account: {accountError}</Notice>}

      {positions.length === 0 ? (
        <div className={styles.empty}>
          <svg width="36" height="36" viewBox="0 0 24 24" aria-hidden>
            <path
              d="M3 17l5-5 4 4 8-8M14 8h6v6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <p>No open positions</p>
          <span>
            {chainLive
              ? `${verb} ${where} to open an AUSD-margined trade on chain (one position per market).`
              : `${verb} ${where} to open an AUSD-margined trade.`}
          </span>
        </div>
      ) : wide ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Market</th>
                <th className={styles.colSide}>Side</th>
                <th className={styles.num}>Size</th>
                <th className={styles.num}>Entry</th>
                <th className={styles.num}>Mark</th>
                <th className={styles.num}>{chainLive ? "Liq. (cross)" : "Liq. price"}</th>
                <th className={styles.num}>Margin</th>
                <th className={styles.num}>PnL (AUSD / %)</th>
                <th className={styles.colHealth}>Health</th>
                <th className={styles.actionCell} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {ordered.map((p) => (
                <PositionRow key={p.id} p={p} onClosed={onClosed} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className={styles.list}>
          {ordered.map((p) => (
            <PositionCard key={p.id} p={p} onClosed={onClosed} />
          ))}
        </div>
      )}
    </section>
  );
}
