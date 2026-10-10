"use client";

// The two books side by side: Paraclr's 8 lanes (one row per lane, its own discount clock) and the
// naive baseline's one shared book (the same accounts as one list, with the fixed-penalty outcome a
// classic liquidation would charge). Cell colours follow the clearing screen's auction states.

import type { CSSProperties } from "react";
import type { AccountState, ArenaAccount, ArenaDesign } from "./types";
import { ausd, fmtAusd, fmtBps, shortAddr } from "./format";
import s from "./Arena.module.css";

export const STATE_LABEL: Record<AccountState, string> = {
  healthy: "healthy",
  underwater: "underwater",
  auction: "in auction",
  backstop: "taken by backstop",
  external: "taken externally",
  cured: "cured",
  expired: "expired",
};

function cellStyle(a: ArenaAccount, maxBps: number): CSSProperties | undefined {
  if (a.state !== "auction") return undefined;
  // Brighter as the discount climbs: 40% → 100% warn from 0 to MAX.
  const pct = Math.round(40 + 60 * Math.min(1, (a.discountBps ?? 0) / Math.max(1, maxBps)));
  return { background: `color-mix(in srgb, var(--warn) ${pct}%, var(--bg-elev-2))` };
}

function cellTitle(a: ArenaAccount): string {
  const parts = [`${a.account} · lane ${a.lane}`, STATE_LABEL[a.state]];
  if (a.state === "auction") parts.push(`discount ${fmtBps(a.discountBps)}`);
  if ((a.state === "backstop" || a.state === "external") && a.discountBps !== null) parts.push(`taken at ${fmtBps(a.discountBps)}`);
  if (a.residual !== null) parts.push(`returned ${fmtAusd(ausd(a.residual))} AUSD`);
  if (a.badDebt !== null && a.badDebt !== "0") parts.push(`lane-funded shortfall ${fmtAusd(ausd(a.badDebt))} AUSD`);
  if (a.profile === "cure") parts.push("demo top-up mid-auction");
  return parts.join(" · ");
}

function Cell({ a, maxBps, big = false }: { a: ArenaAccount; maxBps: number; big?: boolean }) {
  const debt = a.badDebt !== null && a.badDebt !== "0";
  return (
    <span
      className={big ? s.cellBig : s.cell}
      data-s={a.state}
      data-debt={debt ? "" : undefined}
      style={cellStyle(a, maxBps)}
      title={cellTitle(a)}
      role="img"
      aria-label={`${shortAddr(a.account)}: ${STATE_LABEL[a.state]}${a.state === "auction" ? ` at ${fmtBps(a.discountBps)}` : ""}`}
    />
  );
}

function Clock({ bps, maxBps, minBps, state, label }: { bps: number; maxBps: number; minBps: number; state: string; label: string }) {
  return (
    <div className={s.clock} data-clock={state} title={label}>
      <i className={s.clockFill} style={{ transform: `scaleX(${Math.min(1, bps / Math.max(1, maxBps))})` }} />
      <i className={s.clockMin} style={{ left: `${Math.min(1, minBps / Math.max(1, maxBps)) * 100}%` }} />
    </div>
  );
}

function laneClock(accts: ArenaAccount[]) {
  const live = accts.filter((a) => a.state === "auction");
  const taken = accts.filter((a) => (a.state === "backstop" || a.state === "external") && a.discountBps !== null);
  if (live.length) return { bps: Math.max(...live.map((a) => a.discountBps ?? 0)), state: "tick", live: live.length };
  if (taken.length) return { bps: taken.reduce((x, a) => x + (a.discountBps ?? 0), 0) / taken.length, state: "taken", live: 0 };
  return { bps: 0, state: "idle", live: 0 };
}

function Counts({ d }: { d: ArenaDesign }) {
  const c = d.counts;
  const items: Array<[AccountState, number]> = [
    ["underwater", c.underwater],
    ["auction", c.auction],
    ["backstop", c.backstop],
    ["external", c.external],
    ["cured", c.cured],
    ["expired", c.expired],
    ["healthy", c.healthy],
  ];
  return (
    <div className={s.counts}>
      {items
        .filter(([k, n]) => n > 0 || k === "auction" || k === "backstop")
        .map(([k, n]) => (
          <span key={k} data-k={k}>
            <i data-s={k} aria-hidden="true" />
            {STATE_LABEL[k]} <b className="mono">{n}</b>
          </span>
        ))}
    </div>
  );
}

