"use client";

// Trade screen: the signed-in account's liquidation auction.
//   in auction  discount now (the contract's block clock), ≈ what the trader
//               keeps if taken now, blocks until the lane backstop can take,
//               and "add collateral to cure" (deposit + cancelAuction).
//   resolved    what happened, from the account's latest auction event:
//               taken by the lane backstop / an external taker (and what the
//               trader kept), cured, or expired.
// Chain modes only; renders nothing in sim mode or on pre-auction deployments.

import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { useParaclr } from "@/lib/store";
import { readLatestAuctionEvent, type AuctionRecord } from "@/lib/chain/auctionFeed";
import { demoTakers } from "@/lib/chain/keeper";
import { getLatestBlock, publicClient } from "@/lib/chain/clients";
import { readableError } from "@/lib/chain/errors";
import { useAuctionParams } from "@/lib/chain/auctionParams";
import { blocksUntil, discountBpsAt, fmtBps } from "@/lib/chain/fair";
import { cureAuctionOnChain } from "@/lib/chain/fairActions";
import { submitReduceOrder } from "@/lib/chain/prod/actions";
import { orderLabelId } from "@/lib/chain/prod/orders";
import { useSlippage } from "@/components/prod/util";
import type { MarketSymbol } from "@/lib/types";
import { Notice, TxLink } from "@/components/chain/ChainUi";
import { fmtAusd } from "./format";
import styles from "./AuctionBanner.module.css";

/** Show a resolved outcome if it happened within this many blocks (≈4 min on Monad, 10 min on anvil). */
const OUTCOME_WINDOW = 600;
const DISMISS_KEY = "paraclr:auction-outcome-dismissed";

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(id: string) {
  try {
    window.localStorage.setItem(DISMISS_KEY, id);
  } catch {
    /* storage blocked */
  }
}

export function AuctionBanner() {
  const live = useParaclr((s) => s.chain.status === "ready");
  const acct = useParaclr((s) => s.chain.account);
  const clearinghouse = useParaclr((s) => s.chain.contracts?.clearinghouse ?? null);
  const block = useParaclr((s) => s.chain.block);
  const [outcome, setOutcome] = useState<AuctionRecord | null>(null);
  const lastStart = useRef<number | null>(null);
  const checked = useRef<string | null>(null);

  const active = acct?.auction?.active ?? false;
  const address = acct?.address ?? null;
  const startBlock = active ? (acct?.auction?.startBlock ?? null) : null;

  // Remember the start block of an auction we saw running (for the outcome lookup).
  useEffect(() => {
    if (startBlock !== null) lastStart.current = startBlock;
  }, [startBlock]);

  // Look up how the auction ended: once per address on load (recent history),
  // and whenever an auction we watched stops being active. Primitive deps
  // only - the account snapshot is a new object every block.
  const auctionsSupported = acct?.auction != null;
  useEffect(() => {
    if (!live || !clearinghouse || !address || active || !auctionsSupported) return;
    const key = `${address}:${lastStart.current ?? "load"}`;
    if (checked.current === key) return;
    checked.current = key;
    let cancelled = false;
    void (async () => {
      // An auction we watched just ended: never leave an older outcome on screen.
      if (lastStart.current !== null) setOutcome(null);
      try {
        const head = getLatestBlock() ?? (await publicClient().getBlockNumber());
        const from =
          lastStart.current !== null
            ? BigInt(lastStart.current)
            : head > BigInt(OUTCOME_WINDOW)
              ? head - BigInt(OUTCOME_WINDOW)
              : BigInt(0);
        const r = await readLatestAuctionEvent(clearinghouse, address as Address, from, head);
        if (cancelled || !r || r.status === "active" || r.resolvedBlock === null) return;
        if (Number(head) - r.resolvedBlock > OUTCOME_WINDOW) return;
        if (r.txHash && readDismissed() === r.txHash) return;
        setOutcome(r);
      } catch {
        // No history available: allow a retry on the next change.
        if (!cancelled) checked.current = null;
      }
    })();
    return () => {
      cancelled = true;
      // Unmounted / address changed before the lookup finished: let it run again.
      if (checked.current === key) checked.current = null;
    };
  }, [live, clearinghouse, address, active, auctionsSupported]);

  if (!live || !acct) return null;
  if (active && acct.auction) return <InAuction startBlock={acct.auction.startBlock} block={block ?? acct.block ?? acct.auction.startBlock} />;
  if (outcome) {
    return (
      <Outcome
        r={outcome}
        free={acct.freeCollateral}
        onDismiss={() => {
          if (outcome.txHash) writeDismissed(outcome.txHash);
          setOutcome(null);
        }}
      />
    );
  }
  return null;
}

