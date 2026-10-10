"use client";

// The Arena: a public clearing console. Anyone presses "Crash the market" and watches the demo
// stack's accounts go underwater and clear through per-block Dutch auctions in Paraclr's 8 lanes,
// next to a naive build where every lane shares one set of storage, ending with a settlement report
// and the Conflict X-ray of the actual transactions. Talks only to the arena keeper (useArena.ts).

import Link from "next/link";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Mark } from "@/components/landing/brand/Logo";
import { XrayPanel } from "@/components/clearing/XrayPanel";
import { LaneBoard, sumKept, Tally } from "./Lanes";
import { ausd, fmtAusd, fmtBps, fmtCountdown, fmtSeconds, fmtSigned, shortAddr, timeAgo } from "./format";
import type { ArenaAuctionsSummary, ArenaDesign, ArenaFeedTx, ArenaView, RunReport, SweepTxJson } from "./types";
import { postCrash, useArena } from "./useArena";
import s from "./Arena.module.css";

type Vars = CSSProperties & Record<`--${string}`, string | number>;

const LIVE = new Set(["crashing", "resolving", "xray"]);

const KIND_LABEL: Record<string, string> = {
  shockPrices: "oracle shock -20%",
  startAuctions: "start auctions",
  backstopTakeBatch: "pool take",
  expireBatch: "expire at cap",
  cancelAuction: "cancel (cured)",
  take: "external take",
  closePosition: "taker closes",
  recover: "prices restored",
  setPrices: "prices set",
  seedAccounts: "seed book",
  "top-up (cure)": "trader top-up",
};

function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const num = (v: string | undefined | null): number | null => {
  const n = v === undefined || v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------------------
// Phase: one calm, accurate sentence for whatever the keeper is doing
// ---------------------------------------------------------------------------

type Phase =
  | { k: "connecting" }
  | { k: "offline" }
  | { k: "live"; mine: boolean; block: number | null; step: string }
  | { k: "refuelling" }
  | { k: "seeding"; elapsedS: number; expectS: number | null; recovering: boolean }
  | { k: "starting" }
  | { k: "error" }
  | { k: "daily-cap"; message: string }
  | { k: "cooldown"; leftS: number; totalS: number }
  | { k: "ready" };

function phaseOf(view: ArenaView | null, offline: boolean, now: number, fetchedAt: number, myRunId: string | null, sinceShock: number | null): Phase {
  if (!view) return offline ? { k: "offline" } : { k: "connecting" };
  if (offline) return { k: "offline" };
  if (LIVE.has(view.state)) {
    const step = view.state === "crashing" ? "sending the shock" : view.state === "resolving" ? "auctions clearing" : "tracing the X-ray";
    return { k: "live", mine: !!myRunId && view.current?.runId === myRunId, block: sinceShock, step };
  }
  const code = view.reason?.code ?? null;
  if (code === "refuelling" || view.budget.refuelling) return { k: "refuelling" };
  if (view.state === "seeding" || view.state === "recovering") {
    const seedMs = num(String(view.budget.lastCycleCost?.timings?.seedMs ?? ""));
    return {
      k: "seeding",
      elapsedS: Math.max(0, Math.round((view.now + (now - fetchedAt) - view.stateSince) / 1000)),
      expectS: seedMs ? Math.round(seedMs / 1000) : null,
      recovering: view.state === "recovering",
    };
  }
  if (view.state === "starting") return { k: "starting" };
  if (view.state === "error") return { k: "error" };
  if (code === "daily-cap") return { k: "daily-cap", message: view.reason?.message ?? "Today's crashes are used up." };
  // `now` ticks once a second and can lag the latest fetch: never count elapsed time below zero.
  const left = Math.max(0, Math.ceil(view.cooldownRemainingS - Math.max(0, now - fetchedAt) / 1000));
  if (left > 0) return { k: "cooldown", leftS: left, totalS: view.cooldownS };
  return { k: "ready" };
}

// ---------------------------------------------------------------------------
// The control: one button, one state line
// ---------------------------------------------------------------------------

function Ring({ frac }: { frac: number }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <svg className={s.ring} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r={r} className={s.ringTrack} />
      <circle cx="12" cy="12" r={r} className={s.ringFill} strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(1, Math.max(0, frac)))} />
    </svg>
  );
}

