"use client";

// Auction lifecycle per lane, painted at one block: either the latest block
// (live, from the clearinghouse's auction events) or a replay cursor.
//
// One cell per registered account (getLaneAccounts). A cell is
//   risk      underwater (liquidatable) but not in an auction yet
//   auction   in a per-block Dutch auction - its shade deepens as the
//             discount ticks up, min(MAX, STEP × (block − start))
//   backstop  taken by the lane's backstop pool
//   external  taken by an external same-lane taker
//   cured     auction cancelled: healthy again (top-up / price recovery)
//   expired   reached MAX with no taker: closed at mark against the lane
// The thin track under each lane is that lane's discount clock (0 → MAX) with
// a tick at the backstop pool's minimum discount.
//
// React renders the cells once; a block only flips data-attributes.

import { useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import { LANE_COUNT } from "@/lib/types";
import { NETWORK } from "@/lib/chain/config";
import type { AuctionRecord } from "@/lib/chain/auctionFeed";
import { discountBpsAt, fmtBps, type ChainAuctionParams } from "@/lib/chain/fair";
import { fmtCompact, laneColumns } from "./format";
import styles from "./ClearingScreen.module.css";

const LANES = Array.from({ length: LANE_COUNT }, (_, i) => i);
/** Cells rendered per lane; the rest are summarized as "+N". */
const MAX_CELLS = 240;

export type CellState = "risk" | "auction" | "backstop" | "external" | "cured" | "expired";

interface Props {
  laneAccounts: string[][];
  laneCounts: number[];
  /** Liquidatable at the current marks (idle painting only). */
  risk: Set<string>;
  records: ReadonlyMap<string, AuctionRecord>;
  /** Block to paint (latest, or the replay cursor); null before the first block. */
  block: number | null;
  /** The crash's shock block: "block +N" clock and underwater-before-auction cells. */
  shockBlock: number | null;
  /** Step / max discount and each lane pool's minimum (read from chain). */
  params: ChainAuctionParams;
  me: string | null;
  /** External takers in this run are keeper-run demo bots (RunReport.auctions.externalTakers). */
  demoTakers?: boolean;
  replaying: boolean;
  phase: "idle" | "running" | "done";
}

function stateAt(r: AuctionRecord, b: number, shockBlock: number | null): { s: CellState | null; d: number } {
  if (b < r.startBlock) return { s: shockBlock !== null && b >= shockBlock ? "risk" : null, d: 0 };
  if (r.resolvedBlock === null || b < r.resolvedBlock) return { s: "auction", d: -1 };
  return { s: r.status === "active" ? "auction" : r.status, d: r.discountBps ?? 0 };
}

export function AuctionLanes({
  laneAccounts,
  laneCounts,
  risk,
  records,
  block,
  shockBlock,
  params,
  me,
  demoTakers = false,
  replaying,
  phase,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);

  // Per-lane and total counts at this block (drives the text; cells are painted below).
  const view = useMemo(() => {
    const lanes = LANES.map(() => ({ auction: 0, maxD: 0, taken: 0, sumTakeD: 0, resolved: 0 }));
    const totals = { auction: 0, backstop: 0, external: 0, cured: 0, expired: 0, debt: 0, residual: 0 };
    const cell = new Map<string, { s: CellState; d: number; debt: boolean }>();
    if (block !== null) {
      for (const r of records.values()) {
        const { s, d } = stateAt(r, block, shockBlock);
        if (!s) continue;
        const lane = lanes[r.lane];
        const disc = s === "auction" ? discountBpsAt(r.startBlock, block, params) : d;
        const debt = s !== "auction" && r.badDebt > 0;
        cell.set(r.account, { s, d: disc, debt });
        if (!lane) continue;
        if (s === "auction") {
          lane.auction++;
          lane.maxD = Math.max(lane.maxD, disc);
          totals.auction++;
        } else if (s !== "risk") {
          lane.resolved++;
          totals[s]++;
          if (s === "backstop" || s === "external") {
            lane.taken++;
            lane.sumTakeD += disc;
            totals.residual += r.traderResidual ?? 0;
          }
          totals.debt += r.badDebt;
        }
      }
    }
    return { lanes, totals, cell };
  }, [records, block, shockBlock, params]);

  // Paint cells.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const max = Math.max(1, params.maxDiscountBps);
    root.querySelectorAll<HTMLElement>("[data-id]").forEach((el) => {
      const id = el.dataset.id ?? "";
      const c = view.cell.get(id);
      const s: CellState | undefined = c?.s ?? (risk.has(id) && phase === "idle" && !replaying ? "risk" : undefined);
      if (s) el.dataset.s = s;
      else delete el.dataset.s;
      if (c?.debt) el.dataset.debt = "";
      else delete el.dataset.debt;
      if (s === "auction") {
        // 40% → 100% warn as the discount climbs from 0 to MAX.
        const pct = Math.round(40 + 60 * Math.min(1, (c?.d ?? 0) / max));
        el.style.background = `color-mix(in srgb, var(--warn) ${pct}%, var(--bg-elev-2))`;
        el.title = `${id} · in auction · discount ${fmtBps(c?.d ?? 0)}`;
      } else {
        el.style.removeProperty("background");
        el.title = s ? `${id} · ${s}` : id;
      }
    });
  }, [view, risk, params, phase, replaying]);

  const cols = laneColumns(laneAccounts.map((a) => Math.min(a.length, MAX_CELLS) + (a.length > MAX_CELLS ? 3 : 0)));
  const maxBps = Math.max(1, params.maxDiscountBps);
  const mins = params.minDiscountBps;
  const uniformMin = mins.every((m) => m === mins[0]) ? mins[0] : null;
  const sinceShock = block !== null && shockBlock !== null && phase !== "idle" ? block - shockBlock : null;
  const t = view.totals;

  return (
    <section className={styles.viz} ref={rootRef}>
      <header className={styles.vizHead}>
        <div>
          <div className={styles.vizTitle}>{replaying ? "Auction replay" : "Auction lanes"}</div>
          <div className={styles.vizSub}>
            Per-block Dutch auctions · discount +{fmtBps(params.stepBps)}/block, max {fmtBps(params.maxDiscountBps)} ·{" "}
            {replaying ? "replayed from on-chain events" : "live from on-chain events"} · {NETWORK?.shortLabel ?? "chain"}
          </div>
        </div>
        <div
          className={styles.clock}
          title={sinceShock !== null ? `Blocks since the oracle shock (block #${shockBlock})` : "Latest block"}
        >
          {sinceShock !== null ? (
            <>
              <small>block</small>
              <span className="mono">+{sinceShock}</span>
            </>
          ) : (
            <span className="mono" data-small="">
              {block !== null ? `#${block.toLocaleString("en-US")}` : "…"}
            </span>
          )}
        </div>
      </header>

      <div className={styles.liveStats}>
        <span>
          In auction{" "}
          <b className="mono" style={{ color: t.auction > 0 ? "var(--warn-text)" : undefined }}>
            {t.auction}
          </b>
        </span>
        <span>
          Backstop{" "}
          <b className="mono" style={{ color: t.backstop > 0 ? "var(--accent-text)" : undefined }}>
            {t.backstop}
          </b>
        </span>
        <span>
          External <b className="mono">{t.external}</b>
        </span>
        <span>
          Cured{" "}
          <b className="mono" style={{ color: t.cured > 0 ? "var(--long-text)" : undefined }}>
            {t.cured}
          </b>
        </span>
        <span>
          Expired{" "}
          <b className="mono" style={{ color: t.expired > 0 ? "var(--short-text)" : undefined }}>
            {t.expired}
          </b>
        </span>
        <span title="What the lanes paid when a trader's equity didn't cover the discount, or was negative (insurance first, then lane bad debt)">
          Lane-funded shortfall{" "}
          <b className="mono" style={{ color: t.debt > 0 ? "var(--warn-text)" : undefined }}>
            {fmtCompact(t.debt)}
          </b>
        </span>
      </div>

      <div className={styles.lanes} style={{ "--cols": cols } as CSSProperties}>
        {LANES.map((l) => {
          const accts = laneAccounts[l] ?? [];
          const extra = Math.max(0, accts.length - MAX_CELLS);
          const lv = view.lanes[l];
          const clockBps = lv.auction > 0 ? lv.maxD : lv.taken > 0 ? lv.sumTakeD / lv.taken : 0;
          const laneMin = mins[l] ?? mins[0];
          const clockState = lv.auction > 0 ? (lv.maxD >= laneMin ? "take" : "tick") : lv.taken > 0 ? "taken" : "idle";
          const label =
            lv.auction > 0
              ? `${lv.auction} · ${fmtBps(lv.maxD)}`
              : lv.resolved > 0
                ? `${lv.resolved} resolved`
                : `${laneCounts[l] ?? 0} acc`;
          return (
            <div key={l} className={styles.lane} data-lane={l} data-clock={clockState}>
              <div className={styles.laneLabel}>
                <span>Lane {l + 1}</span>
                <small className="mono">{label}</small>
              </div>
              <div className={styles.laneBody}>
                <div className={styles.cells}>
                  {accts.slice(0, MAX_CELLS).map((id) => (
                    <span key={id} className={styles.cell} data-id={id} data-you={id === me ? "" : undefined} />
                  ))}
                  {extra > 0 && <span className={styles.laneMore}>+{extra}</span>}
                </div>
                <div
                  className={styles.discTrack}
                  title={`Discount clock: 0 → ${fmtBps(params.maxDiscountBps)}; the lane ${l + 1} backstop takes at ≥ ${fmtBps(laneMin)}`}
                >
                  <i className={styles.discFill} style={{ transform: `scaleX(${Math.min(1, clockBps / maxBps)})` }} />
                  <i className={styles.discMin} style={{ left: `${Math.min(1, laneMin / maxBps) * 100}%` }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className={styles.legend}>
        <span>
          <i data-k="risk" /> underwater
        </span>
        <span>
          <i data-k="auction" /> in auction (brighter = higher discount)
        </span>
        <span>
          <i data-k="backstop" /> taken by backstop
        </span>
        <span title={demoTakers ? "External takers in this run are demo bots run by the keeper" : undefined}>
          <i data-k="external" /> taken externally{demoTakers ? " (demo bots run by the keeper)" : ""}
        </span>
        <span>
          <i data-k="cured" /> cured
        </span>
        <span>
          <i data-k="expired" /> expired
        </span>
        <span title="The trader's equity didn't cover the discount (or was negative); the lane paid the shortfall">
          <i data-k="debt" /> lane-funded shortfall
        </span>
        <span>
          <i data-k="min" /> backstop min {uniformMin !== null ? fmtBps(uniformMin) : "(per lane)"}
        </span>
        {me && (
          <span>
            <i data-k="you" /> you
          </span>
        )}
      </div>
    </section>
  );
}
