"use client";

// The lane board: Paraclr's 8 lanes as 8 running-track lanes, then the naive build as ONE lane that
// every account shares. The x axis of every lane is its discount clock (0 → the cap, 5% on the demo
// stack), so an account in auction travels right one step per block until a taker or the lane's
// backstop pool takes it. Left of the start line is the book: accounts that are healthy, or cured
// and handed back. Colours follow the clearing screen's auction states (globals.css tokens).

import type { CSSProperties, ReactNode } from "react";
import { keptVsFixedRaw } from "@/lib/kept";
import type { AccountState, ArenaAccount, ArenaDesign } from "./types";
import { ausd, fmtAusd, fmtSigned, shortAddr } from "./format";
import s from "./Arena.module.css";
import { fmtBps, fmtBpsParam } from "@/lib/format";

type Vars = CSSProperties & Record<`--${string}`, string | number>;

export const STATE_LABEL: Record<AccountState, string> = {
  healthy: "healthy",
  underwater: "underwater",
  auction: "in auction",
  backstop: "taken by pool",
  external: "taken externally",
  cured: "cured",
  expired: "expired",
};

/** Order of the tallies (and of the colour key they double as). */
const TALLY: AccountState[] = ["healthy", "underwater", "auction", "backstop", "external", "cured", "expired"];

const RESOLVED = new Set<AccountState>(["backstop", "external", "cured", "expired"]);

/**
 * What one account kept compared with the fixed-penalty liquidation (src/lib/kept.ts), on the
 * same terms as the keeper's run summary: a take is measured from its residual, a cure costs the
 * trader nothing, an expiry hands the whole equity over. Null while unresolved or unknown.
 */
export function accountKept(a: ArenaAccount, feeBps: number): bigint | null {
  if (!RESOLVED.has(a.state) || a.equity === null || a.notional === null) return null;
  try {
    const equityAtStart = BigInt(a.equity);
    const eq = equityAtStart > BigInt(0) ? equityAtStart : BigInt(0);
    const residual =
      a.state === "cured" ? eq : a.state === "expired" ? BigInt(0) : a.residual !== null ? BigInt(a.residual) : null;
    if (residual === null) return null;
    return keptVsFixedRaw({ notional: BigInt(a.notional), equityAtStart, traderResidual: residual, feeBps })?.kept ?? null;
  } catch {
    return null;
  }
}

/** Σ accountKept over resolved accounts, AUSD. Null when none resolved. */
export function sumKept(accts: ArenaAccount[], feeBps: number): { kept: number; n: number } | null {
  let total = BigInt(0);
  let n = 0;
  for (const a of accts) {
    const k = accountKept(a, feeBps);
    if (k === null) continue;
    total += k;
    n++;
  }
  return n ? { kept: Number(total) / 1e6, n } : null;
}

function markerTitle(a: ArenaAccount, feeBps: number): string {
  const parts = [`${shortAddr(a.account)} · L${a.lane}`, STATE_LABEL[a.state]];
  if (a.state === "auction") parts.push(`discount ${fmtBps(a.discountBps)}`);
  if ((a.state === "backstop" || a.state === "external") && a.discountBps !== null) parts.push(`at ${fmtBps(a.discountBps)}`);
  if (a.startBlock !== null && a.resolvedBlock !== null) parts.push(`${a.resolvedBlock - a.startBlock} blocks in auction`);
  if (a.residual !== null && a.residual !== "0") parts.push(`returned ${fmtAusd(ausd(a.residual))} AUSD`);
  const k = accountKept(a, feeBps);
  if (k !== null) parts.push(`${fmtSigned(Number(k) / 1e6)} AUSD vs a fixed ${fmtBpsParam(feeBps)}`);
  if (a.badDebt !== null && a.badDebt !== "0") parts.push(`shortfall ${fmtAusd(ausd(a.badDebt))} AUSD`);
  if (a.profile === "cure") parts.push("gets a demo top-up mid-auction");
  return parts.join(" · ");
}

/** Where a marker sits: in the book (x < 0 → paddock slot) or on the discount scale (0..1). */
function place(a: ArenaAccount, maxBps: number): number | null {
  switch (a.state) {
    case "healthy":
    case "cured":
      return null;
    case "underwater":
      return 0;
    case "expired":
      return 1;
    default:
      return Math.min(1, Math.max(0, (a.discountBps ?? 0) / Math.max(1, maxBps)));
  }
}

