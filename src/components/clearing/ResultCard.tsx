"use client";

import type { AccountResult, ClearingRun } from "@/lib/engine";
import { fmtCompact, fmtMs } from "./format";
import styles from "./ClearingScreen.module.css";

interface Props {
  run: ClearingRun;
  user: AccountResult | null;
}

const USER_COPY: Record<AccountResult["outcome"], { label: string; tone: string }> = {
  healthy: { label: "Survived — healthy", tone: "var(--long)" },
  warning: { label: "Survived — near maintenance", tone: "var(--warn)" },
  liquidated: { label: "Liquidated", tone: "var(--short)" },
  settled: { label: "Liquidated — bad debt covered by insurance", tone: "var(--short)" },
};

export function ResultCard({ run, user }: Props) {
  const { summary, sequentialMs, lanes } = run;
  const par = summary.elapsedMs;
  const speedup = sequentialMs / par;
  const slowest = lanes.reduce((a, b) => (b.finishedAt > a.finishedAt ? b : a));
  const insuranceEnd = lanes.reduce((s, l) => s + l.insuranceEnd, 0);

  return (
    <section className={`${styles.result} ${styles.resultSim}`}>
      <div className={styles.resultKicker}>Clearing complete · simulated · instant-liquidation model</div>
      <h2 className={styles.resultHead}>
        <span className="mono">{summary.accounts}</span> simulated accounts cleared in{" "}
        <span className={`${styles.resultMs} mono`}>{par.toFixed(0)} ms</span> of modeled time
      </h2>

      <div className={styles.cmp}>
        <div className={styles.cmpRow}>
          <span>Parallel</span>
          <div className={styles.cmpTrack}>
            <i
              className={styles.cmpPar}
              style={{ width: `${Math.max(2, (par / sequentialMs) * 100)}%` }}
            />
          </div>
          <b className="mono">{fmtMs(par)}</b>
        </div>
        <div className={styles.cmpRow}>
          <span>Sequential</span>
          <div className={styles.cmpTrack}>
            <i className={styles.cmpSeq} style={{ width: "100%" }} />
          </div>
          <b className="mono">~{fmtMs(sequentialMs)}</b>
        </div>
        <div className={styles.speedup}>
          <b className="mono">{speedup.toFixed(1)}×</b> faster · bounded by the slowest lane (Lane{" "}
          {slowest.thread + 1}, {slowest.accounts} accounts)
        </div>
      </div>

      <div className={styles.resultGrid}>
        <div>
          <small>Liquidated</small>
          <b className="mono" style={{ color: "var(--short)" }}>
            {summary.liquidated}
          </b>
        </div>
        <div>
          <small>Bad debt settled</small>
          <b className="mono" style={{ color: "var(--long)" }}>
            {fmtCompact(summary.totalDebtSettled)}
          </b>
        </div>
        <div>
          <small>Insurance left</small>
          <b className="mono">{fmtCompact(insuranceEnd)}</b>
        </div>
      </div>
      {run.uncoveredDebt > 0 && (
        <p className={styles.note} style={{ color: "var(--warn)" }}>
          {fmtCompact(run.uncoveredDebt)} AUSD exceeded lane insurance and would be socialised.
        </p>
      )}

      {user && (
        <div className={styles.userResult} style={{ borderColor: USER_COPY[user.outcome].tone }}>
          <small>Your account · Lane {user.thread + 1}</small>
          <b style={{ color: USER_COPY[user.outcome].tone }}>{USER_COPY[user.outcome].label}</b>
          <span className="mono">
            equity at crash mark {user.equity >= 0 ? "" : "−"}
            {fmtCompact(Math.abs(user.equity))} AUSD · checked at {user.checkedAt.toFixed(0)} ms
          </span>
        </div>
      )}

      <p className={styles.note}>
        Simulation, not an on-chain measurement: modeled per-op costs (health check, liquidation,
        settlement, lane commit) with lanes sharded by <span className="mono">hash(id) % 8</span> and
        assumed to run concurrently. Each lane owns disjoint storage, so lane batches never conflict;
        which execution threads Monad uses is up to its executor. Sequential = the identical ops run
        one after another.
      </p>
    </section>
  );
}
