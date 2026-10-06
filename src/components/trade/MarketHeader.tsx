"use client";

import { useEffect, useMemo, useState } from "react";
import { MARKETS, type MarketSymbol } from "@/lib/types";
import { selectMarket, useParaclr } from "@/lib/store";
import { useMarketFeed } from "@/lib/prices/feedStore";
import { MARKET_META } from "@/lib/prices/markets";
import { NETWORK } from "@/lib/chain/config";
import { fmtPct, fmtPrice } from "./format";
import styles from "./MarketHeader.module.css";

function changePct(last: number | null, open: number | null): number | null {
  if (last == null || open == null || open === 0) return null;
  return ((last - open) / open) * 100;
}

function MarketPill({ symbol, active }: { symbol: MarketSymbol; active: boolean }) {
  const feed = useMarketFeed(symbol);
  const chg = changePct(feed.last, feed.dayOpen);
  const meta = MARKET_META[symbol];
  return (
    <button
      type="button"
      className={active ? `${styles.pill} ${styles.pillActive}` : styles.pill}
      onClick={() => selectMarket(symbol)}
      aria-pressed={active}
    >
      <span className={styles.pillBase}>{meta.base}</span>
      {chg != null && (
        <span className={`mono ${chg >= 0 ? styles.up : styles.down}`}>{fmtPct(chg)}</span>
      )}
    </button>
  );
}

function ChainlinkMark() {
  // Hexagon mark (generic, not the trademark artwork).
  return (
    <svg width="14" height="16" viewBox="0 0 14 16" aria-hidden>
      <path
        d="M7 1.2 12.6 4.4v7.2L7 14.8 1.4 11.6V4.4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BlockMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <rect x="1.5" y="1.5" width="11" height="11" rx="2.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M4.5 7h5M7 4.5v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Chain modes: the price is read from the oracle contract the clearinghouse
 * settles against (MockOracle, pushed by the keeper) — not Chainlink. Age has
 * 1s resolution because `updatedAt` is a block timestamp.
 */
function OracleBadge({ symbol }: { symbol: MarketSymbol }) {
  const feed = useMarketFeed(symbol);
  const [now, setNow] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  const age = feed.observedAt && now ? Math.max(0, now - feed.observedAt) : null;
  const tone =
    age == null ? styles.dotIdle : age < 3_000 ? styles.dotLive : age < 10_000 ? styles.dotWarn : styles.dotStale;
  const net = NETWORK?.isMonad ? "Monad testnet" : "local anvil";

  return (
    <div
      className={`${styles.badge} ${styles.badgeOracle}`}
      title={`On-chain oracle on ${NETWORK?.label ?? "chain"}: MockOracle prices pushed by the keeper. These are the marks the clearinghouse uses for margin and liquidation.`}
    >
      <span className={styles.badgeBrand}>
        <BlockMark />
      </span>
      <span className={styles.badgeText}>
        On-chain oracle <span className={styles.badgeSep}>·</span> {net}
      </span>
      <span className={styles.badgeAge}>
        <span className={`${styles.dot} ${tone}`} />
        <span className="mono">
          {age == null ? "—" : age < 60_000 ? `${Math.floor(age / 1000)}s` : "stale"}
        </span>
      </span>
    </div>
  );
}

export function LatencyBadge({ symbol }: { symbol: MarketSymbol }) {
  const feed = useMarketFeed(symbol);
  if (feed.source === "oracle") return <OracleBadge symbol={symbol} />;
  return <StreamsBadge symbol={symbol} />;
}

function StreamsBadge({ symbol }: { symbol: MarketSymbol }) {
  const feed = useMarketFeed(symbol);
  const [now, setNow] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 50);
    return () => clearInterval(id);
  }, []);

  const age = feed.observedAt && now ? Math.max(0, now - feed.observedAt) : null;
  const tone =
    age == null ? styles.dotIdle : age < 800 ? styles.dotLive : age < 2000 ? styles.dotWarn : styles.dotStale;

  return (
    <div className={styles.badge} title="Tick age: time since the oracle observation">
      <span className={styles.badgeBrand}>
        <ChainlinkMark />
      </span>
      <span className={styles.badgeText}>
        Chainlink Data Streams <span className={styles.badgeSep}>·</span> sub-second
      </span>
      {feed.source === "simulated" && <span className={styles.simTag}>SIM</span>}
      <span className={styles.badgeAge}>
        <span className={`${styles.dot} ${tone}`} />
        <span className="mono">{age == null ? "—" : age < 10_000 ? `${age}ms` : "stale"}</span>
      </span>
    </div>
  );
}