/** Operator gas against its threshold, and the 8 lane keepers against theirs. */
function GasGauge({ view }: { view: ArenaView }) {
  const t = view.budget.thresholds;
  const b = view.budget.balances;
  if (!t || !b) return null;
  const opMin = num(t.operatorMon);
  const op = num(b.operator.mon);
  const kMin = num(t.keeperMon);
  if (opMin === null || op === null || kMin === null) return null;
  return (
    <div className={s.gauge}>
      <div className={s.gaugeRow}>
        <span>operator</span>
        <span className={s.gaugeBar} style={{ "--x": Math.min(1, op / opMin) } as Vars} data-low={op < opMin ? "" : undefined}>
          <i />
        </span>
        <span className="mono">
          {op.toFixed(2)} / {opMin.toFixed(2)} MON
        </span>
      </div>
      <div className={s.gaugeRow}>
        <span>lane keepers</span>
        <span className={s.gaugeLanes}>
          {Array.from({ length: 8 }, (_, lane) => {
            const k = b.keepers.find((x) => x.lane === lane);
            const v = num(k?.mon);
            return (
              <span
                key={lane}
                className={s.gaugeBar}
                style={{ "--x": v === null ? 0 : Math.min(1, v / kMin) } as Vars}
                data-low={v !== null && v < kMin ? "" : undefined}
                title={`Lane ${lane} keeper: ${v === null ? "-" : v.toFixed(3)} / ${kMin} MON`}
              >
                <i />
              </span>
            );
          })}
        </span>
        <span className="mono">{b.keepers.filter((k) => (num(k.mon) ?? 0) >= kMin).length} / 8 ready</span>
      </div>
    </div>
  );
}