export function ParaclrLanes({ d, sinceShock }: { d: ArenaDesign; sinceShock: number | null }) {
  const { maxBps, minDiscountBps } = d.params;
  return (
    <section className={s.book} aria-labelledby="book-paraclr">
      <header className={s.bookHead}>
        <div className={s.bookHeadText}>
          <h2 id="book-paraclr" className={s.bookTitle}>
            Paraclr · 8 lanes
          </h2>
          <p className={s.bookSub}>
            Each lane runs its own per-block Dutch auction and backstop pool. Discount +{fmtBps(d.params.stepBps)} per block, pool
            takes at {fmtBps(minDiscountBps[0] ?? 0)}, max {fmtBps(maxBps)}.
          </p>
        </div>
        <span className={s.blockPill} title="Blocks since the oracle shock">
          {sinceShock !== null ? (
            <>
              <small>block</small> <b className="mono">+{sinceShock}</b>
            </>
          ) : (
            <small>idle</small>
          )}
        </span>
      </header>
      <Counts d={d} />
      <div className={s.lanes}>
        {d.lanes.map((l) => {
          const clock = laneClock(l.accounts);
          const min = minDiscountBps[l.lane] ?? minDiscountBps[0] ?? 0;
          const resolved = l.accounts.filter((a) => a.resolvedBlock !== null).length;
          const status =
            clock.live > 0
              ? `${clock.live} · ${fmtBps(clock.bps)}`
              : resolved > 0
                ? `${resolved} resolved`
                : `${l.accounts.length} acc`;
          return (
            <div key={l.lane} className={s.lane} data-clock={clock.state}>
              <div className={s.laneLabel}>
                <span>Lane {l.lane}</span>
                <small className="mono">{status}</small>
              </div>
              <div className={s.laneBody}>
                <div className={s.laneCells}>
                  {l.accounts.map((a) => (
                    <Cell key={a.account} a={a} maxBps={maxBps} big />
                  ))}
                </div>
                <Clock
                  bps={clock.bps}
                  maxBps={maxBps}
                  minBps={min}
                  state={clock.state}
                  label={`Lane ${l.lane} discount clock: 0 → ${fmtBps(maxBps)}; its pool takes at ${fmtBps(min)}`}
                />
              </div>
            </div>
          );
        })}
      </div>
      {d.others.started > 0 && (
        <p className={s.note}>
          Plus {d.others.started} account{d.others.started === 1 ? "" : "s"} left over from earlier runs went to auction in this crash
          (counted in the results, not drawn).
        </p>
      )}
    </section>
  );
}

export function NaiveBook({ d, sinceShock }: { d: ArenaDesign; sinceShock: number | null }) {
  const { maxBps, minDiscountBps, feeBps } = d.params;
  const accts = d.lanes.flatMap((l) => l.accounts);
  const clock = laneClock(accts);
  return (
    <section className={s.book} data-design="naive" aria-labelledby="book-naive">
      <header className={s.bookHead}>
        <div className={s.bookHeadText}>
          <h2 id="book-naive" className={s.bookTitle}>
            Naive · one shared book
          </h2>
          <p className={s.bookSub}>
            The same accounts on the same code with every per-lane aggregate on one storage key: one insurance fund, one backstop
            pool, one auction list. Right column: what a classic {fmtBps(feeBps)} fixed-penalty liquidation takes.
          </p>
        </div>
        <span className={s.blockPill} title="Blocks since the oracle shock">
          {sinceShock !== null ? (
            <>
              <small>block</small> <b className="mono">+{sinceShock}</b>
            </>
          ) : (
            <small>idle</small>
          )}
        </span>
      </header>
      <Counts d={d} />
      <Clock
        bps={clock.bps}
        maxBps={maxBps}
        minBps={minDiscountBps[0] ?? 0}
        state={clock.state}
        label={`Shared discount clock: 0 → ${fmtBps(maxBps)}; the one shared pool takes at ${fmtBps(minDiscountBps[0] ?? 0)}`}
      />
      <ol className={s.list}>
        {accts.map((a) => {
          const penalty = ausd(a.fixedPenalty);
          return (
            <li key={a.account} className={s.row} data-s={a.state}>
              <Cell a={a} maxBps={maxBps} />
              <span className={s.rowLane}>L{a.lane}</span>
              <code className={s.rowAddr}>{shortAddr(a.account)}</code>
              <span className={s.rowState}>
                {STATE_LABEL[a.state]}
                {a.state === "auction" ? ` ${fmtBps(a.discountBps)}` : ""}
              </span>
              <span className={`${s.rowPenalty} mono`} title="min(max(equity, 0), notional × fee) at auction start">
                {penalty === null ? (a.state === "healthy" ? "none" : "-") : penalty === 0 ? "0.00" : `-${fmtAusd(penalty)}`}
              </span>
            </li>
          );
        })}
      </ol>
      {d.others.started > 0 && (
        <p className={s.note}>
          Plus {d.others.started} account{d.others.started === 1 ? "" : "s"} from earlier runs (counted in the results, not listed).
        </p>
      )}
    </section>
  );
}

export function Legend() {
  const keys: AccountState[] = ["healthy", "underwater", "auction", "backstop", "external", "cured", "expired"];
  return (
    <div className={s.legend}>
      {keys.map((k) => (
        <span key={k}>
          <i data-s={k} aria-hidden="true" />
          {k === "auction" ? "in auction (brighter = deeper discount)" : STATE_LABEL[k]}
        </span>
      ))}
      <span>
        <i data-s="backstop" data-debt="" aria-hidden="true" />
        lane-funded shortfall
      </span>
      <span>
        <i data-k="min" aria-hidden="true" />
        pool&apos;s minimum discount
      </span>
    </div>
  );
}
