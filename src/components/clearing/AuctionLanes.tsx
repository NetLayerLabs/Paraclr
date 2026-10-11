"use client";

// Auction lifecycle per lane, painted at one block: either the latest block
// (live, from the clearinghouse's auction events) or a replay cursor.
//
// The Arena's lane board (components/arena/Lanes.tsx) fed by the app's data: each lane is a running
// track whose x axis is its discount clock (0 → MAX), with the backstop pool's minimum and the fixed
// 1% liquidation as dashed guides. One dot per registered account (getLaneAccounts):
//   in the book   healthy, or cured and handed back (left of the start line)
//   underwater    liquidatable but not in an auction yet (on the start line)
//   auction       in a per-block Dutch auction - moves right as the discount
//                 ticks up, min(MAX, STEP × (block − start))
//   backstop      taken by the lane's backstop pool, at its discount
//   external      taken by an external same-lane taker, at its discount
//   expired       reached MAX with no taker: closed at mark against the lane
// The tallies above the board double as its colour key.
//
// React renders the dots once; a block only moves them (data-attributes and CSS variables).

import { useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import { FIXED_PENALTY_BPS } from "@/lib/kept";
import { LANE_COUNT } from "@/lib/types";
import { NETWORK } from "@/lib/chain/config";
import type { AuctionRecord } from "@/lib/chain/auctionFeed";
import { discountBpsAt, type ChainAuctionParams } from "@/lib/chain/fair";
import { fmtCompact } from "./format";
import styles from "./ClearingScreen.module.css";
import { fmtBps, fmtBpsParam } from "@/lib/format";

const LANES = Array.from({ length: LANE_COUNT }, (_, i) => i);
/** Dots rendered per lane; the rest are summarized as "+N". */
const MAX_CELLS = 240;
/** Book (left of the start line) columns per lane; accounts past columns × rows are counted, not drawn. */
const BOOK_COLS = 4;

type Vars = CSSProperties & Record<`--${string}`, string | number>;

/** Board state names (the Arena's), used for data-s and the tallies. */
type Dot = "healthy" | "underwater" | "auction" | "backstop" | "external" | "cured" | "expired";
const DOT_OF: Record<CellState, Dot> = {
  risk: "underwater",
  auction: "auction",
  backstop: "backstop",
  external: "external",
  cured: "cured",
  expired: "expired",
};
const TALLY: { k: Dot; label: string }[] = [
  { k: "healthy", label: "in the book" },
  { k: "underwater", label: "underwater" },
  { k: "auction", label: "in auction" },
  { k: "backstop", label: "taken by pool" },
  { k: "external", label: "taken externally" },
  { k: "cured", label: "cured" },
  { k: "expired", label: "expired" },
];

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
  const showRisk = phase === "idle" && !replaying;

  // Per-lane and total counts at this block (drives the text; dots are placed below).
  const view = useMemo(() => {
    const lanes = LANES.map(() => ({ auction: 0, maxD: 0, taken: 0, sumTakeD: 0, resolved: 0, risk: 0 }));
    const totals = { auction: 0, backstop: 0, external: 0, cured: 0, expired: 0, debt: 0, residual: 0, risk: 0 };
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
        } else if (s === "risk") {
          lane.risk++;
          totals.risk++;
        } else {
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
    // Idle: accounts below maintenance that have no auction record yet are underwater too.
    if (showRisk) {
      laneAccounts.forEach((accts, l) => {
        for (const id of accts) {
          if (risk.has(id) && !cell.has(id)) {
            totals.risk++;
            if (lanes[l]) lanes[l].risk++;
          }
        }
      });
    }
    return { lanes, totals, cell };
  }, [records, block, shockBlock, params, laneAccounts, risk, showRisk]);

  const maxBps = Math.max(1, params.maxDiscountBps);
  const rows = Math.min(3, Math.max(1, ...laneAccounts.map((a) => Math.min(a.length, MAX_CELLS))));

  // Place dots: in the book (slot, row) or on the discount scale (x, row).
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.querySelectorAll<HTMLElement>("[data-lane-row]").forEach((laneEl) => {
      let book = 0;
      let i = 0;
      laneEl.querySelectorAll<HTMLElement>("[data-id]").forEach((el) => {
        const id = el.dataset.id ?? "";
        const c = view.cell.get(id);
        const s: CellState | undefined = c?.s ?? (risk.has(id) && showRisk ? "risk" : undefined);
        const dot: Dot = s ? DOT_OF[s] : "healthy";
        el.dataset.s = dot;
        if (c?.debt) el.dataset.debt = "";
        else delete el.dataset.debt;
        const x =
          dot === "healthy" || dot === "cured"
            ? null
            : dot === "underwater"
              ? 0
              : dot === "expired"
                ? 1
                : Math.min(1, Math.max(0, (c?.d ?? 0) / maxBps));
        let row: number;
        if (x === null) {
          const n = book++;
          const slot = Math.floor(n / rows);
          row = n % rows;
          el.dataset.in = "book";
          el.style.setProperty("--slot", String(slot));
          if (slot >= BOOK_COLS) el.dataset.over = "";
          else delete el.dataset.over;
        } else {
          row = i % rows;
          el.dataset.in = "scale";
          el.style.setProperty("--x", String(x));
          delete el.dataset.over;
        }
        i++;
        el.style.setProperty("--dy", String(rows > 1 ? (row - (rows - 1) / 2) / rows : 0));
        const parts = [id, dot === "healthy" ? "in the book" : TALLY.find((t) => t.k === dot)?.label ?? dot];
        if (s && s !== "risk" && s !== "cured" && c) parts.push(`${s === "auction" ? "discount" : "at"} ${fmtBps(c.d)}`);
        if (c?.debt) parts.push("lane-funded shortfall");
        if (id === me) parts.push("you");
        el.title = parts.join(" · ");
      });
      // Book overflow: "+N" next to the drawn book slots.
      const more = laneEl.querySelector<HTMLElement>("[data-book-more]");
      const over = Math.max(0, book - BOOK_COLS * rows) + Number(laneEl.dataset.extra ?? 0);
      if (more) {
        more.textContent = over > 0 ? `+${over}` : "";
        more.hidden = over === 0;
      }
    });
  }, [view, risk, showRisk, maxBps, rows, me]);

  const mins = params.minDiscountBps;
  const uniformMin = mins.every((m) => m === mins[0]) ? mins[0] : null;
  const poolMin = uniformMin ?? Math.min(...mins);
  const sinceShock = block !== null && shockBlock !== null && phase !== "idle" ? block - shockBlock : null;
  const t = view.totals;
  const total = laneCounts.reduce((a, b) => a + b, 0);
  const counts: Record<Dot, number> = {
    healthy: Math.max(0, total - t.risk - t.auction - t.backstop - t.external - t.cured - t.expired),
    underwater: t.risk,
    auction: t.auction,
    backstop: t.backstop,
    external: t.external,
    cured: t.cured,
    expired: t.expired,
  };
  const ticks = Array.from({ length: Math.floor(maxBps / 100) + 1 }, (_, i) => i);
  const describe = `${LANE_COUNT} lanes, ${total} accounts: ${TALLY.filter((k) => counts[k.k] > 0)
    .map((k) => `${counts[k.k]} ${k.label}`)
    .join(", ")}.`;

  return (
    <section className={styles.viz} ref={rootRef}>
      <header className={styles.vizHead}>
        <div>
          <h2 className={styles.vizTitle}>{replaying ? "Auction replay" : "Auction lanes"}</h2>
          <p className={styles.vizSub}>
            Per-block Dutch auctions · discount +{fmtBpsParam(params.stepBps)}/block, max {fmtBpsParam(params.maxDiscountBps)} ·{" "}
            {replaying ? "replayed from on-chain events" : "live from on-chain events"} · {NETWORK?.shortLabel ?? "chain"}
          </p>
        </div>
        <div
          className={styles.clock}
          data-k={sinceShock !== null ? "run" : "latest"}
          title={sinceShock !== null ? `Blocks since the oracle shock (block #${shockBlock})` : "Latest block"}
        >
          <small>
            <i aria-hidden="true" />
            {sinceShock !== null ? "blocks since the shock" : "latest block"}
          </small>
          {sinceShock !== null ? (
            <span className="mono">+{sinceShock}</span>
          ) : (
            <span className="mono" data-small="">
              {block !== null ? `#${block.toLocaleString("en-US")}` : "…"}
            </span>
          )}
        </div>
      </header>

      {/* Counts per state, doubling as the colour key. */}
      <dl className={styles.tally} aria-label="Accounts by state">
        {TALLY.map(({ k, label }) => (
          <div key={k} data-zero={counts[k] === 0 ? "" : undefined}>
            <dt>
              <i className={styles.key} data-s={k} aria-hidden="true" />
              {label}
              {k === "external" && demoTakers ? " (demo bots)" : ""}
            </dt>
            <dd className="mono">{counts[k]}</dd>
          </div>
        ))}
        <div
          data-zero={t.debt > 0 ? undefined : ""}
          title="What the lanes paid when a trader's equity didn't cover the discount, or was negative (insurance first, then lane bad debt)"
        >
          <dt>
            <i className={styles.key} data-s="debt" aria-hidden="true" />
            lane-funded shortfall
          </dt>
          <dd className="mono">{fmtCompact(t.debt)}</dd>
        </div>
        {me && laneAccounts.some((a) => a.includes(me)) && (
          <div>
            <dt>
              <i className={styles.key} data-s="you" aria-hidden="true" />
              you
            </dt>
          </div>
        )}
      </dl>

      <div className={styles.board}>
        <div className={styles.rulerRow} aria-hidden="true">
          <span className={styles.rulerLabel}>lane</span>
          <div className={styles.ruler}>
            <span className={styles.paddockLabel}>book</span>
            {ticks.map((i) => (
              <span key={i} className={styles.tick} style={{ "--x": (i * 100) / maxBps } as Vars}>
                {i === 0 ? "0" : `${i}%`}
              </span>
            ))}
          </div>
          <span className={styles.rulerOut}>lane clock</span>
        </div>

        <div className={styles.boardLanes} role="img" aria-label={describe}>
          {LANES.map((l) => {
            const accts = laneAccounts[l] ?? [];
            const extra = Math.max(0, accts.length - MAX_CELLS);
            const lv = view.lanes[l];
            const laneMin = mins[l] ?? mins[0];
            const clockBps = lv.auction > 0 ? lv.maxD : lv.taken > 0 ? lv.sumTakeD / lv.taken : 0;
            const clockState = lv.auction > 0 ? "tick" : lv.taken > 0 ? "taken" : "idle";
            const out =
              lv.auction > 0
                ? { main: fmtBps(lv.maxD), sub: `${lv.auction} in auction`, tone: "warn" }
                : lv.risk > 0
                  ? { main: "underwater", sub: `${lv.risk} waiting to start`, tone: "neg" }
                  : lv.taken > 0
                    ? { main: fmtBps(clockBps), sub: `${lv.resolved} resolved`, tone: undefined }
                    : lv.resolved > 0
                      ? { main: `${lv.resolved} resolved`, sub: "", tone: undefined }
                      : { main: (laneCounts[l] ?? 0) > 0 ? `${laneCounts[l]} in book` : "empty", sub: "", tone: "dim" };
            return (
              <div
                key={l}
                className={styles.laneRow}
                data-lane={l}
                data-lane-row=""
                data-extra={extra || undefined}
                data-clock={clockState}
                style={{ "--rows": rows } as Vars}
              >
                <span className={`${styles.boardLaneLabel} mono`}>L{l}</span>
                <div className={styles.track}>
                  <i className={styles.guideStart} aria-hidden="true" />
                  <i
                    className={styles.guidePool}
                    style={{ "--x": Math.min(1, laneMin / maxBps) } as Vars}
                    aria-hidden="true"
                  />
                  <i
                    className={styles.guideFee}
                    style={{ "--x": Math.min(1, FIXED_PENALTY_BPS / maxBps) } as Vars}
                    aria-hidden="true"
                  />
                  <i className={styles.trackFill} style={{ "--x": Math.min(1, clockBps / maxBps) } as Vars} aria-hidden="true" />
                  {accts.slice(0, MAX_CELLS).map((id) => (
                    <span key={id} className={styles.marker} data-id={id} data-you={id === me ? "" : undefined} />
                  ))}
                  <span className={`${styles.bookMore} mono`} data-book-more="" hidden />
                </div>
                <span className={styles.laneOut} data-tone={out.tone}>
                  <b className="mono">{out.main}</b>
                  {out.sub ? <small className="mono">{out.sub}</small> : null}
                </span>
              </div>
            );
          })}
        </div>

        <div className={styles.rulerRow} data-edge="bottom" aria-hidden="true">
          <span className={styles.rulerLabel} />
          <div className={styles.ruler}>
            <span className={styles.rulerMark} data-k="pool" style={{ "--x": Math.min(1, poolMin / maxBps) } as Vars}>
              pool takes {uniformMin !== null ? fmtBpsParam(uniformMin) : `≥ ${fmtBpsParam(poolMin)}`}
            </span>
            <span
              className={styles.rulerMark}
              data-k="fee"
              style={{ "--x": Math.min(1, FIXED_PENALTY_BPS / maxBps) } as Vars}
            >
              fixed {fmtBpsParam(FIXED_PENALTY_BPS)} liquidation
            </span>
          </div>
          <span className={styles.rulerOut} />
        </div>
      </div>
    </section>
  );
}
