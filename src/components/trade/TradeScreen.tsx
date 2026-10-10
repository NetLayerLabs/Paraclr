"use client";

import { useEffect, useRef, useState } from "react";
import type { Position } from "@/lib/types";
import { selectMarket, useListedMarkets, useParaclr } from "@/lib/store";
import { Notice, TxTray } from "@/components/chain/ChainUi";
import { MarketHeader } from "./MarketHeader";
import { CandleChart } from "./CandleChart";
import { OrderPanel, type OpenedMeta } from "./OrderPanel";
import { AccountSummary } from "./AccountSummary";
import { AuctionBanner } from "./AuctionBanner";
import { PositionsList, type ClosedMeta } from "./PositionsList";
import { OrderHistory } from "./OrderHistory";
import { cardFromPosition, showPnlCard } from "./PnlCard";
import { INDEXER_ON } from "@/lib/indexer";
import { baseOf, fmtPrice, fmtSigned } from "./format";
import { ProdOrderPanel } from "@/components/prod/ProdOrderPanel";
import { PendingOrders } from "@/components/prod/PendingOrders";
import { MarketRisk } from "@/components/prod/MarketRisk";
import { usePriceName } from "@/components/prod/util";
import type { TrackedOrder } from "@/lib/chain/prod/orders";
import styles from "./TradeScreen.module.css";

interface Toast {
  id: number;
  tone: "long" | "short" | "neutral";
  title: string;
  detail: string;
}

export function TradeScreen() {
  const symbol = useParaclr((s) => s.selectedMarket);
  const chainLive = useParaclr((s) => s.chain.status === "ready");
  const faucet = useParaclr((s) => s.chain.faucet);
  const hasGas = useParaclr((s) => (s.chain.account?.native ?? 0) > 0);
  const production = useParaclr((s) => chainLive && !!s.chain.contracts?.production);
  const [toast, setToast] = useState<Toast | null>(null);
  // Bottom panel: open positions (contract read) or the order history (Envio indexer, chain modes only).
  const [bottom, setBottom] = useState<"positions" | "history">("positions");
  const history = INDEXER_ON && chainLive && bottom === "history";
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const listed = useListedMarkets();
  const pn = usePriceName();

  useEffect(() => () => clearTimeout(timer.current), []);
  // A production deployment may not list the selected market (e.g. MON on testnet).
  useEffect(() => {
    if (listed.length > 0 && !listed.includes(symbol)) selectMarket(listed[0]);
  }, [listed, symbol]);

  const show = (t: Omit<Toast, "id">) => {
    clearTimeout(timer.current);
    setToast({ ...t, id: Date.now() });
    timer.current = setTimeout(() => setToast(null), 2600);
  };

  const onOpened = (p: Position, meta?: OpenedMeta) =>
    show({
      tone: p.side,
      title: `${p.side === "long" ? "Long" : "Short"} ${p.leverage}x ${baseOf(p.symbol)} opened`,
      detail:
        `Entry ${fmtPrice(p.symbol, p.entryPrice)} · ${p.margin.toFixed(2)} AUSD margin` +
        (meta?.block !== undefined ? ` · block #${meta.block}` : ""),
    });

  const onSubmitted = (o: TrackedOrder) =>
    show({
      tone: o.side === "long" ? "long" : "short",
      title: `Order submitted · ${o.label}`,
      detail: `Waiting for the next ${pn} - track it under Orders.`,
    });

  const onClosed = (p: Position, realized: number, meta?: ClosedMeta) => {
    show({
      tone: "neutral",
      title: `${baseOf(p.symbol)} position closed`,
      detail: `Realized ${fmtSigned(realized)} AUSD` + (meta?.block !== undefined ? ` · block #${meta.block}` : ""),
    });
    showPnlCard(cardFromPosition(p, realized, chainLive));
  };

  return (
    // Phone/tablet: one stacked column in DOM order. Desktop (>=1024px): a
    // CSS-grid terminal - ticker across the top, chart filling the height,
    // order column docked right, positions table under the chart.
    <div className={styles.screen}>
      <div className={styles.ticker}>
        <AuctionBanner />
        <MarketHeader symbol={symbol} details={production ? <MarketRisk symbol={symbol} /> : null} />
        {/* From 640px the risk strip sits inline under the ticker; phones read it under "Market details". */}
        {production && (
          <div className={styles.riskInline}>
            <MarketRisk symbol={symbol} />
          </div>
        )}
      </div>
      <div className={styles.chart}>
        <CandleChart symbol={symbol} />
      </div>
      <aside className={styles.side} aria-label="Order entry">
        {chainLive && !production && (faucet.status === "checking" || faucet.status === "requesting") && (
          <Notice>{faucet.message ?? "Checking your wallet balance…"}</Notice>
        )}
        {chainLive && !production && faucet.status === "failed" && (
          <Notice tone="warn">
            Auto-funding failed: {faucet.message}{" "}
            {hasGas
              ? "You can retry or mint test AUSD on the Wallet tab."
              : "Retry from the Wallet tab once the keeper is reachable."}
          </Notice>
        )}
        {production ? (
          <>
            {/* Orders first: right after a submit, its status is what matters. */}
            <PendingOrders max={3} />
            <ProdOrderPanel symbol={symbol} onSubmitted={onSubmitted} />
          </>
        ) : (
          <OrderPanel symbol={symbol} onOpened={onOpened} />
        )}
        {chainLive && <TxTray />}
        <AccountSummary />
      </aside>
      <div className={styles.positions}>
        {INDEXER_ON && chainLive && (
          <div className={styles.bottomTabs} role="tablist" aria-label="Positions or order history">
            {(["positions", "history"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={bottom === t}
                className={bottom === t ? styles.bottomTabOn : styles.bottomTab}
                onClick={() => setBottom(t)}
              >
                {t === "positions" ? "Positions" : "History"}
              </button>
            ))}
          </div>
        )}
        {history ? <OrderHistory /> : <PositionsList onClosed={onClosed} />}
      </div>

      {toast && (
        <div key={toast.id} className={`${styles.toast} ${styles[toast.tone]}`} role="status">
          <span className={styles.toastIcon} aria-hidden>
            <svg width="16" height="16" viewBox="0 0 24 24">
              <path d="M5 12.5 10 17.5 19 7" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className={styles.toastBody}>
            <b>{toast.title}</b>
            <span>{toast.detail}</span>
          </span>
        </div>
      )}
    </div>
  );
}
