"use client";

import { useState, type CSSProperties } from "react";
import type { MarketSymbol, Position, Side } from "@/lib/types";
import { liquidationPrice, openPosition, useParaclr } from "@/lib/store";
import { useMarketFeed } from "@/lib/prices/feedStore";
import { crossLiquidationPrice } from "@/lib/chain/account";
import { readableError } from "@/lib/chain/errors";
import { openPositionOnChain } from "@/lib/chain/trading";
import { Notice } from "@/components/chain/ChainUi";
import { TokenSymbol } from "@/components/prod/Token";
import { baseOf, fmtAusd, fmtCompact, fmtPct, fmtPrice, fmtSize } from "./format";
import { MQ_FINE_POINTER, useMedia } from "@/components/shell/useMedia";
import { SwipeToTrade } from "./SwipeToTrade";
import { TradeButton } from "./TradeButton";
import styles from "./OrderPanel.module.css";

const MAX_LEV = 20;
const LEV_MARKS = [1, 5, 10, 15, 20];
const QUICK = [
  { label: "10%", f: 0.1 },
  { label: "25%", f: 0.25 },
  { label: "50%", f: 0.5 },
  { label: "Max", f: 1 },
];

export interface OpenedMeta {
  block?: number;
}

export function OrderPanel({
  symbol,
  onOpened,
}: {
  symbol: MarketSymbol;
  onOpened: (p: Position, meta?: OpenedMeta) => void;
}) {
  const balance = useParaclr((s) => s.ausdBalance);
  const price = useParaclr((s) => s.prices[symbol]?.price ?? null);
  // All marks are only needed for the cross-margin preview (chain mode).
  const prices = useParaclr((s) => (s.chain.status === "ready" ? s.prices : null));
  const positions = useParaclr((s) => s.positions);
  const owner = useParaclr((s) => s.session?.address ?? "");
  const chainLive = useParaclr((s) => s.chain.status === "ready");
  const acct = useParaclr((s) => s.chain.account);
  const walletReady = useParaclr((s) => s.chain.wallet.ready);
  const walletError = useParaclr((s) => s.chain.wallet.error);
  const feedSource = useMarketFeed(symbol).source;
  // Swipe is a touch idiom: phones and touch devices swipe, mouse users click.
  const clickToTrade = useMedia(MQ_FINE_POINTER);

  const [side, setSide] = useState<Side>("long");
  const [marginStr, setMarginStr] = useState("250");
  const [leverage, setLeverage] = useState(10);
  const [chainError, setChainError] = useState<string | null>(null);

  const margin = Number.parseFloat(marginStr) || 0;
  const notional = margin * leverage;
  const size = price ? notional / price : 0;

  // Chain mode: the clearinghouse allows ONE position per market per account.
  const existing = chainLive ? (positions.find((p) => p.symbol === symbol) ?? null) : null;
  const freeCollateral = acct?.freeCollateral ?? 0;
  // Margin can come from free collateral plus wallet AUSD (auto-deposited).
  const available = chainLive ? (acct ? freeCollateral + acct.walletAusd : 0) : balance;
  const deposit = chainLive && acct ? Math.max(0, margin - freeCollateral) : 0;

  let liq: number | null = null;
  if (price && margin > 0) {
    if (chainLive && acct) {
      // Cross-margin: the new leg shares the account's collateral with open legs.
      const legs = positions.map((p) => ({
        symbol: p.symbol,
        dir: (p.side === "long" ? 1 : -1) as 1 | -1,
        size: p.size,
        entry: p.entryPrice,
        mark: prices?.[p.symbol]?.price ?? p.entryPrice,
      }));
      legs.push({ symbol, dir: side === "long" ? 1 : -1, size, entry: price, mark: price });
      liq = crossLiquidationPrice(acct.collateral + deposit, legs, legs.length - 1);
    } else {
      liq = liquidationPrice({
        id: "preview",
        owner: "",
        symbol,
        side,
        size,
        entryPrice: price,
        margin,
        leverage,
        openedAt: 0,
      });
    }
  }
  const liqDist = liq != null && price ? ((liq - price) / price) * 100 : null;

  const base = baseOf(symbol);
  const chainReason = !chainLive
    ? null
    : !walletReady
      ? (walletError ?? "Connecting wallet…")
      : !acct
        ? "Reading account from chain…"
        : acct.auction?.active
          ? "In liquidation auction — cure it first"
          : existing
          ? `Close your ${base} position first`
          : acct.native <= 0
            ? "No gas — get test funds on the Wallet tab"
            : null;

  const disabledReason =
    chainReason ??
    (!price
      ? "Waiting for price…"
      : margin <= 0
        ? "Enter AUSD margin"
        : margin > available + 1e-9
          ? "Insufficient AUSD"
          : null);

  const sideWord = side === "long" ? "Long" : "Short";

  const setMargin = (v: number) => {
    const floored = Math.floor(v * 100) / 100;
    setMarginStr(floored > 0 ? String(floored) : "");
  };

  const onInput = (raw: string) => {
    const cleaned = raw.replace(/,/g, ".").replace(/[^\d.]/g, "");
    const parts = cleaned.split(".");
    const v = parts.length > 1 ? `${parts[0]}.${parts.slice(1).join("").slice(0, 2)}` : cleaned;
    setMarginStr(v);
  };

  const confirm = (): boolean | Promise<boolean> => {
    if (!chainLive) {
      const pos = openPosition({ symbol, side, margin, leverage });
      if (pos) onOpened(pos);
      return !!pos;
    }
    setChainError(null);
    return openPositionOnChain({ symbol, side, margin, leverage }).then(
      (r) => {
        onOpened(
          {
            id: `chain:${symbol}`,
            owner,
            symbol,
            side,
            size: r.size,
            entryPrice: r.entryPrice,
            margin,
            leverage,
            openedAt: Date.now(),
          },
          { block: r.block },
        );
        return true;
      },
      (e: unknown) => {
        setChainError(readableError(e));
        return false;
      },
    );
  };

  const levPct = ((leverage - 1) / (MAX_LEV - 1)) * 100;
  const activeQuick = QUICK.find(
    (q) => available > 0 && Math.abs(margin - Math.floor(available * q.f * 100) / 100) < 0.01,
  );

  return (
    <section className={styles.panel}>
      {/* Long / Short */}
      <div
        className={`${styles.sideToggle} ${side === "short" ? styles.sideShort : ""}`}
        role="radiogroup"
        aria-label="Direction"
      >
        <span className={styles.sideIndicator} aria-hidden />
        <button
          type="button"
          role="radio"
          aria-checked={side === "long"}
          className={side === "long" ? styles.sideActive : styles.sideBtn}
          onClick={() => setSide("long")}
        >
          Long
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={side === "short"}
          className={side === "short" ? styles.sideActive : styles.sideBtn}
          onClick={() => setSide("short")}
        >
          Short
        </button>
      </div>

      {/* Margin */}
      <div className={styles.fieldHead}>
        <span className={styles.label}>Margin</span>
        <span
          className={styles.avail}
          title={chainLive ? "Free collateral in the clearinghouse + AUSD in your wallet (auto-deposited)" : undefined}
        >
          Avail <span className="mono">{fmtAusd(available)}</span> AUSD
        </span>
      </div>
      <label className={styles.inputWrap}>
        <input
          className={`mono ${styles.input}`}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={marginStr}
          onChange={(e) => onInput(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Margin in AUSD"
        />
        <span className={styles.token}>
          <span className={styles.tokenDot} aria-hidden>
            A
          </span>
          <TokenSymbol />
        </span>
      </label>
      <div className={styles.chips}>
        {QUICK.map((q) => (
          <button
            key={q.label}
            type="button"
            className={activeQuick === q ? `${styles.chip} ${styles.chipActive}` : styles.chip}
            onClick={() => setMargin(available * q.f)}
          >
            {q.label}
          </button>
        ))}
      </div>

      {/* Leverage */}
      <div className={styles.fieldHead}>
        <span className={styles.label}>Leverage</span>
        <span className={`mono ${styles.levValue} ${leverage >= 15 ? styles.levHot : ""}`}>
          {leverage}x
        </span>
      </div>
      <div className={styles.sliderWrap} style={{ "--pct": `${levPct}%` } as CSSProperties}>
        <input
          type="range"
          min={1}
          max={MAX_LEV}
          step={1}
          value={leverage}
          onChange={(e) => {
            setLeverage(Number(e.target.value));
            try {
              navigator.vibrate?.(4);
            } catch {
              /* unsupported */
            }
          }}
          className={styles.slider}
          aria-label="Leverage"
        />
        <div className={styles.marks}>
          {LEV_MARKS.map((m) => (
            <button
              key={m}
              type="button"
              className={leverage >= m ? `${styles.mark} ${styles.markOn}` : styles.mark}
              style={{ left: `${((m - 1) / (MAX_LEV - 1)) * 100}%` }}
              onClick={() => setLeverage(m)}
            >
              {m}x
            </button>
          ))}
        </div>
      </div>

      {/* Summary */}
      <dl className={styles.summary}>
        <div>
          <dt>Position size</dt>
          <dd className="mono">
            {price ? fmtSize(symbol, size) : "—"} {baseOf(symbol)}
          </dd>
        </div>
        <div>
          <dt>Notional</dt>
          <dd className="mono">{fmtCompact(notional)} AUSD</dd>
        </div>
        <div>
          <dt>Entry (mark)</dt>
          <dd className="mono">{fmtPrice(symbol, price)}</dd>
        </div>
        <div>
          <dt>{chainLive ? "Liq. price (cross)" : "Liq. price"}</dt>
          <dd className={`mono ${styles.liq}`}>
            {liq != null ? fmtPrice(symbol, Math.max(0, liq)) : "—"}
            {liqDist != null && <span className={styles.liqDist}>{fmtPct(liqDist, 1)}</span>}
          </dd>
        </div>
      </dl>

      {chainLive && existing && !acct?.auction?.active && (
        <Notice tone="warn">
          One position per market: the clearinghouse doesn&apos;t support adding to or flipping a position.
          Close your {base} {existing.side} {existing.leverage}x below to open a new one.
        </Notice>
      )}
      {chainLive && !existing && deposit > 0 && margin <= available + 1e-9 && (
        <Notice>
          {clickToTrade ? "Placing this order" : "Swiping"} first deposits{" "}
          <span className="mono">{fmtAusd(deposit)}</span> AUSD from your wallet
          {acct && acct.allowanceUnits === BigInt(0) ? " (one-time approve + deposit)" : ""}, then opens the
          position — each step is an on-chain transaction.
        </Notice>
      )}

      {clickToTrade ? (
        <TradeButton
          side={side}
          label={`${sideWord} ${leverage}x ${base}`}
          doneLabel={`${sideWord} ${leverage}x ${base} opened`}
          pendingLabel={chainLive ? "Confirming on chain…" : undefined}
          disabledReason={disabledReason}
          onConfirm={confirm}
        />
      ) : (
        <SwipeToTrade
          side={side}
          label={`Swipe to ${sideWord} ${leverage}x`}
          doneLabel={`${sideWord} ${leverage}x opened`}
          pendingLabel={chainLive ? "Confirming on chain…" : undefined}
          disabledReason={disabledReason}
          onConfirm={confirm}
        />
      )}
      {chainError && <Notice tone="error">{chainError}</Notice>}
      <p className={styles.footnote}>
        {chainLive
          ? "Margined & settled in test AUSD (MockAUSD) · Marked by the on-chain oracle the clearinghouse settles against"
          : feedSource === "chainlink"
            ? "Margined & settled in Agora AUSD · Priced by Chainlink Data Streams"
            : "Margined & settled in Agora AUSD · Simulated prices"}
      </p>
    </section>
  );
}
