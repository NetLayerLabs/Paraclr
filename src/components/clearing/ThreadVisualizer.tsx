"use client";

// Lane visualizer (simulation): replays a ClearingRun's event timeline with
// requestAnimationFrame. React renders the ~500 cells once; each frame only
// flips `data-s` attributes and text/transform on a handful of nodes, so it
// stays at 60fps on a phone.

import { useEffect, useEffectEvent, useRef, type CSSProperties } from "react";
import { THREAD_COUNT } from "@/lib/types";
import { sequentialProgress, type ClearingRun } from "@/lib/engine";
import { fmtCompact, laneColumns } from "./format";
import styles from "./ClearingScreen.module.css";

export type PreState = Record<string, "warn" | "risk">;

interface Props {
  laneOrder: string[][];
  preState: PreState;
  run: ClearingRun | null;
  playId: number;
  /** Wall-clock ms per simulated ms (1 = real time). */
  slowmo: number;
  userId: string | null;
  insuranceStart: number;
  onDone: () => void;
}

const LANES = Array.from({ length: THREAD_COUNT }, (_, i) => i);

function q<T extends HTMLElement>(root: HTMLElement, sel: string): T | null {
  return root.querySelector<T>(sel);
}

export function ThreadVisualizer({
  laneOrder,
  preState,
  run,
  playId,
  slowmo,
  userId,
  insuranceStart,
  onDone,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const finish = useEffectEvent(onDone);
  // Read at replay start so toggling speed never restarts a finished run.
  const readSlowmo = useEffectEvent(() => slowmo);

  // Idle: paint live risk (amber = near maintenance, red = liquidatable now).
  useEffect(() => {
    const root = rootRef.current;
    if (!root || run) return;
    root.querySelectorAll<HTMLElement>("[data-id]").forEach((el) => {
      const s = preState[el.dataset.id ?? ""];
      if (s) el.dataset.s = s;
      else delete el.dataset.s;
    });
  }, [preState, run]);

  // Replay the timeline.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const clock = q(root, "[data-clock]");
    const liqEl = q(root, "[data-liq]");
    const debtEl = q(root, "[data-debt]");
    const fundEl = q(root, "[data-fund]");
    const parBar = q(root, "[data-race-bar='par']");
    const seqBar = q(root, "[data-race-bar='seq']");
    const parCount = q(root, "[data-race-count='par']");
    const seqCount = q(root, "[data-race-count='seq']");
    const laneBars = LANES.map((l) => q(root, `[data-lane-bar='${l}']`));
    const laneMs = LANES.map((l) => q(root, `[data-lane-ms='${l}']`));
    const laneRows = LANES.map((l) => q(root, `[data-lane='${l}']`));

    const setBar = (el: HTMLElement | null, f: number) => {
      if (el) el.style.transform = `scaleX(${Math.min(1, Math.max(0, f))})`;
    };
    const setText = (el: HTMLElement | null, s: string) => {
      if (el && el.textContent !== s) el.textContent = s;
    };

    const resetChrome = () => {
      setText(clock, "000.0");
      setText(liqEl, "0");
      setText(debtEl, "0");
      setText(fundEl, fmtCompact(insuranceStart));
      setBar(parBar, 0);
      setBar(seqBar, 0);
      setText(parCount, "0");
      setText(seqCount, "0");
      LANES.forEach((l) => {
        setBar(laneBars[l], 0);
        setText(laneMs[l], "—");
        laneRows[l]?.removeAttribute("data-done");
      });
    };

    resetChrome();
    if (!run) return;

    const cells = new Map<string, HTMLElement>();
    root.querySelectorAll<HTMLElement>("[data-id]").forEach((el) => {
      delete el.dataset.s;
      cells.set(el.dataset.id ?? "", el);
    });

    const { events, lanes, summary } = run;
    const total = summary.accounts;
    const end = summary.elapsedMs;
    const laneChecked = new Array<number>(THREAD_COUNT).fill(0);
    const laneFinished = new Array<boolean>(THREAD_COUNT).fill(false);
    let checked = 0;
    let liquidated = 0;
    let debt = 0;
    let fund = lanes.reduce((s, l) => s + l.insuranceStart, 0);
    let i = 0;
    let raf = 0;
    const speed = readSlowmo();
    const start = performance.now();

    const frame = (now: number) => {
      const t = Math.min((now - start) / speed, end);

      while (i < events.length && events[i].at <= t) {
        const ev = events[i++];
        const el = cells.get(ev.accountId);
        if (ev.kind === "checked") {
          checked++;
          laneChecked[ev.thread]++;
          if (el) el.dataset.s = "checked";
        } else if (ev.kind === "liquidated") {
          liquidated++;
          if (el) el.dataset.s = "liquidated";
        } else {
          debt += ev.debt;
          fund -= ev.debt;
          if (el) el.dataset.s = "settled";
        }
      }

      for (const l of LANES) {
        setBar(laneBars[l], laneChecked[l] / Math.max(1, lanes[l].accounts));
        if (!laneFinished[l] && t >= lanes[l].finishedAt) {
          laneFinished[l] = true;
          setText(laneMs[l], `${lanes[l].finishedAt.toFixed(0)}ms`);
          laneRows[l]?.setAttribute("data-done", "");
        }
      }

      const seqDone = sequentialProgress(run, t);
      setText(clock, t.toFixed(1).padStart(5, "0"));
      setText(liqEl, String(liquidated));
      setText(debtEl, fmtCompact(debt));
      setText(fundEl, fmtCompact(t >= end ? lanes.reduce((s, l) => s + l.insuranceEnd, 0) : fund));
      setBar(parBar, checked / total);
      setBar(seqBar, seqDone / total);
      setText(parCount, String(checked));
      setText(seqCount, String(seqDone));

      if (t >= end) {
        finish();
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [run, playId, insuranceStart]);

  return (
    <section className={styles.viz} ref={rootRef}>
      <header className={styles.vizHead}>
        <div>
          <div className={styles.vizTitle}>Parallel Lane Visualizer</div>
          <div className={styles.vizSub}>{THREAD_COUNT} conflict-free lanes · simulated timings</div>
        </div>
        <div className={styles.clock}>
          <span className="mono" data-clock>
            000.0
          </span>
          <small>ms</small>
        </div>
      </header>

      <div className={styles.liveStats}>
        <span>
          Liquidated{" "}
          <b className="mono" data-liq style={{ color: "var(--short)" }}>
            0
          </b>
        </span>
        <span>
          Bad debt settled{" "}
          <b className="mono" data-debt style={{ color: "var(--long)" }}>
            0
          </b>
        </span>
        <span>
          Insurance{" "}
          <b className="mono" data-fund>
            —
          </b>
        </span>
      </div>

      <div className={styles.lanes} style={{ "--cols": laneColumns(laneOrder.map((ids) => ids.length)) } as CSSProperties}>
        {LANES.map((l) => (
          <div key={l} className={styles.lane} data-lane={l}>
            <div className={styles.laneLabel}>
              <span>Lane {l + 1}</span>
              <small className="mono" data-lane-ms={l}>
                —
              </small>
            </div>
            <div className={styles.laneBody}>
              <div className={styles.cells}>
                {laneOrder[l].map((id) => (
                  <span
                    key={id}
                    className={styles.cell}
                    data-id={id}
                    data-you={id === userId ? "" : undefined}
                  />
                ))}
              </div>
              <div className={styles.laneTrack}>
                <i className={styles.laneFill} data-lane-bar={l} />
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className={styles.race}>
        <div className={styles.raceRow}>
          <span className={styles.raceLabel}>Parallel · 8 lanes</span>
          <div className={styles.raceTrack}>
            <i className={styles.raceFillPar} data-race-bar="par" />
          </div>
          <span className={`${styles.raceCount} mono`} data-race-count="par">
            0
          </span>
        </div>
        <div className={styles.raceRow}>
          <span className={styles.raceLabel}>Sequential baseline</span>
          <div className={styles.raceTrack}>
            <i className={styles.raceFillSeq} data-race-bar="seq" />
          </div>
          <span className={`${styles.raceCount} mono`} data-race-count="seq">
            0
          </span>
        </div>
      </div>

      <div className={styles.legend}>
        <span>
          <i data-k="checked" /> checked
        </span>
        <span>
          <i data-k="warn" /> at risk
        </span>
        <span>
          <i data-k="liquidated" /> liquidated
        </span>
        <span>
          <i data-k="settled" /> bad debt settled
        </span>
        {userId && (
          <span>
            <i data-k="you" /> you
          </span>
        )}
      </div>
    </section>
  );
}
