"use client";

// The account's delayed orders: submitted → waiting for the next Pyth price →
// filled at X, or not filled inside the window → cancel. Times come from chain
// time (latest block timestamp), not this browser's clock.

import { useState, type ReactNode } from "react";
import { formatEther } from "viem";
import { useParaclr } from "@/lib/store";
import { NETWORK } from "@/lib/chain/config";
import { readableError } from "@/lib/chain/errors";
import { priceToNumber } from "@/lib/chain/units";
import { chainNow } from "@/lib/chain/prod/state";
import {
  cancelOrder,
  dismissOrder,
  isFinal,
  orderLabelId,
  useOrders,
  type TrackedOrder,
} from "@/lib/chain/prod/orders";
import { Notice, TxLink } from "@/components/chain/ChainUi";
import { fmtAusd, fmtPrice, fmtSigned } from "@/components/trade/format";
import { fmtDuration, useNow, usePriceName } from "./util";
import styles from "./Prod.module.css";

const PHASE_LABEL: Record<TrackedOrder["phase"], string> = {
  signing: "Submitting",
  waiting: "Waiting for the next price",
  executing: "Executing",
  filled: "Filled",
  failed: "Not filled",
  expired: "Window passed",
  cancelled: "Cancelled",
  settled: "Settled",
  rejected: "Not submitted",
};

/** A keeper that hasn't filled an executable order after this long is "late". */
const LATE_AFTER_S = 15;

export function PendingOrders({ max = 5 }: { max?: number }) {
  const orders = useOrders();
  const shown = [...orders].reverse().slice(0, max);
  const finals = orders.filter(isFinal);
  if (shown.length === 0) return null;
  return (
    <section className={styles.orders} aria-label="Orders" aria-live="polite">
      <header className={styles.ordersHead}>
        <span>Orders</span>
        {finals.length > 0 && (
          <button type="button" onClick={() => finals.forEach((o) => dismissOrder(o.key))}>
            Clear finished
          </button>
        )}
      </header>
      {shown.map((o) => (
        <OrderRow key={o.key} o={o} />
      ))}
    </section>
  );
}

