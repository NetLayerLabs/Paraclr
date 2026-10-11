"use client";

// The in-browser clearing simulation (the original Clearing screen body).
//
// `isolated` (chain live): the run is self-contained - it never shocks the
// global price feed and never touches your positions, because in chain modes
// prices and positions come from the chain and the simulation must not fake
// them. In sim mode (`isolated` false) it behaves exactly as before.

import { useMemo, useState } from "react";
import { getState, liquidatePositions, setPriceShock, useParaclr } from "@/lib/store";
import { LANE_COUNT, MARKETS, type ClearingAccount, type MarketSymbol } from "@/lib/types";
import {
  DEFAULT_INSURANCE_PER_LANE,
  DEFAULT_REFERENCE_PRICES,
  evaluateAccount,
  generateAccounts,
  runClearing,
  userAccount,
  type ClearingRun,
  type MarkPrices,
} from "@/lib/engine";
import { Notice } from "@/components/chain/ChainUi";
import { ThreadVisualizer, type PreState } from "./ThreadVisualizer";
import { ResultCard } from "./ResultCard";
import { fmtCompact, fmtMark } from "./format";
import styles from "./ClearingScreen.module.css";

type Phase = "idle" | "running" | "done";

const CRASH_FACTOR = 0.8;
const INSURANCE_TOTAL = DEFAULT_INSURANCE_PER_LANE * LANE_COUNT;
export const SPEEDS = [
  { value: 8, label: "8× slow-mo" },
  { value: 1, label: "Real time" },
];

/** Pre-shock prices: live ticks with any active shock divided back out. */
function unshockedReference(): MarkPrices {
  const { prices, priceShock } = getState();
  const f = priceShock > 0 ? priceShock : 1;
  const out = { ...DEFAULT_REFERENCE_PRICES };
  for (const m of MARKETS) {
    const tick = prices[m];
    if (tick) out[m] = tick.price / f;
  }
  return out;
}

function scale(p: MarkPrices, f: number): MarkPrices {
  const out = { ...p };
  for (const m of MARKETS) out[m] = p[m] * f;
  return out;
}

function shardOrder(accounts: ClearingAccount[]): string[][] {
  const lanes: string[][] = Array.from({ length: LANE_COUNT }, () => []);
  for (const a of accounts) lanes[a.thread].push(a.id);
  return lanes;
}

