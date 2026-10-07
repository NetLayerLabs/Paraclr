"use client";

import { useState, type CSSProperties } from "react";
import type { Position } from "@/lib/types";
import { closePosition, liquidationPrice, unrealizedPnl, useParaclr } from "@/lib/store";
import { readableError } from "@/lib/chain/errors";
import { closePositionOnChain } from "@/lib/chain/trading";
import { submitReduceOrder } from "@/lib/chain/prod/actions";
import { isOpen, orderLabelId, useOrders } from "@/lib/chain/prod/orders";
import { usePriceName, useSlippage } from "@/components/prod/util";
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
  const production = useParaclr((s) => s.chain.status === "ready" && !!s.chain.contracts?.production);
  const pn = usePriceName();
  const orders = useOrders();
  const [slip] = useSlippage();
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [reduceOpen, setReduceOpen] = useState(false);
  // Production: the contract allows one pending order per market (an expired
  // one keeps blocking until it is cancelled from the Orders list).
  const pendingId = useParaclr((s) => s.chain.prod?.mine?.pending[p.symbol] ?? null);
  const exitPending =
    production && (pendingId !== null || orders.some((o) => o.symbol === p.symbol && (isOpen(o) || o.phase === "signing")));
  const pnl = unrealizedPnl(p, mark);
  const roe = (pnl / p.margin) * 100;
  const liq = liquidationPrice(p);
  // 1 = at entry, 0 = at liquidation.
  const health = Math.max(0, Math.min(1, (mark - liq) / (p.entryPrice - liq || 1)));
  const liquidatable = health <= 0;

  /** Production: close (fraction 1) or reduce with a delayed order at the Pyth price. */
  const exitOrder = async (fraction: number) => {
    setError(null);
    setNote(null);
    setClosing(true);
    setReduceOpen(false);
    try {
      const o = await submitReduceOrder({ position: p, fraction, mark, slippagePct: slip });
      setNote(
        `${fraction >= 1 ? "Close" : `Reduce ${Math.round(fraction * 100)}%`} order submitted${o.orderId !== null ? ` (${orderLabelId(o)})` : ""} — fills at the next ${pn}. Track it under Orders.`,
      );
    } catch (e) {
      setError(readableError(e));
    } finally {
      setClosing(false);
    }
  };

  const close = async () => {
    if (!chainLive) {
      closePosition(p.id);
      onClosed(p, Math.max(-p.margin, pnl));
      return;
    }
    if (production) {
      await exitOrder(1);
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
    note,
    close,
    inAuction,
    production,
    pn,
    exitPending,
    reduceOpen,
    setReduceOpen,
    exitOrder,
    // Production: reduce / close are reduce-only orders, allowed while in auction.
    closeDisabled: closing || (chainLive && !walletReady) || (inAuction && !production) || exitPending,
  };
}

type PositionModel = ReturnType<typeof usePositionModel>;

/** Production: reduce by a fraction with a delayed order. */
function ReduceChips({ m }: { m: PositionModel }) {
  if (!m.production || !m.reduceOpen) return null;
  return (
    <div className={styles.reduceRow} role="group" aria-label="Reduce position">
      <span>Reduce by</span>
      {[0.25, 0.5, 0.75].map((f) => (
        <button key={f} type="button" disabled={m.closeDisabled} onClick={() => void m.exitOrder(f)}>
          {f * 100}%
        </button>
      ))}
      <button type="button" onClick={() => m.setReduceOpen(false)}>
        Cancel
      </button>
    </div>
  );
}

function closeLabel(m: PositionModel): string {
  if (m.closing) return m.production ? "Submitting…" : "Closing…";
  if (m.inAuction && !m.production) return "Frozen";
  if (m.exitPending) return "Order pending";
  return "Close";
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
        {m.production && (
          <button
            type="button"
            className={styles.close}
            disabled={m.closeDisabled}
            onClick={() => m.setReduceOpen(!m.reduceOpen)}
            title={`Reduce with a delayed order at the next ${m.pn}`}
          >
            Reduce
          </button>
        )}
        <button
          type="button"
          className={styles.close}
          disabled={m.closeDisabled}
          onClick={m.close}
          title={
            m.inAuction && !m.production
              ? "Frozen during the liquidation auction — cure it from the banner above"
              : m.production
                ? m.inAuction
                  ? "Reduce-only order: fills only if it leaves the account at or above maintenance (ends the auction)"
                  : `Close with a delayed order at the next ${m.pn}`
                : undefined
          }
        >
          {closeLabel(m)}
        </button>
      </div>
      <ReduceChips m={m} />
      {m.note && <Notice tone="ok">{m.note}</Notice>}
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
          {m.production && (
            <button
              type="button"
              className={styles.closeSm}
              disabled={m.closeDisabled}
              onClick={() => m.setReduceOpen(!m.reduceOpen)}
              title={`Reduce with a delayed order at the next ${m.pn}`}
            >
              Reduce
            </button>
          )}
          <button
            type="button"
            className={styles.closeSm}
            disabled={m.closeDisabled}
            onClick={m.close}
            title={
              m.inAuction && !m.production
                ? "Frozen during the liquidation auction — cure it from the banner above"
                : m.production
                  ? m.inAuction
                    ? "Reduce-only order: fills only if it leaves the account at or above maintenance (ends the auction)"
                    : `Close with a delayed order at the next ${m.pn}`
                  : undefined
            }
          >
            {closeLabel(m)}
          </button>
        </td>
      </tr>
      {(m.reduceOpen && m.production) || m.note || m.error ? (
        <tr className={styles.errorRow}>
          <td colSpan={COLUMNS}>
            <ReduceChips m={m} />
            {m.note && <Notice tone="ok">{m.note}</Notice>}
            {m.error && <Notice tone="error">{m.error}</Notice>}
          </td>
        </tr>
      ) : null}
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