function Marker({ a, maxBps, feeBps, slot, row, rows }: { a: ArenaAccount; maxBps: number; feeBps: number; slot: number; row: number; rows: number }) {
  const x = place(a, maxBps);
  const debt = a.badDebt !== null && a.badDebt !== "0";
  // Vertical position inside the lane: spread `rows` sub-tracks evenly around the centre line.
  const dy = rows > 1 ? (row - (rows - 1) / 2) / rows : 0;
  const style: Vars = x === null ? { "--slot": slot, "--dy": dy } : { "--x": x, "--dy": dy };
  return (
    <span
      className={s.marker}
      data-s={a.state}
      data-in={x === null ? "book" : "scale"}
      data-debt={debt ? "" : undefined}
      style={style}
      title={markerTitle(a, feeBps)}
    />
  );
}

/** Guides drawn inside every lane so they read as continuous verticals down the board. */
function Guides({ minFrac, feeFrac }: { minFrac: number; feeFrac: number }) {
  return (
    <>
      <i className={s.guideStart} aria-hidden="true" />
      <i className={s.guidePool} style={{ "--x": minFrac } as Vars} aria-hidden="true" />
      <i className={s.guideFee} style={{ "--x": feeFrac } as Vars} aria-hidden="true" />
    </>
  );
}

function laneClock(accts: ArenaAccount[]): { bps: number; state: "tick" | "taken" | "idle" } {
  const live = accts.filter((a) => a.state === "auction");
  if (live.length) return { bps: Math.max(...live.map((a) => a.discountBps ?? 0)), state: "tick" };
  const taken = accts.filter((a) => (a.state === "backstop" || a.state === "external") && a.discountBps !== null);
  if (taken.length) return { bps: Math.max(...taken.map((a) => a.discountBps ?? 0)), state: "taken" };
  return { bps: 0, state: "idle" };
}

function laneOutcome(accts: ArenaAccount[], feeBps: number, stepBps: number): { main: string; sub: string; tone?: string } {
  if (accts.length === 0) return { main: "empty", sub: "", tone: "dim" };
  const live = accts.filter((a) => a.state === "auction");
  const under = accts.filter((a) => a.state === "underwater");
  if (live.length) {
    const bps = Math.max(...live.map((a) => a.discountBps ?? 0));
    return { main: fmtBps(bps), sub: `${live.length} in auction`, tone: "warn" };
  }
  if (under.length) return { main: "underwater", sub: `${under.length} waiting to start`, tone: "neg" };
  const resolved = accts.filter((a) => RESOLVED.has(a.state));
  if (resolved.length) {
    const k = sumKept(resolved, feeBps);
    const took = resolved.filter((a) => a.state === "backstop" || a.state === "external");
    const blocks = Math.max(
      0,
      ...resolved.map((a) => (a.startBlock !== null && a.resolvedBlock !== null ? a.resolvedBlock - a.startBlock : 0)),
    );
    const main = took.length
      ? `${fmtBps(Math.max(...took.map((a) => a.discountBps ?? 0)))} · ${blocks} blk`
      : resolved.every((a) => a.state === "cured")
        ? "cured"
        : "expired";
    void stepBps;
    return { main, sub: k ? `${fmtSigned(k.kept)} kept` : "", tone: k && k.kept > 0 ? "pos" : undefined };
  }
  return { main: `${accts.length} healthy`, sub: "", tone: "dim" };
}