function Control({
  view,
  phase,
  onCrash,
  busy,
  refusal,
}: {
  view: ArenaView | null;
  phase: Phase;
  onCrash: () => void;
  busy: boolean;
  refusal: string | null;
}) {
  const drop = (10_000 - (view?.shockBps ?? 8_000)) / 100;
  const enabled = phase.k === "ready" && !!view?.canCrash && !busy;
  let tone: "ready" | "live" | "wait" | "fail" = "wait";
  let line: ReactNode;
  let sub: ReactNode = null;
  let lead: ReactNode = <i className={s.dot} aria-hidden="true" />;
  switch (phase.k) {
    case "connecting":
      line = "Connecting to the arena keeper";
      break;
    case "offline":
      line = "Keeper unreachable · retrying";
      sub = "The page reconnects on its own.";
      break;
    case "live":
      tone = "live";
      line = (
        <>
          {phase.mine ? "Your crash is live" : "Someone just crashed it"}
          {phase.block !== null ? (
            <>
              {" "}
              · block <b className="mono">+{phase.block}</b>
            </>
          ) : null}
        </>
      );
      sub = (
        <>
          {phase.step[0].toUpperCase() + phase.step.slice(1)}.{" "}
          <a href="#lanes" className={s.jump}>
            Watch the lanes
          </a>
        </>
      );
      break;
    case "refuelling":
      line = "Refuelling · crashes resume when the keepers have gas";
      sub = view ? <GasGauge view={view} /> : null;
      break;
    case "seeding": {
      const frac = phase.expectS ? Math.min(0.95, phase.elapsedS / phase.expectS) : null;
      lead = frac !== null ? <Ring frac={frac} /> : lead;
      line = phase.recovering ? "Restoring prices after the crash" : "Seeding a fresh book";
      sub = phase.expectS ? `${phase.elapsedS} s of about ${phase.expectS} s` : `${phase.elapsedS} s`;
      break;
    }
    case "starting":
      line = "Starting up";
      break;
    case "error":
      tone = "fail";
      line = "The keeper hit an error · it retries on its own";
      break;
    case "daily-cap":
      line = "Today's crashes are used up · back tomorrow (UTC)";
      break;
    case "cooldown":
      lead = <Ring frac={1 - phase.leftS / Math.max(1, phase.totalS)} />;
      line = (
        <>
          Next crash in <b className="mono">{fmtCountdown(phase.leftS)}</b>
        </>
      );
      sub = `One crash at a time for everyone, ${fmtCountdown(phase.totalS)} apart.`;
      break;
    case "ready":
      tone = "ready";
      line = "Ready";
      sub = view?.last ? "Press to crash it for everyone watching." : "Nobody has crashed this book yet.";
      break;
  }
  if (busy) {
    tone = "live";
    line = "Sending the oracle shock";
    sub = null;
  }
  return (
    <div className={s.control}>
      <button type="button" className={s.crash} disabled={!enabled} onClick={onCrash} aria-describedby="arena-state">
        <span>Crash the market</span>
        <span className={`${s.crashShock} mono`}>-{drop}%</span>
      </button>
      <div id="arena-state" className={s.state} data-tone={tone} role="status" aria-live="polite">
        <span className={s.stateLead}>{lead}</span>
        <div className={s.stateText}>
          <p className={s.stateLine}>{refusal ?? line}</p>
          {sub && !refusal ? <div className={s.stateSub}>{sub}</div> : null}
        </div>
      </div>
      {view ? (
        <p className={`${s.limits} mono`}>
          {view.budget.daily.used} / {view.budget.daily.max} today · {fmtCountdown(view.limits.cooldownS)} cooldown · 1 per visitor / {Math.round(view.limits.perIpWindowS / 60)} min
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ledger: every tx of the run, newest first
// ---------------------------------------------------------------------------

interface FeedRow {
  key: string;
  block: number | null;
  at: number;
  lane: number | null;
  design: string | null;
  kind: string;
  hash: string;
  status: string;
}

function Ledger({ view, sweeps, fromBlock }: { view: ArenaView; sweeps: SweepTxJson[]; fromBlock: number | null }) {
  const rows = useMemo(() => {
    const out: FeedRow[] = [];
    const seen = new Set<string>();
    const add = (r: FeedRow) => {
      if (seen.has(r.hash)) return;
      seen.add(r.hash);
      out.push(r);
    };
    view.feed.forEach((f: ArenaFeedTx) =>
      add({ key: f.txHash, block: f.block, at: f.at, lane: f.lane, design: f.design, kind: f.kind, hash: f.txHash, status: f.status }),
    );
    sweeps.forEach((t) =>
      add({ key: t.txHash, block: t.block, at: t.submittedAt, lane: t.lane, design: t.design, kind: t.kind, hash: t.txHash, status: t.status }),
    );
    return out
      .filter((r) => fromBlock === null || r.block === null || r.block >= fromBlock - 1 || r.kind === "seedAccounts")
      .filter((r) => r.block !== null || view.now - r.at < 60_000)
      .sort((a, b) => (b.block ?? Number.MAX_SAFE_INTEGER) - (a.block ?? Number.MAX_SAFE_INTEGER) || b.at - a.at)
      .slice(0, 60);
  }, [view.feed, view.now, sweeps, fromBlock]);

  return (
    <section className={s.ledger} aria-labelledby="ledger-title">
      <header className={s.colHead}>
        <h2 id="ledger-title" className={s.colTitle}>
          Ledger
        </h2>
        <span className={s.colMeta}>{rows.length ? `${rows.length} txs · newest first` : "newest first"}</span>
      </header>
      {rows.length === 0 ? (
        <p className={s.ledgerEmpty}>No transactions yet. The first line will be the oracle shock.</p>
      ) : (
        <div className={s.ledgerScroll} tabIndex={0} aria-label="Transactions">
          <table className={s.ledgerTable}>
            <thead>
              <tr>
                <th scope="col">Block</th>
                <th scope="col">Lane</th>
                <th scope="col">Kind</th>
                <th scope="col">Tx</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} data-status={r.status} data-design={r.design === "naive-shared" ? "naive" : r.design ? "paraclr" : "oracle"}>
                  <td className="mono">{r.block !== null ? r.block.toLocaleString("en-US") : "pending"}</td>
                  <td className="mono">
                    {r.design === "naive-shared" ? "N" : r.design ? "" : "-"}
                    {r.lane !== null ? (r.design === "naive-shared" ? `·L${r.lane}` : `L${r.lane}`) : r.design ? "-" : ""}
                  </td>
                  <td>{KIND_LABEL[r.kind] ?? r.kind}</td>
                  <td>
                    {view.explorer ? (
                      <a className={`${s.hash} mono`} href={`${view.explorer}/tx/${r.hash}`} target="_blank" rel="noreferrer">
                        {shortAddr(r.hash, 6, 4)}
                      </a>
                    ) : (
                      <code className={`${s.hash} mono`}>{shortAddr(r.hash, 6, 4)}</code>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className={s.colFoot}>{view.explorer ? "Hashes open on the Monad testnet explorer. N = naive build." : "Local anvil: hashes only. N = naive build."}</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Settlement report
// ---------------------------------------------------------------------------

type Auctions = ArenaAuctionsSummary | NonNullable<RunReport["auctions"]>;

/** Kept vs the fixed penalty from a run summary: Σ fixed penalty − Σ (equity at start − returned). */
function keptOf(a: Auctions | null | undefined): number | null {
  if (!a || a.traderEquityAtStart === undefined) return null;
  const equity = ausd(a.traderEquityAtStart);
  const returned = ausd(a.traderResidualReturned);
  const fixed = ausd(a.legacyCounterfactual.traderLoss);
  if (equity === null || returned === null || fixed === null) return null;
  return fixed - (equity - returned);
}

function liveCounts(d: ArenaDesign | null) {
  if (!d) return null;
  const accts = d.lanes.flatMap((l) => l.accounts);
  const started = accts.filter((a) => a.startBlock !== null || a.state === "auction");
  const debt = accts.reduce((x, a) => x + (ausd(a.badDebt) ?? 0), 0);
  return { accts, started: started.length, debt };
}

/** Blocks from the shock to the last resolution, once nothing is left in auction. */
function resolvedIn(d: ArenaDesign | null, shockBlock: number | null): number | null {
  if (!d || shockBlock === null) return null;
  const accts = d.lanes.flatMap((l) => l.accounts);
  if (accts.some((a) => a.state === "auction" || a.state === "underwater")) return null;
  const blocks = accts.map((a) => a.resolvedBlock).filter((b): b is number => b !== null);
  return blocks.length ? Math.max(...blocks) - shockBlock : null;
}

function Figure({
  label,
  value,
  unit,
  sub,
  tone,
  pending = false,
}: {
  label: string;
  /** Null renders a quiet placeholder ("clearing" while live), never a fake number. */
  value: string | null;
  unit?: string;
  sub?: ReactNode;
  tone?: string;
  pending?: boolean;
}) {
  return (
    <div className={s.figure} data-tone={tone}>
      <span className={s.figLabel}>{label}</span>
      <span className={s.figValue}>
        {value === null ? <span className={s.figNone}>{pending ? "clearing" : "none yet"}</span> : <b>{value}</b>}
        {unit && value !== null ? <small>{unit}</small> : null}
      </span>
      {sub ? <span className={s.figSub}>{sub}</span> : null}
    </div>
  );
}

function Report({
  view,
  report,
  solvency,
  live,
  paraclr,
  naive,
  shockBlock,
  sinceShock,
}: {
  view: ArenaView;
  report: RunReport | null;
  solvency: ReturnType<typeof useArena>["solvency"];
  live: boolean;
  paraclr: ArenaDesign | null;
  naive: ArenaDesign | null;
  shockBlock: number | null;
  sinceShock: number | null;
}) {
  const now = useNow(5_000);
  const fee = paraclr?.params.feeBps ?? 100;
  const last = !live ? view.last : null;
  const r = last && report && report.runId === last.runId ? report : null;

  // Live: tallies from the book. Settled: the run's on-chain summaries.
  const pa: Auctions | null = r?.auctions ?? null;
  const na: Auctions | null = last?.naive?.auctions ?? null;
  const lp = live ? liveCounts(paraclr) : null;
  const ln = live ? liveCounts(naive) : null;
  const keptP = live ? sumKept(lp?.accts ?? [], fee)?.kept ?? null : keptOf(pa);
  const keptN = live ? sumKept(ln?.accts ?? [], fee)?.kept ?? null : keptOf(na);
  const blocksP = live ? resolvedIn(paraclr, shockBlock) : (last?.blocksToResolve["paraclr-lanes"] ?? null);
  const blocksN = live ? resolvedIn(naive, shockBlock) : (last?.blocksToResolve["naive-shared"] ?? null);
  const debtP = live ? (lp?.debt ?? null) : pa ? ausd(pa.badDebt) : null;
  const none = !live && !last;

  const cnt = (d: ArenaDesign | null, k: keyof ArenaDesign["counts"]) => (d ? String(d.counts[k]) : "-");
  const rows: Array<[string, string, string]> = live
    ? [
        ["Went to auction", lp ? String(lp.started) : "-", ln ? String(ln.started) : "-"],
        ["In auction now", cnt(paraclr, "auction"), cnt(naive, "auction")],
        ["Taken by the lane pool", cnt(paraclr, "backstop"), cnt(naive, "backstop")],
        ["Taken externally", cnt(paraclr, "external"), cnt(naive, "external")],
        ["Cured", cnt(paraclr, "cured"), cnt(naive, "cured")],
        ["Expired at the cap", cnt(paraclr, "expired"), cnt(naive, "expired")],
      ]
    : [
        ["Went to auction", pa ? String(pa.started) : "-", na ? String(na.started) : "-"],
        ["Taken by the lane pool", pa ? String(pa.takenByBackstop) : "-", na ? String(na.takenByBackstop) : "-"],
        ["Taken externally", pa ? String(pa.takenExternal) : "-", na ? String(na.takenExternal) : "-"],
        ["Cured", pa ? String(pa.cured) : "-", na ? String(na.cured) : "-"],
        ["Expired at the cap", pa ? String(pa.expired) : "-", na ? String(na.expired) : "-"],
        ["Average take discount", pa ? fmtBps(pa.avgDiscountBps) : "-", na ? fmtBps(na.avgDiscountBps) : "-"],
        ["Returned to traders", pa ? fmtAusd(ausd(pa.traderResidualReturned)) : "-", na ? fmtAusd(ausd(na.traderResidualReturned)) : "-"],
        [`A fixed ${fmtBps(fee)} would take`, pa ? fmtAusd(ausd(pa.legacyCounterfactual.traderLoss)) : "-", na ? fmtAusd(ausd(na.legacyCounterfactual.traderLoss)) : "-"],
        ["Bad debt", pa ? fmtAusd(ausd(pa.badDebt)) : "-", na ? fmtAusd(ausd(na.badDebt)) : "-"],
        [
          "Solvent after",
          solvency.paraclr ? (solvency.paraclr.solvent ? "yes" : "no") : "-",
          solvency.naive ? (solvency.naive.solvent ? "yes" : "no") : "-",
        ],
      ];

  const title = live ? "Live tally" : last ? `Crash #${last.cycle}` : "Settlement";
  const meta = live
    ? sinceShock !== null
      ? `block +${sinceShock} · settles when every auction resolves`
      : "waiting for the shock to land"
    : last
      ? `${timeAgo(now - last.finishedAt)} · ${fmtSeconds(last.finishedAt - last.startedAt)} from button to X-ray`
      : "filled in by the first crash on this chain";

  return (
    <section className={s.report} aria-labelledby="report-title" data-empty={none ? "" : undefined}>
      <header className={s.colHead}>
        <h2 id="report-title" className={s.colTitle}>
          {title}
        </h2>
        <span className={s.colMeta}>{meta}</span>
      </header>

      <div className={s.figures}>
        <Figure
          label="Blocks to resolve"
          value={blocksP !== null ? String(blocksP) : null}
          pending={live}
          sub={
            <>
              Paraclr · naive <b className="mono">{blocksN !== null ? blocksN : live ? "clearing" : "-"}</b>
            </>
          }
        />
        <Figure
          label={`Kept vs a fixed ${fmtBps(fee)} liquidation`}
          value={keptP !== null ? fmtSigned(keptP) : null}
          pending={live}
          unit="AUSD"
          tone={keptP !== null && keptP > 0 ? "pos" : keptP !== null && keptP < 0 ? "neg" : undefined}
          sub={keptN !== null ? <>naive build <b className="mono">{fmtSigned(keptN)}</b></> : "returned to traders, summed over the run"}
        />
        <Figure
          label="Bad debt"
          value={debtP !== null ? fmtAusd(debtP) : null}
          pending={live}
          unit="AUSD"
          sub={debtP !== null ? (debtP > 0 ? "lane-funded shortfall" : "no shortfall in any lane") : "shortfall the lanes absorb"}
        />
      </div>

      {none ? (
        <p className={s.reportNone}>
          Nobody has crashed this deployment yet. The first crash fills this in: blocks to resolve in each design, accounts by
          outcome, what traders kept compared with a fixed {fmtBps(fee)} liquidation, bad debt, and the Conflict X-ray of its
          transactions.
        </p>
      ) : (
      <table className={s.outcomes}>
        <thead>
          <tr>
            <th scope="col">Accounts by outcome</th>
            <th scope="col">Paraclr</th>
            <th scope="col">Naive</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, a, b]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td className="mono">{a}</td>
              <td className="mono">{b}</td>
            </tr>
          ))}
        </tbody>
      </table>
      )}

      <p className={s.colFoot}>
        {last && view.explorer && paraclr ? (
          <>
            <a href={`${view.explorer}/address/${paraclr.contract}`} target="_blank" rel="noreferrer" className={s.link}>
              Paraclr contract on the explorer
            </a>{" "}
            · run <span className="mono">{last.runId}</span>
            {last.status === "failed" ? ` · finished with an error: ${last.error ?? "unknown"}` : ""} ·{" "}
          </>
        ) : null}
        From the run&apos;s AuctionStarted / Taken / Cancelled / Expired events. &quot;Kept&quot; = what a fixed {fmtBps(fee)} of notional
        would have taken, minus what the auctions took.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ArenaPage() {
  const arena = useArena();
  const { view, offline, fetchedAt, sweeps, report, xray, xrayPending, solvency, refresh } = arena;
  const [myRunId, setMyRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const now = useNow();

  useEffect(() => {
    if (!refusal) return;
    const t = setTimeout(() => setRefusal(null), 8_000);
    return () => clearTimeout(t);
  }, [refusal]);

  const onCrash = async () => {
    setBusy(true);
    setRefusal(null);
    const r = await postCrash();
    setBusy(false);
    if (r.ok) setMyRunId(r.runId);
    else setRefusal(r.message);
    refresh();
  };

  const live = view ? LIVE.has(view.state) : false;
  const shockBlock = view?.current?.shockBlock ?? (live ? null : (view?.last?.shockBlock ?? null));
  // The book on screen is the crashed one while the run is live and until the fresh book replaces it.
  const crashedBook = live || view?.state === "recovering" || (view?.state === "seeding" && !!view?.last);
  const sinceShock =
    view && shockBlock !== null && view.head !== null && crashedBook
      ? Math.max(0, (live ? view.head : Math.min(view.head, view.last?.lastBlock ?? view.head)) - shockBlock)
      : null;
  const paraclr = view?.book.designs.find((d) => d.design === "paraclr-lanes") ?? null;
  const naive = view?.book.designs.find((d) => d.design === "naive-shared") ?? null;
  const accounts = paraclr ? paraclr.lanes.reduce((n, l) => n + l.accounts.length, 0) : 0;
  const phase = phaseOf(view, offline, now, fetchedAt, myRunId, sinceShock);
  const monad = view?.network === "monad-testnet";
  const perLane = view?.book.perLane ?? 2;

  // What the board is showing, in one label.
  const boardState: { k: "live" | "crashed" | "book" | "empty"; text: string } = !view
    ? { k: "empty", text: "Connecting" }
    : live
      ? { k: "live", text: `Live · crash #${view.current?.cycle ?? view.cycles + 1}` }
      : crashedBook && accounts > 0
        ? { k: "crashed", text: `Crash #${view.last?.cycle ?? view.cycles} · resolved` }
        : accounts > 0
          ? { k: "book", text: `Fresh book · ${accounts} accounts waiting` }
          : { k: "empty", text: "No book seeded yet" };

  const emptyNote =
    view && accounts === 0
      ? phase.k === "refuelling"
        ? `The keeper seeds ${perLane} synthetic accounts per lane once it has gas. Until then the lanes stand empty.`
        : phase.k === "seeding"
          ? `Seeding ${perLane} synthetic accounts per lane.`
          : `${perLane} synthetic accounts per lane appear here once the keeper seeds a book.`
      : null;

  return (
    <div className={s.page}>
      <a href="#lanes" className={s.skip}>
        Skip to the lanes
      </a>
      <header className={s.bar}>
        <Link href="/" className={s.brand} aria-label="Paraclr home">
          <Mark className={s.brandMark} />
          <span className={s.brandWord}>Paraclr</span>
        </Link>
        <span className={s.barSep} aria-hidden="true" />
        <span className={s.barTitle}>Arena</span>
        <div className={s.barRight}>
          <span className={s.net} data-net={view ? (monad ? "monad" : "anvil") : undefined}>
            <i aria-hidden="true" />
            {view ? (monad ? `Monad testnet · ${view.chainId}` : "Local anvil, not Monad") : "connecting"}
          </span>
          {view?.head != null ? (
            <span className={`${s.barHead} mono`} title="Chain head">
              #{view.head.toLocaleString("en-US")}
            </span>
          ) : null}
          <Link href="/app" className={s.barLink}>
            Open the app
          </Link>
        </div>
      </header>

      <main className={s.main} id="main">
        <section className={s.command} aria-labelledby="arena-title">
          <div className={s.commandText}>
            <p className={s.eyebrow}>Arena · public crash test</p>
            <h1 id="arena-title" className={s.h1}>
              Crash the market. <em>Watch 8&nbsp;lanes clear&nbsp;it.</em>
            </h1>
            <p className={s.lede}>
              One oracle transaction drops every market {(10_000 - (view?.shockBps ?? 8_000)) / 100}%, and the same synthetic book clears
              block by block in Paraclr&apos;s lanes and in a naive build where every lane shares one set of storage.
            </p>
          </div>
          <Control view={view} phase={phase} onCrash={onCrash} busy={busy} refusal={refusal} />
        </section>

        <section id="lanes" className={s.lanesSection} aria-labelledby="lanes-title" tabIndex={-1}>
          <header className={s.lanesHead}>
            <div>
              <h2 id="lanes-title" className={s.h2}>
                Paraclr · 8 lanes
              </h2>
              <p className={s.h2Sub}>Each lane has its own auction, backstop pool and ledger. Nothing is shared.</p>
            </div>
            <div className={s.counter} data-k={boardState.k}>
              <span className={s.counterLabel}>
                <i aria-hidden="true" />
                {boardState.text}
              </span>
              {sinceShock !== null ? (
                <>
                  <span className={s.counterValue}>
                    <small>block</small>
                    <b className="mono">+{sinceShock}</b>
                  </span>
                  <span className={s.counterSub}>since the oracle shock</span>
                </>
              ) : (
                <span className={s.counterIdle}>The block clock starts at the oracle shock.</span>
              )}
            </div>
          </header>

          <ol className={s.howto} aria-label="How to read this">
            <li>
              <b className="mono">01</b>
              <span>Each dot is one account. Left of the start line it is safe in the book.</span>
            </li>
            <li>
              <b className="mono">02</b>
              <span>
                Underwater, it enters its lane&apos;s auction and moves right as the discount rises{" "}
                {paraclr ? fmtBps(paraclr.params.stepBps) : "0.05%"} a block.
              </span>
            </li>
            <li>
              <b className="mono">03</b>
              <span>
                The lane&apos;s pool takes it at {paraclr ? fmtBps(paraclr.params.minDiscountBps[0] ?? 75) : "0.75%"}. Taken left of the
                fixed {paraclr ? fmtBps(paraclr.params.feeBps) : "1%"} line, the trader kept more than a classic liquidation leaves.
              </span>
            </li>
          </ol>

          {paraclr ? (
            <>
              <Tally d={paraclr} caption="Paraclr accounts by state" />
              <LaneBoard
                paraclr={paraclr}
                naive={naive}
                emptyNote={emptyNote}
                between={
                  naive ? (
                    <div className={s.naiveHead}>
                      <div>
                        <h3 className={s.h3}>Naive build · 1 shared lane</h3>
                        <p className={s.h2Sub}>
                          The same accounts on the same code, with every lane&apos;s pool, insurance and counters on one storage key.
                        </p>
                      </div>
                      <Tally d={naive} caption="Naive build accounts by state" />
                    </div>
                  ) : null
                }
              />
              {paraclr.others.started > 0 ? (
                <p className={s.boardFoot}>
                  Plus {paraclr.others.started} account{paraclr.others.started === 1 ? "" : "s"} left over from earlier runs went to auction in
                  this crash: counted in the report, not drawn.
                </p>
              ) : null}
            </>
          ) : (
            <p className={s.boardWait}>{offline ? "The arena keeper is unreachable. The board fills in when it answers." : "Loading the book…"}</p>
          )}
        </section>

        {view ? (
          <div className={s.lower}>
            <Report
              view={view}
              report={report}
              solvency={solvency}
              live={live}
              paraclr={paraclr}
              naive={naive}
              shockBlock={shockBlock}
              sinceShock={sinceShock}
            />
            <Ledger view={view} sweeps={sweeps} fromBlock={shockBlock} />
          </div>
        ) : null}

        {view && (live || view.last) ? (
          <section className={s.xray} aria-label="Conflict X-ray of this crash">
            <XrayPanel
              xray={live ? null : xray}
              source={view.last ? { kind: "run", runId: view.last.runId } : null}
              pending={live || xrayPending}
              error={view.last?.xrayError ?? null}
            />
          </section>
        ) : null}

        <footer className={s.foot}>
          <p className={s.fine}>
            Demo stack on {monad || !view ? "Monad testnet" : "a local anvil chain"} · MockOracle shock · synthetic accounts · test funds
            (MockAUSD) · no sign-in, no wallet
            {view?.book.cure ? " · one account per run gets a demo top-up mid-auction to show a cure" : ""}
          </p>
          <p className={s.footLinks}>
            <Link href="/" className={s.link}>
              Paraclr home
            </Link>
            <Link href="/#xray" className={s.link}>
              How the X-ray works
            </Link>
            <Link href="/app" className={s.link}>
              Open the app
            </Link>
          </p>
        </footer>
      </main>
    </div>
  );
}