export function MarketHeader({ symbol }: { symbol: MarketSymbol }) {
  const feed = useMarketFeed(symbol);
  const tickPrice = useParaclr((s) => s.prices[symbol]?.price ?? null);
  const price = tickPrice ?? feed.last;
  const chg = changePct(price, feed.dayOpen);
  const meta = MARKET_META[symbol];

  const { hi, lo } = useMemo(() => {
    let hi = -Infinity;
    let lo = Infinity;
    for (const c of feed.candles) {
      if (c.high > hi) hi = c.high;
      if (c.low < lo) lo = c.low;
    }
    return { hi: Number.isFinite(hi) ? hi : null, lo: Number.isFinite(lo) ? lo : null };
  }, [feed.candles]);

  const isOracle = feed.source === "oracle";
  const dirClass = feed.dir > 0 ? styles.up : feed.dir < 0 ? styles.down : "";
  const flashClass = feed.dir > 0 ? styles.flashUp : feed.dir < 0 ? styles.flashDown : "";

  return (
    <header className={styles.header}>
      <div className={styles.pills} role="group" aria-label="Markets">
        {MARKETS.map((m) => (
          <MarketPill key={m} symbol={m} active={m === symbol} />
        ))}
      </div>

      <div className={styles.titleRow}>
        <div className={styles.pair}>
          <span className={styles.pairBase}>{meta.base}</span>
          <span className={styles.pairQuote}>/ AUSD</span>
          <span className={styles.perpTag}>PERP</span>
        </div>
        <span className={styles.venue}>
          {NETWORK && isOracle ? (NETWORK.isMonad ? "Monad testnet" : "Local anvil (not Monad)") : "Monad"} ·
          AUSD-margined
        </span>
      </div>

      <div className={styles.priceRow}>
        <span key={feed.ticks} className={`mono ${styles.price} ${dirClass} ${flashClass}`}>
          {fmtPrice(symbol, price)}
        </span>
        {chg != null && (
          <span className={`${styles.change} ${chg >= 0 ? styles.changeUp : styles.changeDown}`}>
            <span className="mono">{fmtPct(chg)}</span>
            <span
              className={styles.changeLabel}
              title={
                isOracle
                  ? "Change since the first on-chain price this session loaded"
                  : "Simulation mode: change vs a simulated reference price, not real 24h market data"
              }
            >
              {isOracle ? "session" : "sim"}
            </span>
          </span>
        )}
      </div>

      <LatencyBadge symbol={symbol} />

      <div className={styles.stats}>
        <div className={styles.stat}>
          <span className={styles.statLabel}>5m High</span>
          <span className="mono">{fmtPrice(symbol, hi)}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>5m Low</span>
          <span className="mono">{fmtPrice(symbol, lo)}</span>
        </div>
        {isOracle ? (
          <div className={styles.stat}>
            <span className={styles.statLabel}>Read at block</span>
            <span className="mono">{feed.block != null ? `#${feed.block}` : "—"}</span>
          </div>
        ) : (
          <div className={styles.stat}>
            <span className={styles.statLabel}>Delivery</span>
            <span className="mono">{feed.ticks ? `${feed.latencyMs}ms` : "—"}</span>
          </div>
        )}
        {/* Desktop hides this one: the price-source badge beside it says the same. */}
        <div className={`${styles.stat} ${styles.statSource}`}>
          <span className={styles.statLabel}>Oracle</span>
          <span>
            {feed.source === "chainlink"
              ? "Chainlink"
              : feed.source === "oracle"
                ? "On-chain"
                : feed.source
                  ? "Simulated"
                  : "—"}
          </span>
        </div>
      </div>
    </header>
  );
}
