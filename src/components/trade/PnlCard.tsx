"use client";

// The PnL card that pops up when a position closes: the image from /api/pnl-card plus Share on X
// (a link to /pnl, whose preview is the card), Download and Copy link. Production closes are
// delayed orders, so the card opens when the keeper fills the close order; the demo and local
// chain modes open it from the close itself (TradeScreen). Viewers can turn it off.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { NETWORK } from "@/lib/chain/config";
import { useOrders } from "@/lib/chain/prod/orders";
import { cardQuery, fmtSignedPct, narration, type CardNetwork, type PnlCardData } from "@/lib/pnlCard";
import type { Position } from "@/lib/types";
import styles from "./PnlCard.module.css";

const OFF_KEY = "paraclr.pnlcard.off";

let current: PnlCardData | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function cardsOff(): boolean {
  try {
    return window.localStorage.getItem(OFF_KEY) === "1";
  } catch {
    return false;
  }
}

export function showPnlCard(d: PnlCardData) {
  if (cardsOff()) return;
  current = d;
  emit();
}

function closeCard() {
  current = null;
  emit();
}

function useCard(): PnlCardData | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
}

export function cardNetwork(chainLive: boolean): CardNetwork {
  if (!chainLive || !NETWORK) return "demo";
  if (NETWORK.isTestnetProd) return NETWORK.sandbox ? "local" : "testnet";
  if (NETWORK.isMainnet) return NETWORK.local ? "local" : "mainnet";
  return NETWORK.mode === "monad" ? "testnet" : "local";
}

/** A card for a position closed in one go (demo / local chain modes). */
export function cardFromPosition(p: Position, realized: number, chainLive: boolean): PnlCardData {
  const perUnit = p.size > 0 ? realized / p.size : 0;
  return {
    symbol: p.symbol,
    side: p.side,
    leverage: p.leverage,
    entry: p.entryPrice,
    exit: p.side === "long" ? p.entryPrice + perUnit : p.entryPrice - perUnit,
    pnl: realized,
    pnlPct: p.margin > 0 ? (realized / p.margin) * 100 : 0,
    network: cardNetwork(chainLive),
    at: Math.floor(Date.now() / 1000),
  };
}

/** Production: open the card when a close order fills (orders already final at mount are ignored). */
function useCloseFills() {
  const orders = useOrders();
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (seen.current === null) {
      seen.current = new Set(orders.filter((o) => o.phase !== "signing" && o.phase !== "waiting" && o.phase !== "executing").map((o) => o.key));
      return;
    }
    for (const o of orders) {
      if (o.kind !== "close" || o.phase !== "filled" || seen.current.has(o.key)) continue;
      seen.current.add(o.key);
      const pos = o.position;
      if (!pos || o.fillPrice === null || o.realizedPnl === null) continue;
      showPnlCard({
        symbol: o.symbol,
        side: o.side,
        leverage: o.leverage ?? 1,
        entry: pos.entryPrice,
        exit: o.fillPrice,
        pnl: o.realizedPnl,
        pnlPct: pos.margin > 0 ? (o.realizedPnl / pos.margin) * 100 : 0,
        network: cardNetwork(true),
        at: Math.floor(Date.now() / 1000),
      });
    }
  }, [orders]);
}

export function PnlCardHost() {
  useCloseFills();
  const card = useCard();
  // Keyed by the card, so each new card starts with fresh dialog state.
  return card ? <CardDialog key={cardQuery(card)} card={card} /> : null;
}

function CardDialog({ card }: { card: PnlCardData }) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const closeBtn = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeCard();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const q = cardQuery(card);
  const image = `/api/pnl-card?${q}`;
  const shareUrl = `${window.location.origin}/pnl?${q}`;
  const base = card.symbol.replace("/AUSD", "");
  const line = narration(card);
  const tweet =
    `${line}\n\n${fmtSignedPct(card.pnlPct)} on ${base}-PERP ${card.side === "long" ? "long" : "short"} ` +
    `${card.leverage.toLocaleString("en-US", { maximumFractionDigits: 1 })}x with @Paraclr` +
    (card.network === "testnet" ? " (Monad testnet, test funds)" : card.network === "mainnet" ? "" : " (demo)");

  const download = async () => {
    setBusy(true);
    try {
      const blob = await (await fetch(image)).blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `paraclr-${base.toLowerCase()}-${fmtSignedPct(card.pnlPct).replace(/[^0-9a-z.+-]/gi, "")}.png`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <div className={styles.overlay} onClick={closeCard}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={`Position closed: ${fmtSignedPct(card.pnlPct)} on ${base}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={styles.card} src={image} width={1200} height={630} alt={`${base} ${card.side} closed, ${fmtSignedPct(card.pnlPct)}. ${line}`} />
        <div className={styles.actions}>
          <a
            className={styles.primary}
            href={`https://x.com/intent/post?text=${encodeURIComponent(tweet)}&url=${encodeURIComponent(shareUrl)}`}
            target="_blank"
            rel="noreferrer"
          >
            Share on X
          </a>
          <button type="button" className={styles.secondary} onClick={download} disabled={busy}>
            {busy ? "Saving…" : "Download"}
          </button>
          <button type="button" className={styles.secondary} onClick={copy}>
            {copied ? "Link copied" : "Copy link"}
          </button>
          <button ref={closeBtn} type="button" className={styles.ghost} onClick={closeCard}>
            Close
          </button>
        </div>
        <label className={styles.off}>
          <input
            type="checkbox"
            onChange={(e) => {
              try {
                window.localStorage.setItem(OFF_KEY, e.target.checked ? "1" : "0");
              } catch {
                /* storage blocked */
              }
            }}
          />
          Don&apos;t show a card when I close a position
        </label>
      </div>
    </div>
  );
}
