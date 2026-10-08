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

export function MarketRisk({ symbol }: { symbol: MarketSymbol }) {
  const prod = useParaclr((s) => s.chain.prod);
  // Testnet after the Pyth data trial: the stored price comes from the keeper-signed fallback oracle.
  const keeperSigned = useParaclr((s) => s.chain.contracts?.oracleKind === "keeper-signed");
  const lane = useParaclr((s) => s.chain.account?.lane ?? null);
  const now = useNow(1_000);
  if (!prod) return null;

  const m = prod.markets[symbol];
  const raw = fundingPctPerHour(m.fundingRatePerSec);
  // Below display precision reads as balanced, not "−0.0000%".
  const pct = raw !== null && Math.abs(raw) < 0.00005 ? 0 : raw;
  const t = chainNow(prod, now);
  const interval = prod.params.fundingInterval;
  const next = m.nextFundingUpdate !== null && t !== null ? m.nextFundingUpdate - t : null;
  const cap = prod.lane?.oiCap[symbol] ?? null;
  const oi = prod.lane?.oi[symbol] ?? null;
  const used = oi ? Math.max(oi.long, oi.short) : null;
  const util = cap && used !== null ? Math.min(1, used / cap) : null;
  const age = m.onchainPublishTime !== null && t !== null ? Math.max(0, t - m.onchainPublishTime) : null;

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
        title="Funding accrues continuously at the current rate; the rate is re-set from the global skew by updateFunding (anyone, at most once per interval). Positions settle funding when touched."
      >
        <small>Next rate update</small>
        <b className="mono">{next === null ? "-" : next <= 0 ? "due" : fmtDuration(next)}</b>
        <em>{interval !== null ? `at most every ${fmtDuration(interval)}` : "interval unknown"}</em>
      </div>
      <div
        className={styles.mcell}
        title="Open interest of your lane in this market vs its per-side cap: min(market cap, (lane insurance + backstop cash) × multiplier)."
      >
        <small>Lane {lane !== null ? lane + 1 : "-"} OI</small>
        <b className="mono">
          {oi ? `${fmtCompact(oi.long)} L · ${fmtCompact(oi.short)} S` : "-"}
        </b>
        <em>{cap !== null ? `cap ${fmtCompact(cap)}${util !== null ? ` · ${(util * 100).toFixed(0)}% used` : ""}` : "cap unknown"}</em>
      </div>
      <div
        className={styles.mcell}
        title="Age of the Pyth price stored on chain - what the contract's views (health, free collateral) use. Pyth pushes it regularly; fills and withdrawals also push a fresh one."
      >
        <small>{keeperSigned ? "On-chain price (simulated)" : "On-chain Pyth"}</small>
        <b className="mono">{age === null ? "-" : age < 120 ? `${Math.round(age)}s old` : `${fmtDuration(age)} old`}</b>
        <em>
          {prod.params.maxStoredPriceAge !== null
            ? `contract uses ≤ ${fmtDuration(prod.params.maxStoredPriceAge)}`
            : "used by views"}
        </em>
      </div>
    </div>
  );
}
