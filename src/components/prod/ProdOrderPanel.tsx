"use client";

// Production order entry: a delayed order (docs/PRODUCTION_PLAN.md). The order
// is committed now with a worst acceptable price (slippage) and an execution
// fee in MON; a keeper fills it with the first Pyth price published at least
// MIN_EXEC_DELAY after the commit. Fees, caps and the pause flag are read from
// the contract and shown before submit.

import { useAuctionParams } from "@/lib/chain/auctionParams";
import { fmtBps } from "@/lib/chain/fair";
import { useState, type CSSProperties } from "react";
import { formatEther } from "viem";
import type { MarketSymbol, Side } from "@/lib/types";
import { useListedMarkets, useParaclr } from "@/lib/store";
import { useMarketFeed } from "@/lib/prices/feedStore";
import { usePriceStale } from "@/components/prod/util";
import { crossLiquidationPrice } from "@/lib/chain/account";
import { readableError } from "@/lib/chain/errors";
import { NETWORK } from "@/lib/chain/config";
import {
  depositRefusal,
  depositRoom,
  orderDepositNeeded,
  orderSize,
  submitIncreaseOrder,
} from "@/lib/chain/prod/actions";
import { useOrders, isOpen, type TrackedOrder } from "@/lib/chain/prod/orders";
import { ausdToNumber, ausdToUnits } from "@/lib/chain/units";
import { useRiskAcked } from "@/lib/chain/prod/riskAck";
import { PythPriceSource } from "@/lib/chain/prod/pythPrices";
import { Notice } from "@/components/chain/ChainUi";
import { MQ_FINE_POINTER, useMedia } from "@/components/shell/useMedia";
import { SwipeToTrade } from "@/components/trade/SwipeToTrade";
import { TradeButton } from "@/components/trade/TradeButton";
import { baseOf, fmtAusd, fmtCompact, fmtPct, fmtPrice, fmtSize } from "@/components/trade/format";
import ops from "@/components/trade/OrderPanel.module.css";
import { GasDrip } from "./GasDrip";
import { TestnetFunds } from "./TestnetFunds";
import { TokenIcon, TokenSymbol, useCollateral } from "./Token";
import { fmtDuration, usePriceName, useSlippage, SLIPPAGE_CHOICES } from "./util";
import styles from "./Prod.module.css";

const QUICK = [
  { label: "10%", f: 0.1 },
  { label: "25%", f: 0.25 },
  { label: "50%", f: 0.5 },
  { label: "Max", f: 1 },
];

const fmtMon = (wei: bigint | null) => {
  if (wei === null) return "-";
  const n = Number(formatEther(wei));
  return n === 0 ? "0" : n < 0.0001 ? n.toExponential(2) : n.toLocaleString("en-US", { maximumFractionDigits: 6 });
};

