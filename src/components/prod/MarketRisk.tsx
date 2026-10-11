"use client";

// Production market strip under the ticker: funding rate and next accrual,
// this lane's open interest against its cap, and how old the Pyth price
// stored on chain is (the one position views are valued at between updates).

import type { MarketSymbol } from "@/lib/types";
import { useParaclr } from "@/lib/store";
import { chainNow, fundingPctPerHour } from "@/lib/chain/prod/state";
import { fmtCompact } from "@/components/trade/format";
import { fmtDuration, useNow } from "./util";
import styles from "./Prod.module.css";

/** "fresh" under the contract's stored-price window, else "last pushed 45s ago" / "last pushed 64h 52m ago". */
function fmtPushed(age: number | null, freshUnder: number): string {
  if (age === null) return "-";
  if (age < freshUnder) return "fresh";
  return `last pushed ${age < 120 ? `${Math.round(age)}s` : fmtDuration(age)} ago`;
}

/** The keeper's funding policy skips `updateFunding` while the rate change is under its threshold and the market is idle. */
function fundingSkipped(reason: string | undefined): boolean {
  return reason === "unchanged" || reason === "idle" || reason === "skipped";
}

export function MarketRisk({ symbol }: { symbol: MarketSymbol }) {
  const prod = useParaclr((s) => s.chain.prod);
  // Testnet after the Pyth data trial: the stored price comes from the keeper-signed fallback oracle.
  const keeperSigned = useParaclr((s) => s.chain.contracts?.oracleKind === "keeper-signed");
  const lane = useParaclr((s) => s.chain.account?.lane ?? null);
  // The keeper's reason for sending or skipping updateFunding this tick (null while the keeper is unreachable).
  const keeperFunding = useParaclr((s) => s.chain.keeper.health?.funding?.markets?.[symbol] ?? null);
  const minChangeBps = useParaclr((s) => s.chain.keeper.health?.funding?.policy?.minChangeBps ?? null);
  const keeperInterval = useParaclr((s) => s.chain.keeper.health?.funding?.interval ?? null);
  const now = useNow(1_000);
  if (!prod) return null;

  const m = prod.markets[symbol];
  const raw = fundingPctPerHour(m.fundingRatePerSec);
  // Below display precision reads as balanced, not "−0.0000%".
  const pct = raw !== null && Math.abs(raw) < 0.00005 ? 0 : raw;
  const t = chainNow(prod, now);
  // The contract's fundingUpdateInterval; the keeper reports the same value when the chain read is missing.
  const interval = prod.params.fundingInterval ?? keeperInterval;
  const next = m.nextFundingUpdate !== null && t !== null ? m.nextFundingUpdate - t : null;
  // "due" on chain only means updateFunding *may* be called; the keeper skips it while nothing changed.
  const skipped = next !== null && next <= 0 && fundingSkipped(keeperFunding?.reason);
  const lastUpdate = keeperFunding?.lastUpdate ?? m.lastFundingUpdate;
  const sinceUpdate = lastUpdate !== null && lastUpdate !== undefined && t !== null ? Math.max(0, t - lastUpdate) : null;
  const cap = prod.lane?.oiCap[symbol] ?? null;
  const oi = prod.lane?.oi[symbol] ?? null;
  const used = oi ? Math.max(oi.long, oi.short) : null;
  const util = cap && used !== null ? Math.min(1, used / cap) : null;
  const age = m.onchainPublishTime !== null && t !== null ? Math.max(0, t - m.onchainPublishTime) : null;
  const storedWindow = prod.params.maxStoredPriceAge ?? 15;
  const everyLine = interval !== null ? `at most every ${fmtDuration(interval)}` : "interval unknown";

  return (
    <div className={styles.mstrip} aria-label="Funding and limits">
      <div
        className={styles.mcell}
        data-tone={pct === null || pct === 0 ? undefined : pct > 0 ? "short" : "long"}
        title="Funding from the global long/short skew (sum of all 8 lanes). Positive: longs pay shorts."
      >
        <small>Funding / 1h</small>
        <b className="mono">{pct === null ? "-" : `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct).toFixed(4)}%`}</b>
        <em>{pct === null ? "not readable" : pct > 0 ? "longs pay shorts" : pct < 0 ? "shorts pay longs" : "balanced"}</em>
      </div>
      <div
        className={styles.mcell}
        title={`Funding accrues continuously at the current rate; the rate is re-set from the global skew by updateFunding (anyone, at most once per interval). The keeper only sends it when the rate would move by more than ${
          minChangeBps !== null ? `${minChangeBps} bps` : "its threshold"
        } or the market has traded, so "no change needed" means the skew still matches the stored rate. Positions settle funding when touched.`}
      >
        <small>Next rate update</small>
        <b className="mono">{next === null ? "-" : skipped ? "no change needed" : next <= 0 ? "due" : fmtDuration(next)}</b>
        <em>{skipped && sinceUpdate !== null ? `last ${fmtDuration(sinceUpdate)} ago · ${everyLine}` : everyLine}</em>
      </div>
      <div
        className={styles.mcell}
        title="Open interest of your lane in this market vs its per-side cap: min(market cap, (lane insurance + backstop cash) × multiplier)."
      >
        <small>L{lane !== null ? lane : "-"} OI</small>
        <b className="mono">
          {oi ? `${fmtCompact(oi.long)} L · ${fmtCompact(oi.short)} S` : "-"}
        </b>
        <em>{cap !== null ? `cap ${fmtCompact(cap)}${util !== null ? ` · ${(util * 100).toFixed(0)}% used` : ""}` : "cap unknown"}</em>
      </div>
      <div
        className={styles.mcell}
        title={`${
          keeperSigned ? "The keeper-signed price" : "Pyth"
        } runs in on-demand (push) mode: nothing refreshes the price stored on chain on a timer. Every fill, auction take and withdrawal carries a fresh signed update in its own transaction and stores it, so the stored copy is only as old as the last on-chain action. The contract's views (health, free collateral) use the stored copy while it is younger than ${fmtDuration(
          storedWindow,
        )}; after that, every transaction brings its own update, so an old stored price never prices a trade.`}
      >
        <small>{keeperSigned ? "Stored price (simulated)" : "Stored Pyth price"}</small>
        <b className="mono">{fmtPushed(age, storedWindow)}</b>
        <em>every fill carries a fresh signed update</em>
      </div>
    </div>
  );
}