function InAuction({ startBlock, block }: { startBlock: number; block: number }) {
  const acct = useParaclr((s) => s.chain.account);
  const production = useParaclr((s) => !!s.chain.contracts?.production);
  const prices = useParaclr((s) => s.prices);
  const p = useAuctionParams();
  const [slip] = useSlippage();
  const [exiting, setExiting] = useState<string | null>(null);
  const [amountStr, setAmountStr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);
  if (!acct) return null;

  const minBps = p.minDiscountBps[acct.lane] ?? p.minDiscountBps[0];
  const d = discountBpsAt(startBlock, block, p);
  const elapsed = Math.max(0, block - startBlock);
  const equity = acct.equity ?? 0;
  const notional = acct.notional ?? 0;
  const mm = acct.maintenanceMargin ?? 0;
  const keep = Math.max(0, equity - (d / 10_000) * notional);
  const toBackstop = blocksUntil(minBps, startBlock, block, p);
  const toMax = blocksUntil(p.maxDiscountBps, startBlock, block, p);
  const shortfall = Math.max(0, mm - equity);
  // Default top-up: the shortfall plus a small margin so an adverse tick doesn't undo it
  // (the production contract cures at maintenance; the demo used +10%).
  const suggested =
    shortfall > 0
      ? Math.ceil((production ? shortfall * 1.02 + 0.25 : shortfall * 1.1 + 1) * 100) / 100
      : 0;
  const amount = amountStr === null ? suggested : Number.parseFloat(amountStr) || 0;
  const wallet = acct.walletAusd;

  const cure = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await cureAuctionOnChain(amount);
      setMsg(
        r.cancelled
          ? { tone: "ok", text: "Cured - the auction is cancelled and your account is unfrozen." }
          : { tone: "warn", text: "Deposited, but the account is still below maintenance margin. Add more to cure." },
      );
      setAmountStr(null);
    } catch (e) {
      setMsg({ tone: "error", text: readableError(e) });
    } finally {
      setBusy(false);
    }
  };

  const reason = busy ? null : amount > wallet + 1e-9 ? "Not enough AUSD in your wallet" : null;

  // Production: an account in auction may commit reduce-only orders; one that leaves the
  // account at or above maintenance fills and ends the auction.
  const exit = async (symbol: MarketSymbol, fraction: number) => {
    const pos = acct.positions.find((x) => x.symbol === symbol);
    const mark = prices[symbol]?.price ?? pos?.entryPrice;
    if (!pos || !mark) return;
    setExiting(`${symbol}:${fraction}`);
    setMsg(null);
    try {
      const o = await submitReduceOrder({ position: pos, fraction, mark, slippagePct: slip });
      setMsg({
        tone: "ok",
        text: `${fraction >= 1 ? "Close" : "Reduce"} order submitted${o.orderId !== null ? ` (${orderLabelId(o)})` : ""}: it fills at the next Pyth price if it leaves the account at or above maintenance, which ends the auction.`,
      });
    } catch (e) {
      setMsg({ tone: "error", text: readableError(e) });
    } finally {
      setExiting(null);
    }
  };

  return (
    <section className={styles.banner} data-tone="auction" aria-live="polite">
      <div className={styles.main}>
        <div className={styles.icon} aria-hidden>
          <span>{fmtBps(d)}</span>
        </div>
        <div className={styles.text}>
          <b>
            Your account is in a liquidation auction · lane {acct.lane + 1} · block +{elapsed}
          </b>
          <span>
            Discount now <span className="mono">{fmtBps(d)}</span> (rises {fmtBps(p.stepBps)} per block, max{" "}
            {fmtBps(p.maxDiscountBps)}) · if taken now you keep ≈{" "}
            <span className="mono">{fmtAusd(keep)}</span> of your <span className="mono">{fmtAusd(equity)}</span> AUSD
            equity ·{" "}
            {toBackstop > 0 ? (
              <>
                the lane backstop can take it in ≈{toBackstop} block{toBackstop === 1 ? "" : "s"} (at{" "}
                {fmtBps(minBps)})
              </>
            ) : toMax > 0 ? (
              <>the lane backstop can take it now</>
            ) : (
              <>at the max discount - expires if nobody takes it</>
            )}
          </span>
          <div className={styles.clock} aria-hidden>
            <i style={{ width: `${(d / p.maxDiscountBps) * 100}%` }} />
            <em style={{ left: `${(minBps / p.maxDiscountBps) * 100}%` }} />
          </div>
        </div>
      </div>
      <div className={styles.cure}>
        <label className={styles.cureInput}>
          <span>Add</span>
          <input
            className="mono"
            inputMode="decimal"
            value={amountStr ?? (suggested > 0 ? suggested.toFixed(2) : "0")}
            onChange={(e) => setAmountStr(e.target.value.replace(/,/g, ".").replace(/[^\d.]/g, ""))}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="AUSD to add"
          />
          <span>AUSD</span>
        </label>
        <button type="button" className={styles.cureBtn} onClick={cure} disabled={busy || reason !== null}>
          {busy ? "Curing…" : (reason ?? (amount > 0 ? "Add collateral to cure" : "Cure now"))}
        </button>
        <small>
          {shortfall > 0 ? (
            <>
              Needs ≥ <span className="mono">{fmtAusd(shortfall)}</span> AUSD to reach maintenance · wallet{" "}
              <span className="mono">{fmtAusd(wallet)}</span>
            </>
          ) : (
            "Healthy again at the current marks - cancel the auction."
          )}
        </small>
      </div>
      {production && acct.positions.length > 0 && (
        <div className={styles.cure}>
          {acct.positions.map((pos) => (
            <span key={pos.symbol} style={{ display: "contents" }}>
              <button
                type="button"
                className={styles.cureBtn}
                disabled={exiting !== null}
                onClick={() => void exit(pos.symbol, 0.5)}
              >
                {exiting === `${pos.symbol}:0.5` ? "Submitting…" : `Reduce ${pos.symbol.split("/")[0]} 50%`}
              </button>
              <button
                type="button"
                className={styles.cureBtn}
                disabled={exiting !== null}
                onClick={() => void exit(pos.symbol, 1)}
              >
                {exiting === `${pos.symbol}:1` ? "Submitting…" : `Close ${pos.symbol.split("/")[0]} ${pos.side}`}
              </button>
            </span>
          ))}
          <small>Reduce-only orders: filled only if they leave you at or above maintenance, which ends the auction.</small>
        </div>
      )}
      <p className={styles.fine}>
        {production
          ? "Frozen while in auction: no new positions or withdrawals. You can add collateral, or reduce / close with a reduce-only order. A cure needs equity at or above maintenance, and not in the auction's first block."
          : "Frozen while in auction: no new positions or withdrawals (deposits are allowed). The discount is set by the block clock, not by gas bidding."}
      </p>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </section>
  );
}