export function ProdOrderPanel({
  symbol,
  onSubmitted,
}: {
  symbol: MarketSymbol;
  onSubmitted: (o: TrackedOrder) => void;
}) {
  const price = useParaclr((s) => s.prices[symbol]?.price ?? null);
  const prices = useParaclr((s) => s.prices);
  const positions = useParaclr((s) => s.positions);
  const acct = useParaclr((s) => s.chain.account);
  const prod = useParaclr((s) => s.chain.prod);
  const walletReady = useParaclr((s) => s.chain.wallet.ready);
  const walletError = useParaclr((s) => s.chain.wallet.error);
  const address = useParaclr((s) => s.session?.address ?? null);
  const feed = useMarketFeed(symbol);
  const priceStale = usePriceStale(feed.observedAt);
  const orders = useOrders();
  const acked = useRiskAcked(address);
  const token = useCollateral();
  const clickToTrade = useMedia(MQ_FINE_POINTER);
  const [slip, setSlip] = useSlippage();
  const listed = useListedMarkets().includes(symbol);
  const pn = usePriceName();

  const [side, setSide] = useState<Side>("long");
  const [marginStr, setMarginStr] = useState("10");
  const [levRaw, setLeverage] = useState(3);
  const [error, setError] = useState<string | null>(null);

  const params = prod?.params ?? null;
  const maxLev = Math.max(1, Math.floor(params?.maxLeverage ?? 10));
  const leverage = Math.min(levRaw, maxLev);
  const margin = Number.parseFloat(marginStr) || 0;
  // Near max leverage the size leaves room for the slippage bound (see orderSize).
  const size = price ? orderSize(margin, leverage, price, slip) : 0;
  const notional = price ? size * price : margin * leverage;
  const base = baseOf(symbol);

  const existing = positions.find((p) => p.symbol === symbol) ?? null;
  // The contract escrows margin against deposited collateral (price-free):
  // collateral ≥ pending escrow + Σ position margins + this order's margin.
  const committed = acct
    ? ausdToNumber((acct.reservedMarginUnits ?? BigInt(0)) + (acct.marginSumUnits ?? BigInt(0)))
    : 0;
  const escrowFree = acct ? Math.max(0, acct.collateral - committed) : 0;
  const room = depositRoom(acct);
  const walletUsable = acct ? (room.room === null ? acct.walletAusd : Math.min(acct.walletAusd, room.room)) : 0;
  // Margin you can post: free escrow + depositable wallet, less the trading fee buffer the deposit includes.
  // The trading fee is paid out of the order's margin at the fill (v4), so no extra buffer.
  const available = acct ? Math.max(0, escrowFree + walletUsable) : 0;
  const deposit = acct ? ausdToNumber(orderDepositNeeded(acct, ausdToUnits(margin))) : 0;
  const depositBlock = deposit > 0 ? depositRefusal(acct, deposit) : null;

  const feeBps = params?.tradingFeeBps ?? null;
  const tradingFee = feeBps !== null ? (notional * feeBps) / 10_000 : null;
  const execFee = params?.minExecutionFee ?? null;
  const auction = useAuctionParams();
  const worst = price ? price * (side === "long" ? 1 + slip / 100 : 1 - slip / 100) : null;

  // Lane OI cap for this market/side.
  const oiCap = prod?.lane?.oiCap[symbol] ?? null;
  const laneOi = prod?.lane?.oi[symbol] ?? null;
  const sideOi = laneOi ? (side === "long" ? laneOi.long : laneOi.short) : null;
  const oiRoom = oiCap !== null && sideOi !== null ? Math.max(0, oiCap - sideOi) : null;

  let liq: number | null = null;
  if (price && margin > 0 && acct) {
    const legs = positions.map((p) => ({
      symbol: p.symbol,
      dir: (p.side === "long" ? 1 : -1) as 1 | -1,
      size: p.size,
      entry: p.entryPrice,
      mark: prices[p.symbol]?.price ?? p.entryPrice,
    }));
    if (existing && existing.side === side) {
      const i = legs.findIndex((l) => l.symbol === symbol);
      const total = legs[i].size + size;
      legs[i] = { ...legs[i], entry: (legs[i].entry * legs[i].size + price * size) / total, size: total };
      liq = crossLiquidationPrice(acct.collateral + deposit - (tradingFee ?? 0), legs, i);
    } else if (!existing) {
      legs.push({ symbol, dir: side === "long" ? 1 : -1, size, entry: price, mark: price });
      liq = crossLiquidationPrice(acct.collateral + deposit - (tradingFee ?? 0), legs, legs.length - 1);
    }
  }
  const liqDist = liq != null && price ? ((liq - price) / price) * 100 : null;

  // v5: no new margin while collateral is above the account cap (exempt top-ups can't fund risk).
  const aboveCap =
    acct && params?.maxDepositPerAccount != null ? acct.collateral > params.maxDepositPerAccount + 1e-9 : false;
  const pendingHere = orders.some((o) => o.symbol === symbol && isOpen(o)) || !!prod?.mine?.pending[symbol];
  const native = acct?.nativeUnits ?? BigInt(0);
  // Resulting position (an increase merges into an existing same-side leg).
  const sameSide = existing && existing.side === side ? existing : null;
  const resultNotional = notional + (sameSide && price ? sameSide.size * price : 0);
  const resultMargin = margin + (sameSide ? sameSide.margin : 0);

  const testnet = !!NETWORK?.isTestnetProd;
  const fundHint = testnet
    ? NETWORK?.sandbox
      ? `Get ${token.symbol} from the sandbox faucet (Wallet tab) first`
      : `No testnet ${token.symbol} yet: claim it above (or on the Wallet tab)`
    : `Send ${token.symbol} to your wallet first`;
  const gasHint = testnet
    ? NETWORK?.sandbox
      ? "Need MON for the execution fee + gas (sandbox faucet, Wallet tab)"
      : `Need testnet MON for the ${execFee !== null ? `${fmtMon(execFee)} MON ` : ""}execution fee + gas`
    : `Need ${NETWORK?.nativeSymbol ?? "MON"} for the execution fee + gas`;

  const reason = !listed
    ? `${base}/AUSD isn't listed on this deployment`
    : !walletReady
    ? (walletError ?? "Connecting wallet…")
    : !acct
      ? "Reading account from chain…"
      : !prod || prod.status === "loading"
        ? "Reading beta limits…"
        : prod.paused
          ? "Paused: new positions disabled"
          : acct.auction?.active
            ? "In auction: reduce or close below, or cure it"
            : existing && existing.side !== side
              ? `You hold a ${base} ${existing.side}: reduce or close it below`
              : pendingHere
                ? `A ${base} order is pending (one per market)`
              : aboveCap
                ? "Collateral above the beta cap: withdraw down to it before adding margin"
              : !price
                ? `Waiting for the ${pn}…`
                : priceStale
                  ? `Live ${pn} unavailable, reconnecting. Orders wait so the fill limit isn't set from a stale price.`
                : margin <= 0
                  ? `Enter ${token.symbol} margin`
                  : margin > available + 1e-9
                    ? acct.walletAusd <= 0 && escrowFree <= 0
                      ? fundHint
                      : deposit > walletUsable && room.room !== null && acct.walletAusd > room.room
                        ? "Over the beta deposit cap"
                        : `Insufficient ${token.symbol}`
                    : depositBlock
                      ? depositBlock
                    : leverage > maxLev || (resultMargin > 0 && resultNotional > resultMargin * maxLev * 1.0001)
                      ? `Max leverage ${maxLev}x`
                    : resultMargin > resultNotional + 1e-9
                      ? "Margin can't exceed notional (min 1x)"
                      : params?.minPositionNotional != null && resultNotional < params.minPositionNotional
                        ? `Min position ${fmtAusd(params.minPositionNotional)} notional`
                        : oiRoom !== null && notional > oiRoom
                          ? "Over this lane's open-interest cap"
                          : execFee === null
                            ? "Execution fee unknown"
                            : native <= execFee
                              ? gasHint
                              : null;

  const sideWord = side === "long" ? "Long" : "Short";
  const setMargin = (v: number) => {
    const floored = Math.floor(v * 100) / 100;
    setMarginStr(floored > 0 ? String(floored) : "");
  };
  const onInput = (raw: string) => {
    const cleaned = raw.replace(/,/g, ".").replace(/[^\d.]/g, "");
    const parts = cleaned.split(".");
    setMarginStr(parts.length > 1 ? `${parts[0]}.${parts.slice(1).join("").slice(0, 2)}` : cleaned);
  };

  const confirm = (): Promise<boolean> => {
    setError(null);
    if (!price) return Promise.resolve(false);
    return submitIncreaseOrder({ symbol, side, margin, leverage, mark: price, slippagePct: slip }).then(
      (o) => {
        onSubmitted(o);
        return true;
      },
      (e: unknown) => {
        setError(readableError(e));
        return false;
      },
    );
  };

  const levPct = maxLev > 1 ? ((leverage - 1) / (maxLev - 1)) * 100 : 100;
  const marks = Array.from(new Set([1, Math.round(maxLev / 4), Math.round(maxLev / 2), Math.round((3 * maxLev) / 4), maxLev])).filter(
    (m) => m >= 1,
  );
  const activeQuick = QUICK.find((q) => available > 0 && Math.abs(margin - Math.floor(available * q.f * 100) / 100) < 0.01);
  const conf = feed.source === "pyth" ? (PythPriceSource.conf.get(symbol) ?? null) : null;

  return (
    <section className={ops.panel} aria-label="Delayed order">
      <div className={`${ops.sideToggle} ${side === "short" ? ops.sideShort : ""}`} role="radiogroup" aria-label="Direction">
        <span className={ops.sideIndicator} aria-hidden />
        <button
          type="button"
          role="radio"
          aria-checked={side === "long"}
          className={side === "long" ? ops.sideActive : ops.sideBtn}
          onClick={() => setSide("long")}
        >
          Long
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={side === "short"}
          className={side === "short" ? ops.sideActive : ops.sideBtn}
          onClick={() => setSide("short")}
        >
          Short
        </button>
      </div>

      <div className={ops.fieldHead}>
        <span className={ops.label}>Margin</span>
        <span className={ops.avail} title="Free collateral in the clearinghouse + wallet balance you may still deposit under the beta caps">
          Avail <span className="mono">{fmtAusd(available)}</span> {token.symbol}
        </span>
      </div>
      <label className={ops.inputWrap}>
        <input
          className={`mono ${ops.input}`}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={marginStr}
          onChange={(e) => onInput(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Margin in AUSD"
        />
        <span className={ops.token}>
          <TokenIcon />
          <TokenSymbol />
        </span>
      </label>
      <div className={ops.chips}>
        {QUICK.map((q) => (
          <button
            key={q.label}
            type="button"
            className={activeQuick === q ? `${ops.chip} ${ops.chipActive}` : ops.chip}
            onClick={() => setMargin(available * q.f)}
          >
            {q.label}
          </button>
        ))}
      </div>

      <div className={ops.fieldHead}>
        <span className={ops.label}>Leverage</span>
        <span className={`mono ${ops.levValue} ${leverage >= maxLev * 0.75 && maxLev > 2 ? ops.levHot : ""}`}>
          {leverage}x <small style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 500 }}>max {maxLev}x</small>
        </span>
      </div>
      <div className={ops.sliderWrap} style={{ "--pct": `${levPct}%` } as CSSProperties}>
        <input
          type="range"
          min={1}
          max={maxLev}
          step={1}
          value={leverage}
          onChange={(e) => setLeverage(Number(e.target.value))}
          className={ops.slider}
          aria-label="Leverage"
        />
        <div className={ops.marks}>
          {marks.map((m) => (
            <button
              key={m}
              type="button"
              className={leverage >= m ? `${ops.mark} ${ops.markOn}` : ops.mark}
              style={{ left: `${maxLev > 1 ? ((m - 1) / (maxLev - 1)) * 100 : 0}%` }}
              onClick={() => setLeverage(m)}
            >
              {m}x
            </button>
          ))}
        </div>
      </div>

      <div className={styles.row}>
        <span className={ops.label} title={`Worst price you accept. If the ${pn} at execution is worse, the order isn't filled.`}>
          Slippage
        </span>
        <SlippagePicker value={slip} onChange={setSlip} />
      </div>

      <dl className={ops.summary}>
        <div>
          <dt>Size</dt>
          <dd className="mono">
            {price ? fmtSize(symbol, size) : "-"} {base}
          </dd>
        </div>
        <div>
          <dt>Notional</dt>
          <dd className="mono">{fmtCompact(notional)}</dd>
        </div>
        <div>
          <dt>{pn === "Pyth price" ? "Pyth price now" : "Price now (keeper-signed)"}</dt>
          <dd className="mono" title={conf !== null ? `Pyth confidence ±${conf}` : undefined}>
            {fmtPrice(symbol, price)}
            {conf !== null && price ? <small style={{ color: "var(--text-dim)" }}> ±{fmtPrice(symbol, conf)}</small> : null}
          </dd>
        </div>
        <div>
          <dt>{side === "long" ? "Max fill price" : "Min fill price"}</dt>
          <dd className="mono">{fmtPrice(symbol, worst)}</dd>
        </div>
        <div>
          <dt>Est. liq. price (cross)</dt>
          <dd className={`mono ${ops.liq}`}>
            {liq != null ? fmtPrice(symbol, Math.max(0, liq)) : "-"}
            {liqDist != null && <span className={ops.liqDist}>{fmtPct(liqDist, 1)}</span>}
          </dd>
        </div>
        <div>
          <dt>Lane OI room ({side})</dt>
          <dd className="mono">{oiRoom === null ? "-" : fmtCompact(oiRoom)}</dd>
        </div>
      </dl>

      <dl className={styles.fees} aria-label="Fees">
        <div>
          <dt>Trading fee{feeBps !== null ? ` (${(feeBps / 100).toFixed(2)}%, from margin)` : ""}</dt>
          <dd className="mono">
            {tradingFee === null ? "-" : fmtAusd(tradingFee, 4)} <small>{token.symbol}</small>
          </dd>
        </div>
        <div>
          <dt>Execution fee (to the keeper)</dt>
          <dd className="mono">
            {fmtMon(execFee)} <small>{NETWORK?.nativeSymbol ?? "MON"}</small>
          </dd>
        </div>
        {deposit > 0 && margin <= available + 1e-9 && (
          <div title="The order's margin (the trading fee is paid out of it), minus collateral you already have free">
            <dt>Deposited from wallet first</dt>
            <dd className="mono">
              {fmtAusd(deposit)} <small>{token.symbol}</small>
            </dd>
          </div>
        )}
        <div className={styles.feesTotal}>
          <dt>Fill window</dt>
          <dd className="mono">
            {params?.minExecDelay != null ? `≥ ${fmtDuration(params.minExecDelay)}` : "-"}
            {params?.maxExecDelay != null ? ` · expires ${fmtDuration(params.maxExecDelay)}` : ""}
          </dd>
        </div>
      </dl>

      {existing && existing.side === side && (
        <Notice>
          Adds to your {base} {existing.side}: the new margin and size are merged at the fill price.
        </Notice>
      )}
      {deposit > 0 && margin <= available + 1e-9 && !prod?.paused && (
        <Notice>
          First {acked ? "" : "you'll confirm the beta risk notice, then "}an exact-amount approve
          {acct && acct.allowanceUnits > BigInt(0) ? " (if needed)" : ""} and a deposit of{" "}
          <span className="mono">{fmtAusd(deposit)}</span> {token.symbol}, then the order: each an on-chain
          transaction.
        </Notice>
      )}
      {aboveCap && (
        <Notice tone="warn">
          Your collateral is above the beta cap of{" "}
          <span className="mono">{fmtAusd(params?.maxDepositPerAccount ?? 0)}</span> {token.symbol}. Withdraw down to the
          cap before adding margin; reducing or closing still works.
        </Notice>
      )}
      {pendingHere && (
        <Notice>
          Your {base} order is still pending (the contract allows one per market). Track it under Orders; a new one can
          be placed once it fills, fails or is cancelled.
        </Notice>
      )}

      {/* A fresh testnet wallet has neither AUSD nor MON. The fixable step becomes the active control
          above the (muted) submit: the keeper's gas drip first (it hides itself once funded), then
          Agora's AUSD faucet (disabled with its own reason until there is MON for gas). */}
      {acct && (reason === gasHint || reason === fundHint) && (
        <div className={styles.fix} role="group" aria-label="Before you can trade">
          <GasDrip address={address} nativeWei={native} faucetFallback={reason === gasHint} />
          {reason === fundHint && testnet && !NETWORK?.sandbox && <TestnetFunds variant="inline" />}
        </div>
      )}
      {clickToTrade ? (
        <TradeButton
          side={side}
          label={`Submit ${sideWord.toLowerCase()} ${leverage}x ${base} order`}
          doneLabel="Order submitted"
          pendingLabel="Submitting order…"
          disabledReason={reason}
          onConfirm={confirm}
        />
      ) : (
        <SwipeToTrade
          side={side}
          label={`Swipe to submit ${sideWord.toLowerCase()} ${leverage}x`}
          doneLabel="Order submitted"
          pendingLabel="Submitting order…"
          disabledReason={reason}
          onConfirm={confirm}
        />
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <details className={styles.how}>
        <summary>
          <b>Two steps:</b> committed now, filled at the next {pn}
        </summary>
        Your order is committed now; a keeper fills it with the first {pn} published at least{" "}
        {params?.minExecDelay != null ? fmtDuration(params.minExecDelay) : "a few seconds"} later, so nobody can trade
        on a price they already know. If that price is past your slippage limit the order is not filled (nothing is
        traded). If nobody executes it within {params?.maxExecDelay != null ? fmtDuration(params.maxExecDelay) : "the window"},
        cancel it to get the escrow and execution fee back. Closing or reducing a position is an order too, with the
        same execution fee.
      </details>
      <details className={styles.how}>
        <summary>
          <b>If equity falls below maintenance:</b> a liquidation auction
        </summary>
        Your account is frozen and goes to a per-block Dutch auction in its lane. A taker (first the lane&apos;s backstop
        pool) inherits your positions at the oracle price and is paid a discount that rises{" "}
        {fmtBps(auction.stepBps)} per block, up to {fmtBps(auction.maxDiscountBps)}. You keep the equity the taker
        isn&apos;t paid, usually more than a fixed 1% liquidation leaves. Adding collateral during the auction cures it.
      </details>
    </section>
  );
}

export function SlippagePicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const preset = SLIPPAGE_CHOICES.includes(value);
  const [custom, setCustom] = useState(preset ? "" : String(value));
  return (
    <span className={styles.slip} role="radiogroup" aria-label="Slippage">
      {SLIPPAGE_CHOICES.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          className={styles.slipChip}
          onClick={() => {
            setCustom("");
            onChange(c);
          }}
        >
          {c}%
        </button>
      ))}
      <input
        className={styles.slipInput}
        inputMode="decimal"
        placeholder="custom"
        aria-label="Custom slippage in percent"
        value={custom}
        onChange={(e) => {
          const v = e.target.value.replace(/,/g, ".").replace(/[^\d.]/g, "");
          setCustom(v);
          const n = Number.parseFloat(v);
          if (n > 0 && n <= 5) onChange(n);
        }}
      />
    </span>
  );
}
