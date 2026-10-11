"use client";

// Metrics strip of a crash run v2. Every number is the keeper's RunReport
// (`auctions`, `underwater`): its receipts, its clock. Nothing is modeled.
// The one derived figure is the plan's own definition:
//   trader loss to the auctions = traderEquityAtStart − traderResidualReturned,
// shown next to the keeper's legacy counterfactual even when it is larger.

import type { RunReport } from "@/lib/chain/keeper";
import { fmtBps } from "@/lib/chain/fair";
import { parseAusdString } from "@/lib/chain/units";
import { fmtCompact as fmtAusdCompact } from "@/components/trade/format";
import { fmtMs } from "./format";
import styles from "./ClearingScreen.module.css";

/** Tight AUSD for side-by-side figures: no cents from 1,000 up. */
function fmtPair(n: number): string {
  return Math.abs(n) >= 1_000 ? fmtAusdCompact(Math.round(n)).replace(/\.00$/, "") : fmtAusdCompact(n);
}

export function AuctionMetrics({ report, laneBadDebt }: { report: RunReport; laneBadDebt: number | null }) {
  const a = report.auctions;
  const u = report.underwater;
  const where = report.network === "monad-testnet" ? "Monad testnet" : "local anvil, not Monad";
  if (!a && !u) {
    return (
      <p className={styles.note}>
        This keeper&apos;s report has no auction metrics (it predates crash runs v2), so time underwater and equity
        returned can&apos;t be shown.
      </p>
    );
  }

  const returned = a ? parseAusdString(a.traderResidualReturned) : 0;
  const legacy = a ? parseAusdString(a.legacyCounterfactual.traderLoss) : 0;
  const paid = a ? parseAusdString(a.backstopPaid) : 0;
  const shortfall = a ? parseAusdString(a.badDebt) : 0;
  const equityAtStart = a?.traderEquityAtStart !== undefined ? parseAusdString(a.traderEquityAtStart) : null;
  const auctionLoss = equityAtStart !== null ? Math.max(0, equityAtStart - returned) : null;
  const resolved = a ? a.takenByBackstop + a.takenExternal + a.cured + a.expired : 0;
  const takes = a ? a.takenByBackstop + a.takenExternal : 0;
  const bots = a?.externalTakers?.demo ? a.externalTakers : null;
  const botRange = bots?.reservationBps ? `${fmtBps(bots.reservationBps[0])}–${fmtBps(bots.reservationBps[1])}` : null;

  return (
    <section className={styles.metrics} aria-label="Run metrics" data-net={report.network === "monad-testnet" ? "monad" : "anvil"}>
      <div className={styles.metricsHead}>
        <span className={styles.metricsKicker}>Measured on {where}</span>
        {a && (
          <span className={styles.metricsOutcomes}>
            <b className="mono">{a.started}</b> auctions · <b className="mono">{a.takenByBackstop}</b> backstop ·{" "}
            <b className="mono">{a.takenExternal}</b> external
            {bots && (
              <span className={styles.demoTag} title="External takers in this run are demo bots run by the keeper">
                demo bots
              </span>
            )}{" "}
            · <b className="mono">{a.cured}</b> cured · <b className="mono">{a.expired}</b> expired
            {resolved < a.started && <> · {a.started - resolved} unresolved</>}
          </span>
        )}
      </div>
      {bots && (
        <p className={styles.metricsNote}>
          External takers in this run are demo bots run by the keeper
          {botRange ? `, each taking once the discount reaches its reservation level (${botRange})` : ""} - not
          independent market participants.
        </p>
      )}
      <div className={styles.metricsGrid}>
        {u && (
          <div className={styles.metric}>
            <small>Max time underwater</small>
            <b className="mono">
              {u.maxBlocks} <span>blocks</span>
            </b>
            <span className="mono" title="Keeper clock: first liquidatable block observed → resolution receipt observed">
              {fmtMs(u.maxMs)} keeper-measured
            </span>
          </div>
        )}
        {u && (
          <div className={styles.metric}>
            <small>p95 · p50 underwater</small>
            <b className="mono">
              {u.p95Blocks} · {u.p50Blocks} <span>blocks</span>
            </b>
            <span>{u.perAccount.length} accounts measured</span>
          </div>
        )}
        {a && (
          <div className={styles.metric}>
            <small title="Equity returned to traders">Returned to traders</small>
            <b className="mono" style={{ color: "var(--long-text)" }}>
              {fmtAusdCompact(returned)} <span>AUSD</span>
            </b>
            <span>left as free collateral after the take / expiry</span>
          </div>
        )}
        {a && (
          <div className={styles.metric}>
            <small title="Trader loss to the auctions (equity at auction start − returned) vs what the old fixed 1% penalty path would have taken from the same accounts (keeper-computed)">
              Trader loss · auction vs legacy
            </small>
            {auctionLoss !== null ? (
              <>
                <b className="mono" data-pair="">
                  {fmtPair(auctionLoss)} <span>vs</span> {fmtPair(legacy)}
                </b>
                <span>
                  {auctionLoss > legacy + 0.005
                    ? `auctions took ${fmtAusdCompact(auctionLoss - legacy)} more than the old fixed 1% penalty`
                    : auctionLoss < legacy - 0.005
                      ? `auctions took ${fmtAusdCompact(legacy - auctionLoss)} less than the old fixed 1% penalty`
                      : "same as the old fixed 1% penalty"}
                </span>
              </>
            ) : (
              <>
                <b className="mono">
                  {fmtAusdCompact(legacy)} <span>AUSD</span>
                </b>
                <span>the old fixed 1% penalty would have taken</span>
              </>
            )}
          </div>
        )}
        {a && (
          <div className={styles.metric}>
            <small>Paid to takers</small>
            <b className="mono">
              {fmtAusdCompact(paid)} <span>AUSD</span>
            </b>
            <span>{takes > 0 ? `avg discount ${fmtBps(a.avgDiscountBps)}` : "no takes this run"}</span>
          </div>
        )}
        {a && (
          <div className={styles.metric}>
            <small title="What the lanes paid when a trader's equity didn't cover the discount (or was negative): insurance first, then lane bad debt">
              Lane-funded shortfall
            </small>
            <b className="mono" style={{ color: shortfall > 0 ? "var(--warn-text)" : undefined }}>
              {fmtAusdCompact(shortfall)} <span>AUSD</span>
            </b>
            <span title="Real lane bad debt: Σ lane badDebt read from chain">
              {laneBadDebt === null
                ? "insurance pays first"
                : laneBadDebt > 0
                  ? `lane bad debt now ${fmtAusdCompact(laneBadDebt)}`
                  : "lane bad debt now 0 - insurance covered it"}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