function Outcome({ r, free, onDismiss }: { r: AuctionRecord; free: number | null; onDismiss: () => void }) {
  const p = useAuctionParams();
  const lane = r.lane + 1;
  const blocks = r.resolvedBlock !== null ? r.resolvedBlock - r.startBlock : null;
  let title: string;
  let detail: string;
  const tone = r.status === "cured" ? "cured" : r.status === "expired" ? "expired" : "taken";
  if (r.status === "backstop" || r.status === "external") {
    const by =
      r.status === "backstop"
        ? `the lane ${lane} backstop`
        : r.taker && demoTakers.has(r.taker)
          ? `${r.taker.slice(0, 6)}…${r.taker.slice(-4)} (a demo taker bot run by the keeper)`
          : `${r.taker ? `${r.taker.slice(0, 6)}…${r.taker.slice(-4)}` : "an external taker"} (same-lane taker)`;
    title = `Taken by ${by} at ${fmtBps(r.discountBps ?? 0)} · you kept ${fmtAusd(r.traderResidual ?? 0)} AUSD`;
    detail =
      (r.traderResidual ?? 0) > 0
        ? `Your positions moved to the taker at the oracle mark${blocks !== null ? ` after ${blocks} block${blocks === 1 ? "" : "s"}` : ""}; the rest of your equity stayed with you as free collateral.`
        : "The discount was at least your remaining equity, so nothing was left over. You never lose more than your equity: any negative equity is written off against the lane (insurance first, then lane bad debt), never charged to you.";
  } else if (r.status === "cured") {
    title = "Auction cured - your account is healthy again";
    detail = "The auction was cancelled (top-up or price recovery). Your positions are unchanged and the account is unfrozen.";
  } else {
    title = `Auction expired at ${fmtBps(p.maxDiscountBps)} with no taker`;
    detail = `Your positions were closed at the mark against lane ${lane} through the fallback path (1% penalty, capped at your equity; any negative equity is written off against the lane, not charged to you).${
      free !== null ? ` Free collateral now: ${fmtAusd(free)} AUSD.` : ""
    }`;
  }
  return (
    <section className={styles.banner} data-tone={tone}>
      <div className={styles.main}>
        <div className={styles.icon} aria-hidden data-tone={tone}>
          <svg width="18" height="18" viewBox="0 0 24 24">
            {tone === "expired" ? (
              <path d="M12 7v6M12 16.5v.1" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
            ) : (
              <path d="M5 12.5 10 17.5 19 7" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
            )}
          </svg>
        </div>
        <div className={styles.text}>
          <b>{title}</b>
          <span>
            {detail} {r.resolvedBlock !== null && <>Block #{r.resolvedBlock} · </>}
            <TxLink hash={r.txHash} />
          </span>
        </div>
        <button type="button" className={styles.dismiss} onClick={onDismiss} aria-label="Dismiss">
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </section>
  );
}