function OrderRow({ o }: { o: TrackedOrder }) {
  const prod = useParaclr((s) => s.chain.prod);
  const walletReady = useParaclr((s) => s.chain.wallet.ready);
  const keeperOnline = useParaclr((s) => s.chain.keeper.status === "online");
  const pn = usePriceName();
  const now = useNow(500);
  const [busy, setBusy] = useState<null | "cancel">(null);
  const [error, setError] = useState<string | null>(null);

  const t = prod ? chainNow(prod, now) : null;
  const min = prod?.params.minExecDelay ?? null;
  const max = prod?.params.maxExecDelay ?? null;
  const commitTime = o.execAfter !== null && min !== null ? o.execAfter - min : null;
  const toEligible = t !== null && o.execAfter !== null ? Math.max(0, o.execAfter - t) : null;
  const toExpiry = t !== null && o.deadline !== null ? Math.max(0, o.deadline - t) : null;
  const sinceEligible = t !== null && o.execAfter !== null ? t - o.execAfter : null;

  // Step progress: submitted | waiting for price | filled.
  const p1 = o.phase === "signing" ? 0.5 : 1;
  const p2 =
    o.phase === "waiting" && t !== null && commitTime !== null && min
      ? Math.min(1, Math.max(0, (t - commitTime) / min))
      : o.phase === "signing" || o.phase === "rejected"
        ? 0
        : 1;
  const p3 =
    o.phase === "filled"
      ? 1
      : o.phase === "executing" && sinceEligible !== null && o.deadline !== null && o.execAfter !== null
        ? Math.min(0.95, Math.max(0.05, sinceEligible / Math.max(1, o.deadline - o.execAfter)))
        : 0;
  const late = o.phase === "executing" && sinceEligible !== null && sinceEligible > LATE_AFTER_S;
  const base = o.symbol.split("/")[0];
  const acceptable = o.acceptablePrice > BigInt(0) ? priceToNumber(o.acceptablePrice) : null;
  const buy = o.sizeDelta >= BigInt(0);

  const cancel = async () => {
    setBusy("cancel");
    setError(null);
    try {
      await cancelOrder(o);
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(null);
    }
  };

  let msg: ReactNode;
  switch (o.phase) {
    case "signing":
      msg = "Confirm in your wallet, then the order is committed on chain.";
      break;
    case "waiting":
      msg = (
        <>
          Submitted. It fills at the first {pn} published{" "}
          {min !== null ? <b>{fmtDuration(min)}</b> : "a few seconds"} or more after your order
          {toEligible !== null ? (
            <>
              {" "}
              — eligible in <b className="mono">{fmtDuration(toEligible)}</b>
            </>
          ) : null}
          .
        </>
      );
      break;
    case "executing":
      msg = (
        <>
          Waiting for the keeper to fill it with that {pn}
          {toExpiry !== null ? (
            <>
              {" "}
              · window closes in <b className="mono">{fmtDuration(toExpiry)}</b>
            </>
          ) : null}
          {late
            ? keeperOnline
              ? " · the keeper is late; if nobody fills it before the window closes, cancel it to get the fee back"
              : " · keeper offline; if nobody fills it before the window closes, cancel it to get the fee back"
            : ""}
          .
        </>
      );
      break;
    case "filled":
      msg = (
        <>
          Filled at <b className="mono">{fmtPrice(o.symbol, o.fillPrice)}</b>
          {o.publishTime !== null ? <> ({pn} of {new Date(o.publishTime * 1000).toISOString().slice(11, 19)} UTC)</> : null}
          {o.tradingFee !== null ? (
            <>
              {" "}
              · trading fee <b className="mono">{fmtAusd(o.tradingFee, 4)}</b> AUSD
            </>
          ) : null}
          {o.realizedPnl !== null && o.kind !== "increase" ? (
            <>
              {" "}
              · realized <b className="mono">{fmtSigned(o.realizedPnl)}</b> AUSD
            </>
          ) : null}
          {o.fillBlock !== null ? <> · block #{o.fillBlock}</> : null}.
        </>
      );
      break;
    case "failed":
      msg = (
        <>
          Executed with the {pn} but not filled: {(o.error ?? "the contract rejected the fill").replace(/\.$/, "")}. Nothing was
          traded; the margin escrow is released (the execution fee paid the executor).
        </>
      );
      break;
    case "expired":
      msg = (
        <>
          Nobody executed it within {max !== null ? fmtDuration(max) : "the window"} (keeper down or late). Cancel it
          to release the escrowed margin and get the execution fee back.
        </>
      );
      break;
    case "cancelled":
      msg = "Cancelled · margin escrow released, execution fee refunded.";
      break;
    case "settled":
      msg = o.error ?? "No longer pending — see your positions for the result.";
      break;
    case "rejected":
      msg = o.error ?? "The order wasn't submitted.";
      break;
  }

  return (
    <article className={styles.order} data-phase={o.phase}>
      <div className={styles.orderTop}>
        <b>{o.label}</b>
        <span className={styles.phase}>
          <i aria-hidden />
          {PHASE_LABEL[o.phase]}
        </span>
      </div>
      {(o.phase === "signing" || o.phase === "waiting" || o.phase === "executing" || o.phase === "filled") && (
        <>
          <div className={styles.steps} aria-hidden>
            <span className={styles.step}>
              <span style={{ width: `${p1 * 100}%` }} />
            </span>
            <span className={styles.step}>
              <span style={{ width: `${p2 * 100}%` }} />
            </span>
            <span className={styles.step}>
              <span style={{ width: `${p3 * 100}%` }} />
            </span>
          </div>
          <div className={styles.stepLabels}>
            <span data-on={p1 >= 1 ? "" : undefined}>Submitted</span>
            <span data-on={p2 >= 1 ? "" : undefined}>Next {pn}</span>
            <span data-on={o.phase === "filled" ? "" : undefined}>Filled</span>
          </div>
        </>
      )}
      <p className={styles.orderMsg}>{msg}</p>
      <div className={styles.orderMeta}>
        {o.orderId !== null && <span className="mono">{orderLabelId(o)}</span>}
        {acceptable !== null && (
          <span>
            {buy ? "max" : "min"} <span className="mono">{fmtPrice(o.symbol, acceptable)}</span> {base}
          </span>
        )}
        {o.executionFee > BigInt(0) && (
          <span>
            exec fee <span className="mono">{Number(formatEther(o.executionFee)).toLocaleString("en-US", { maximumFractionDigits: 6 })}</span>{" "}
            {NETWORK?.nativeSymbol ?? "MON"}
          </span>
        )}
        {o.commitTx && (
          <span>
            commit <TxLink hash={o.commitTx} />
          </span>
        )}
        {o.fillTx && (
          <span>
            {o.phase === "failed" ? "execution" : "fill"} <TxLink hash={o.fillTx} />
          </span>
        )}
        {o.cancelTx && (
          <span>
            cancel <TxLink hash={o.cancelTx} />
          </span>
        )}
      </div>
      {(o.phase === "expired" || o.phase === "executing" || isFinal(o)) && (
        <div className={styles.orderActions}>
          {o.phase === "executing" && (
            <button type="button" disabled title="Cancelling is possible only after the execution window (no free option).">
              Cancel in {toExpiry !== null ? fmtDuration(toExpiry + 1) : "…"}
            </button>
          )}
          {o.phase === "expired" && (
            <button type="button" data-primary="" disabled={busy !== null || !walletReady} onClick={cancel}>
              {busy === "cancel" ? "Cancelling…" : "Cancel order"}
            </button>
          )}
          {isFinal(o) && (
            <button type="button" onClick={() => dismissOrder(o.key)}>
              Dismiss
            </button>
          )}
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </article>
  );
}