export function SimulatedClearing({ isolated }: { isolated: boolean }) {
  const hasPrices = useParaclr((s) => MARKETS.every((m) => s.prices[m] !== null));
  const prices = useParaclr((s) => s.prices);
  const feedShock = useParaclr((s) => s.priceShock);
  const positions = useParaclr((s) => s.positions);
  const owner = useParaclr((s) => s.session?.address ?? "demo");

  const [localShock, setLocalShock] = useState(1);
  const shock = isolated ? localShock : feedShock;

  const [run, setRun] = useState<ClearingRun | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [playId, setPlayId] = useState(0);
  const [slowmo, setSlowmo] = useState(SPEEDS[0].value);
  // The user's account as it was when the crash hit; their live positions may be
  // seized by the run, so the visualizer and result card read from this snapshot.
  const [runUser, setRunUser] = useState<{ id: string; positionIds: string[] } | null>(null);

  // The synthetic book is generated once real prices exist (deterministic seed).
  const book = useMemo(
    () => generateAccounts(hasPrices ? unshockedReference() : DEFAULT_REFERENCE_PRICES),
    [hasPrices],
  );
  const mine = useMemo(() => userAccount(owner, positions), [owner, positions]);
  const accounts = useMemo(() => (mine ? [...book, mine] : book), [book, mine]);
  const laneOrder = useMemo(() => shardOrder(accounts), [accounts]);

  const marks = useMemo(() => {
    const out = scale(DEFAULT_REFERENCE_PRICES, shock);
    for (const m of MARKETS) {
      const tick = prices[m];
      // Sim mode: the feed already applies the shock. Isolated: apply it here.
      if (tick) out[m] = isolated ? tick.price * shock : tick.price;
    }
    return out;
  }, [prices, shock, isolated]);

  const { preState, tvl, atRisk } = useMemo(() => {
    const pre: PreState = {};
    let tvlSum = 0;
    let risk = 0;
    for (const a of accounts) {
      tvlSum += a.collateral;
      const h = evaluateAccount(a, marks).health;
      if (h === "warning") pre[a.id] = "warn";
      if (h === "liquidatable") pre[a.id] = "risk";
      if (h !== "healthy") risk++;
    }
    return { preState: pre, tvl: tvlSum, atRisk: risk };
  }, [accounts, marks]);

  // After a run, "at risk" = survivors still near maintenance.
  const atRiskShown = useMemo(
    () =>
      run && phase === "done"
        ? Object.values(run.results).filter((r) => r.outcome === "warning").length
        : atRisk,
    [run, phase, atRisk],
  );

  const crashed = shock !== 1;
  const running = phase === "running";
  const insuranceNow = run
    ? phase === "done"
      ? run.lanes.reduce((s, l) => s + l.insuranceEnd, 0)
      : null
    : INSURANCE_TOTAL;

  function flashCrash() {
    const crashMarks = scale(unshockedReference(), CRASH_FACTOR);
    if (isolated) setLocalShock(CRASH_FACTOR);
    else setPriceShock(CRASH_FACTOR);
    setRunUser(mine ? { id: mine.id, positionIds: mine.positions.map((p) => p.id) } : null);
    setRun(runClearing(accounts, crashMarks));
    setPhase("running");
    setPlayId((n) => n + 1);
  }

  function onRunDone() {
    setPhase("done");
    if (isolated) return; // never fake-liquidate real on-chain positions
    // A liquidated cross-margin account loses all of its positions.
    const outcome = runUser && run?.results[runUser.id]?.outcome;
    if (runUser && (outcome === "liquidated" || outcome === "settled")) {
      liquidatePositions(runUser.positionIds);
    }
  }

  function recover() {
    if (isolated) setLocalShock(1);
    else setPriceShock(1);
    setRun(null);
    setRunUser(null);
    setPhase("idle");
  }

  function replay() {
    setPhase("running");
    setPlayId((n) => n + 1);
  }

  return (
    <div className={styles.body} data-phase={phase} data-crashed={crashed ? "" : undefined}>
      <Notice tone="warn">
        <b>Simulated, instant-liquidation model.</b> This in-browser engine closes underwater accounts at the mark in
        one step to show the lane-sharded clearing workload. It does not simulate the per-block auctions, backstop
        pools or solvency proof; those run on chain
        {isolated ? " (see Live)" : "; run the app against a chain (anvil or Monad testnet) to see them"}.
      </Notice>
      <div className={styles.stats}>
        <div className={styles.stat}>
          <small>Accounts</small>
          <b className="mono">{accounts.length}</b>
        </div>
        <div className={styles.stat}>
          <small>TVL · AUSD</small>
          <b className="mono">{fmtCompact(tvl)}</b>
        </div>
        <div className={styles.stat}>
          <small>At risk</small>
          <b className="mono" style={{ color: atRiskShown > 50 ? "var(--short-text)" : "var(--warn-text)" }}>
            {atRiskShown}
          </b>
        </div>
        <div className={styles.stat}>
          <small>Insurance</small>
          <b className="mono">{insuranceNow === null ? "…" : fmtCompact(insuranceNow)}</b>
        </div>
      </div>

      <div className={styles.marks}>
        {MARKETS.map((m: MarketSymbol) => (
          <span key={m} className="mono" data-down={crashed ? "" : undefined}>
            {m.split("/")[0]} {fmtMark(marks[m])}
          </span>
        ))}
        {crashed && <span className={styles.marksShock}>−{Math.round((1 - shock) * 100)}%</span>}
      </div>

      <div className={styles.controls}>
        {!crashed ? (
          <button className={styles.crashBtn} onClick={flashCrash} disabled={running}>
            <span>Simulate −20% Flash Crash</span>
            <small>
              Shock all marks · clear {accounts.length} simulated accounts across {LANE_COUNT} lanes
            </small>
          </button>
        ) : (
          <div className={styles.controlRow}>
            <button className={styles.recoverBtn} onClick={recover} disabled={running}>
              {running ? "Clearing…" : "Recover market"}
            </button>
            {run && (
              <button className={styles.ghostBtn} onClick={replay} disabled={running}>
                Replay
              </button>
            )}
          </div>
        )}
        <div className={styles.speeds} role="group" aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <button
              key={s.value}
              className={s.value === slowmo ? styles.speedOn : styles.speed}
              onClick={() => setSlowmo(s.value)}
              disabled={running}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <ThreadVisualizer
        laneOrder={run?.laneOrder ?? laneOrder}
        preState={preState}
        run={run}
        playId={playId}
        slowmo={slowmo}
        userId={run ? (runUser?.id ?? null) : (mine?.id ?? null)}
        insuranceStart={INSURANCE_TOTAL}
        onDone={onRunDone}
      />

      {run && phase === "done" && (
        <ResultCard run={run} user={runUser ? (run.results[runUser.id] ?? null) : null} />
      )}

      {!run && (
        <p className={styles.note}>
          {accounts.length} cross-margin accounts ({mine ? "incl. your positions, " : ""}2–20× leverage, AUSD
          collateral) sharded across {LANE_COUNT} conflict-free lanes by{" "}
          <span className="mono">hash(id) % 8</span>. Each lane owns its storage and insurance fund, so lane
          batches never write the same slots. Timings are a simulation, not a measurement
          {isolated ? "; this run doesn't touch your on-chain positions or prices" : ""}.
        </p>
      )}
    </div>
  );
}
