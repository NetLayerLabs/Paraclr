"use client";

// Desktop counterpart of SwipeToTrade: a plain, prominent submit button
// ("Long 10x MON"), always labelled with what it does; when it can't be used
// yet it goes muted and the reason sits on a state line under it. Same contract - onConfirm may be sync (sim) or async (an
// on-chain transaction) - and the same idle → pending → done/failed states.
// Enter / Space work because it is a native button.

import { useEffect, useId, useRef, useState } from "react";
import type { TradeSubmitProps } from "./SwipeToTrade";
import styles from "./TradeButton.module.css";

type Status = "idle" | "pending" | "done" | "failed";

/**
 * The line under a submit control saying why it can't be used yet (the Arena's state line): a dot
 * and one sentence. Polite live region, so a change of reason is announced once.
 */
export function StateLine({ id, reason }: { id?: string; reason: string | null | undefined }) {
  return (
    <p id={id} className={styles.state} aria-live="polite" data-empty={reason ? undefined : ""}>
      {reason ? (
        <>
          <i aria-hidden="true" />
          <span>{reason}</span>
        </>
      ) : null}
    </p>
  );
}

export function TradeButton({ side, label, disabledReason, doneLabel, pendingLabel, onConfirm }: TradeSubmitProps) {
  const [status, setStatus] = useState<Status>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const disabled = !!disabledReason;
  const stateId = useId();

  const finish = (ok: boolean) => {
    setStatus(ok ? "done" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus("idle"), ok ? 1400 : 900);
  };

  const submit = () => {
    if (disabled || status !== "idle") return;
    const result = onConfirm();
    if (typeof result === "boolean") {
      finish(result);
      return;
    }
    setStatus("pending");
    result.then(finish, () => finish(false));
  };

  const text =
    status === "done"
      ? doneLabel
      : status === "pending"
        ? (pendingLabel ?? "Confirming…")
        : status === "failed"
          ? "Order rejected"
          : label;

  return (
    <>
      <button
        type="button"
        className={[
          styles.btn,
          side === "long" ? styles.long : styles.short,
          disabled && status === "idle" ? styles.disabled : "",
          status !== "idle" ? styles[status] : "",
        ].join(" ")}
        disabled={disabled || status !== "idle"}
        aria-live="polite"
        aria-describedby={disabled ? stateId : undefined}
        onClick={submit}
      >
        {status === "pending" ? (
          <span className={styles.spinner} aria-hidden />
        ) : status === "done" ? (
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
            <path
              d="M5 12.5 10 17.5 19 7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
        <span>{text}</span>
      </button>
      <StateLine id={stateId} reason={status === "idle" ? disabledReason : null} />
    </>
  );
}