export function Tally({ d, caption }: { d: ArenaDesign; caption: string }) {
  return (
    <dl className={s.tally} aria-label={caption}>
      {TALLY.map((k) => (
        <div key={k} data-zero={d.counts[k] === 0 ? "" : undefined}>
          <dt>
            <i className={s.key} data-s={k} aria-hidden="true" />
            {STATE_LABEL[k]}
          </dt>
          <dd className="mono">{d.counts[k]}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The ruler above (numbers) or below (the two thresholds) the lanes. */
function Ruler({ maxBps, minBps, feeBps, edge }: { maxBps: number; minBps: number; feeBps: number; edge: "top" | "bottom" }) {
  const pct = Math.round(maxBps / 100);
  const ticks = Array.from({ length: pct + 1 }, (_, i) => i);
  return (
    <div className={s.rulerRow} data-edge={edge} aria-hidden="true">
      <span className={s.rulerLabel}>{edge === "top" ? "lane" : ""}</span>
      <div className={s.ruler}>
        {edge === "top" ? (
          <>
            <span className={s.paddockLabel}>book</span>
            {ticks.map((t) => (
              <span key={t} className={s.tick} style={{ "--x": (t * 100) / maxBps } as Vars}>
                {t === 0 ? "0" : `${t}%`}
              </span>
            ))}
          </>
        ) : (
          <>
            <span className={s.mark} data-k="pool" style={{ "--x": minBps / maxBps } as Vars}>
              pool takes {fmtBpsParam(minBps)}
            </span>
            <span className={s.mark} data-k="fee" style={{ "--x": feeBps / maxBps } as Vars}>
              fixed {fmtBpsParam(feeBps)} liquidation
            </span>
          </>
        )}
      </div>
      <span className={s.rulerOut}>{edge === "top" ? "outcome" : ""}</span>
    </div>
  );
}

function Lane({
  label,
  accounts,
  d,
  rows,
  shared = false,
  empty,
}: {
  label: string;
  accounts: ArenaAccount[];
  d: ArenaDesign;
  rows: number;
  shared?: boolean;
  empty?: string;
}) {
  const { maxBps, minDiscountBps, feeBps, stepBps } = d.params;
  const lane = accounts[0]?.lane ?? 0;
  const min = minDiscountBps[shared ? 0 : lane] ?? minDiscountBps[0] ?? 75;
  const clock = laneClock(accounts);
  const out = laneOutcome(accounts, feeBps, stepBps);
  // Book (paddock) slots and sub-track rows, in a stable order.
  // In the book, accounts fill the sub-track rows column by column; on the scale each keeps its row.
  let book = 0;
  const placed = accounts.map((a, i) => {
    if (place(a, maxBps) !== null) return { a, slot: 0, row: i % rows };
    const n = book++;
    return { a, slot: Math.floor(n / rows), row: n % rows };
  });
  return (
    <div className={s.laneRow} data-shared={shared ? "" : undefined} data-clock={clock.state} style={{ "--rows": rows } as Vars}>
      <span className={`${s.laneLabel} mono`}>{label}</span>
      <div className={s.track}>
        <Guides minFrac={min / maxBps} feeFrac={feeBps / maxBps} />
        <i className={s.fill} style={{ "--x": Math.min(1, clock.bps / maxBps) } as Vars} aria-hidden="true" />
        {placed.map(({ a, slot, row }) => (
          <Marker key={a.account} a={a} maxBps={maxBps} feeBps={feeBps} slot={slot} row={row} rows={rows} />
        ))}
        {empty && accounts.length === 0 ? <span className={s.trackNote}>{empty}</span> : null}
      </div>
      <span className={s.laneOut} data-tone={out.tone}>
        <b className="mono">{out.main}</b>
        {out.sub ? <small className="mono">{out.sub}</small> : null}
      </span>
    </div>
  );
}

function describe(d: ArenaDesign, shared: boolean): string {
  const accts = d.lanes.flatMap((l) => l.accounts);
  const t = TALLY.filter((k) => d.counts[k] > 0)
    .map((k) => `${d.counts[k]} ${STATE_LABEL[k]}`)
    .join(", ");
  return `${shared ? "Naive build, one shared lane" : "Paraclr, 8 lanes"}: ${accts.length} accounts${t ? `, ${t}` : ""}.`;
}

/**
 * Both designs on one discount axis: Paraclr's 8 lanes, then the naive build's single lane holding
 * the same accounts. `between` renders between the two (the naive design's heading).
 */
export function LaneBoard({
  paraclr,
  naive,
  emptyNote,
  between,
}: {
  paraclr: ArenaDesign;
  naive: ArenaDesign | null;
  emptyNote: string | null;
  between: ReactNode;
}) {
  const { maxBps, minDiscountBps, feeBps } = paraclr.params;
  const rows = Math.min(3, Math.max(1, ...paraclr.lanes.map((l) => l.accounts.length)));
  const shared = naive ? naive.lanes.flatMap((l) => l.accounts) : [];
  const sharedRows = Math.min(4, Math.max(2, Math.ceil(shared.length / 4)));
  return (
    <div className={s.board}>
      <Ruler maxBps={maxBps} minBps={minDiscountBps[0] ?? 75} feeBps={feeBps} edge="top" />
      <div className={s.lanes} role="img" aria-label={describe(paraclr, false)}>
        {paraclr.lanes.map((l) => (
          <Lane key={l.lane} label={`L${l.lane}`} accounts={l.accounts} d={paraclr} rows={rows} />
        ))}
        {emptyNote ? <p className={s.boardNote}>{emptyNote}</p> : null}
      </div>
      {naive ? (
        <>
          {between}
          <div className={s.lanes} data-shared="" role="img" aria-label={describe(naive, true)}>
            <Lane
              label="L*"
              accounts={shared}
              d={naive}
              rows={sharedRows}
              shared
              empty={emptyNote ? "the same accounts, all in one lane" : undefined}
            />
          </div>
        </>
      ) : null}
      <Ruler maxBps={maxBps} minBps={minDiscountBps[0] ?? 75} feeBps={feeBps} edge="bottom" />
    </div>
  );
}
