"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import type { Side } from "@/lib/types";
import { StateLine } from "./TradeButton";
import styles from "./SwipeToTrade.module.css";

const THUMB = 52;
const INSET = 4;
const COMMIT_AT = 0.88;

function vibrate(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
  }
}

/** Shared by SwipeToTrade (touch / phone) and TradeButton (mouse, tablet and up). */
export interface TradeSubmitProps {
  side: Side;
  label: string;
  /** Replaces the label when the order can't be placed. */
  disabledReason?: string | null;
  doneLabel: string;
  /** Shown while an async confirm (on-chain transaction) is in flight. */
  pendingLabel?: string;
  /** Return true if the order went through. May be async (chain modes). */
  onConfirm: () => boolean | Promise<boolean>;
}

type Status = "idle" | "dragging" | "pending" | "done" | "failed";

export function SwipeToTrade({ side, label, disabledReason, doneLabel, pendingLabel, onConfirm }: TradeSubmitProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; armed: boolean } | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [trackW, setTrackW] = useState(340);
  const [x, setX] = useState(0);
  const [status, setStatus] = useState<Status>("idle");

  const maxX = Math.max(1, trackW - THUMB - INSET * 2);
  const progress = Math.min(1, x / maxX);
  const disabled = !!disabledReason;

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setTrackW(e.contentRect.width));
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(resetTimer.current);
    };
  }, []);

  const settle = (result: boolean | Promise<boolean>) => {
    if (typeof result === "boolean") {
      finish(result);
      return;
    }
    setStatus("pending");
    setX(maxX);
    vibrate(8);
    result.then(finish, () => finish(false));
  };

  const finish = (ok: boolean) => {
    setStatus(ok ? "done" : "failed");
    setX(ok ? maxX : 0);
    vibrate(ok ? [12, 40, 22] : [40, 30, 40]);
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(
      () => {
        setStatus("idle");
        setX(0);
      },
      ok ? 1400 : 700,
    );
  };

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || status === "done" || status === "pending") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX - x, armed: false };
    setStatus("dragging");
    vibrate(6);
  };

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const nx = Math.min(maxX, Math.max(0, e.clientX - d.startX));
    // A tick of haptic feedback the moment the swipe is far enough to commit.
    const armed = nx / maxX >= COMMIT_AT;
    if (armed && !d.armed) vibrate(10);
    d.armed = armed;
    setX(nx);
  };

  const onUp = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (x / maxX >= COMMIT_AT) {
      settle(onConfirm());
    } else {
      setStatus("idle");
      setX(0);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || status === "done" || status === "pending") return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      settle(onConfirm());
    }
  };

  const dragging = status === "dragging";
  const text =
    status === "done"
      ? doneLabel
      : status === "pending"
        ? (pendingLabel ?? "Confirming…")
        : status === "failed"
          ? "Order rejected"
          : label;

  const vars = {
    "--x": `${x}px`,
    "--p": progress,
  } as CSSProperties;

  return (
    <>
      <div
        ref={trackRef}
        className={[
          styles.track,
          side === "long" ? styles.long : styles.short,
          disabled ? styles.disabled : "",
          dragging ? styles.dragging : "",
          status === "done" || status === "pending" ? styles.done : "",
          status === "pending" ? styles.pending : "",
          status === "failed" ? styles.failed : "",
        ].join(" ")}
        style={vars}
      >
        <div className={styles.fill} />
        <span className={styles.label} aria-live="polite">
          <span className={disabled || status !== "idle" ? undefined : styles.shimmer}>{text}</span>
        </span>
        <div
          className={styles.thumb}
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled}
          aria-label={disabled ? (disabledReason ?? label) : `${label}. Press Enter to confirm.`}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onKeyDown={onKey}
        >
          {status === "done" ? (
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
              <path
                d="M5 12.5 10 17.5 19 7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
              <path
                d="M6 6l6 6-6 6M12 6l6 6-6 6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </div>
      </div>
      <StateLine reason={status === "idle" ? disabledReason : null} />
    </>
  );
}
