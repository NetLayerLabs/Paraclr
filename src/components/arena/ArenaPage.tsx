"use client";

// The Arena: a public page where anyone presses "Crash the market" and watches the demo stack's
// accounts go underwater and get resolved by per-block Dutch auctions in 8 lanes, next to the naive
// shared-state baseline, ending with the Conflict X-ray built from the actual transactions.
// Talks only to the arena keeper's HTTP API (useArena.ts).

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ParaclrLogo } from "@/components/brand/ParaclrLogo";
import { XrayPanel } from "@/components/clearing/XrayPanel";
import { Legend, NaiveBook, ParaclrLanes } from "./Books";
import { ausd, fmtAusd, fmtBps, fmtCountdown, fmtSeconds, shortAddr } from "./format";
import type { ArenaAuctionsSummary, ArenaFeedTx, ArenaView, RunReport, SweepTxJson } from "./types";
import { postCrash, useArena } from "./useArena";
import s from "./Arena.module.css";

const LIVE = new Set(["crashing", "resolving", "xray"]);

const KIND_LABEL: Record<string, string> = {
  shockPrices: "oracle shock -20%",
  startAuctions: "start auctions",
  backstopTakeBatch: "backstop take",
  expireBatch: "expire at max",
  cancelAuction: "cancel (cured)",
  take: "external take",
  closePosition: "taker closes",
  recover: "prices restored",
  setPrices: "prices set",
  seedAccounts: "seed fresh book",
  "top-up (cure)": "trader top-up (demo)",
};

const PHASE_TEXT: Record<string, string> = {
  starting: "Starting up",
  seeding: "Seeding a fresh book",
  ready: "Ready",
  crashing: "Shocking the oracle",
  resolving: "Auctions resolving",
  xray: "Tracing the Conflict X-ray",
  recovering: "Restoring prices",
  error: "Retrying after an error",
};

function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function networkLabel(v: ArenaView | null): string {
  if (!v) return "connecting";
  return v.network === "monad-testnet" ? "live on Monad testnet" : "local anvil (not Monad)";
}

// ---------------------------------------------------------------------------
// Crash button
// ---------------------------------------------------------------------------

function CrashButton({
  view,
  offline,
  fetchedAt,
  myRunId,
  onCrash,
  busy,
  refusal,
}: {
  view: ArenaView | null;
  offline: boolean;
  fetchedAt: number;
  myRunId: string | null;
  onCrash: () => void;
  busy: boolean;
  refusal: string | null;
}) {
  const now = useNow();
  const live = view ? LIVE.has(view.state) : false;
  const mine = !!(myRunId && view?.current?.runId === myRunId);
  // `now` ticks once a second and can lag the latest fetch: never count elapsed time below zero.
  const cooldown = view ? Math.max(0, Math.ceil(view.cooldownRemainingS - Math.max(0, now - fetchedAt) / 1000)) : 0;
  const code = view?.reason?.code ?? null;
  const drop = (10_000 - (view?.shockBps ?? 8_000)) / 100;

  let label = `Crash the market −${drop}%`;
  let status: string;
  let enabled = false;
  if (offline || !view) {
    status = offline ? "The arena keeper is offline right now. Try again in a minute." : "Connecting to the arena keeper…";
  } else if (live) {
    label = "Crash in progress";
    status = mine ? "Your crash is live - watch it below." : "Someone just crashed it - watch below.";
  } else if (code === "refuelling") {
    label = "Arena is refuelling";
    status = "The keeper wallets are low on testnet MON. Crashes resume once they are topped up.";
  } else if (view.state === "seeding" || view.state === "recovering" || view.state === "starting") {
    label = "Seeding a fresh book…";
    status = "Restoring prices and seeding fresh accounts for the next crash.";
  } else if (view.state === "error") {
    label = "Arena is retrying…";
    status = "The keeper hit an error and retries on its own.";
  } else if (code === "daily-cap") {
    label = "Back tomorrow";
    status = view.reason?.message ?? "Today's crashes are used up.";
  } else if (cooldown > 0) {
    label = `Next crash in ${fmtCountdown(cooldown)}`;
    status = `Cooling down between crashes (${fmtCountdown(view.cooldownS)} after each one).`;
  } else {
    enabled = view.canCrash && !busy;
    status = view.last ? "Ready for the next crash." : "Ready. Nobody has crashed it yet.";
  }
  if (busy) label = "Sending the shock…";

  return (
    <div className={s.cta}>
      <button type="button" className={s.crashBtn} disabled={!enabled} onClick={onCrash} aria-describedby="arena-status">
        {label}
      </button>
      <p id="arena-status" className={s.status} role="status" aria-live="polite">
        {refusal ?? status}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tx feed
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

function TxFeed({ view, sweeps, fromBlock }: { view: ArenaView; sweeps: SweepTxJson[]; fromBlock: number | null }) {
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
      // Newest first; a pending tx (no block yet) sorts as the newest only while it is fresh.
      .filter((r) => r.block !== null || view.now - r.at < 60_000)
      .sort((a, b) => (b.block ?? Number.MAX_SAFE_INTEGER) - (a.block ?? Number.MAX_SAFE_INTEGER) || b.at - a.at)
      .slice(0, 40);
  }, [view.feed, view.now, sweeps, fromBlock]);

  return (
    <section className={s.feed} aria-labelledby="feed-title">
      <header className={s.feedHead}>
        <h2 id="feed-title" className={s.bookTitle}>
          Live transactions
        </h2>
        <span className={s.bookSub}>{view.explorer ? "Every hash opens on the Monad testnet explorer" : "Local anvil: hashes only"}</span>
      </header>
      {rows.length === 0 ? (
        <p className={s.empty}>No transactions yet. Press the button.</p>
      ) : (
        <div className={s.feedScroll}>
          <table className={s.feedTable}>
            <thead>
              <tr>
                <th scope="col">Block</th>
                <th scope="col">Design</th>
                <th scope="col">Lane</th>
                <th scope="col">Kind</th>
                <th scope="col">Tx</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} data-status={r.status}>
                  <td className="mono">{r.block !== null ? `#${r.block.toLocaleString("en-US")}` : "pending"}</td>
                  <td>{r.design === "naive-shared" ? "naive" : r.design === "paraclr-lanes" ? "paraclr" : "oracle"}</td>
                  <td className="mono">{r.lane !== null ? `L${r.lane}` : "-"}</td>
                  <td>{KIND_LABEL[r.kind] ?? r.kind}</td>
                  <td>
                    {view.explorer ? (
                      <a className={`${s.hash} mono`} href={`${view.explorer}/tx/${r.hash}`} target="_blank" rel="noreferrer">
                        {shortAddr(r.hash, 8, 6)}
                      </a>
                    ) : (
                      <code className={s.hash}>{shortAddr(r.hash, 8, 6)}</code>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** "What traders kept", straight from the run's auction summary (keeper/src/crash.ts summarizeAuctions). */
function kept(a: ArenaAuctionsSummary | RunReport["auctions"] | undefined | null) {
  if (!a || a.traderEquityAtStart === undefined) return null;
  const equity = ausd(a.traderEquityAtStart);
  const returned = ausd(a.traderResidualReturned);
  const fixed = ausd(a.legacyCounterfactual.traderLoss);
  if (equity === null || returned === null || fixed === null) return null;
  const tookAuctions = equity - returned;
  return { equity, returned, tookAuctions, fixed, keptMore: fixed - tookAuctions };
}

function Results({
  view,
  report,
  solvency,
}: {
  view: ArenaView;
  report: RunReport | null;
  solvency: ReturnType<typeof useArena>["solvency"];
}) {
  const last = view.last!;
  const r = report && report.runId === last.runId ? report : null;
  const pa = r?.auctions ?? null;
  const na = last.naive?.auctions ?? null;
  const k = kept(pa);
  const kn = kept(na);
  const paraclr = view.book.designs.find((d) => d.design === "paraclr-lanes");
  const fee = paraclr?.params.feeBps ?? 100;
  const monad = view.network === "monad-testnet";
  const rows: Array<[string, (a: ArenaAuctionsSummary | NonNullable<RunReport["auctions"]>) => string]> = [
    ["Went to auction", (a) => String(a.started)],
    ["Taken by backstop", (a) => String(a.takenByBackstop)],
    ["Taken externally", (a) => String(a.takenExternal)],
    ["Cured", (a) => String(a.cured)],
    ["Expired at max", (a) => String(a.expired)],
    ["Average take discount", (a) => fmtBps(a.avgDiscountBps)],
    ["Lane-funded shortfall", (a) => `${fmtAusd(ausd(a.badDebt))} AUSD`],
  ];

  return (
    <section className={s.results} aria-labelledby="results-title">
      <header className={s.resultsHead}>
        <h2 id="results-title" className={s.resultsTitle}>
          Crash #{last.cycle} results
        </h2>
        <span className={s.bookSub}>
          Run <span className="mono">{last.runId}</span>
          {last.status === "failed" ? ` · finished with an error: ${last.error ?? "unknown"}` : ""}
        </span>
      </header>

      <div className={s.kpis}>
        <div className={s.kpi}>
          <span>Blocks to resolve</span>
          <b className="mono">{last.blocksToResolve["paraclr-lanes"] ?? "-"}</b>
          <small>Paraclr · naive {last.blocksToResolve["naive-shared"] ?? "-"}</small>
        </div>
        <div className={s.kpi} data-good={k && k.keptMore > 0 ? "" : undefined}>
          <span>What traders kept vs a fixed {fmtBps(fee)} penalty</span>
          <b className="mono">{k ? `${k.keptMore >= 0 ? "+" : "-"}${fmtAusd(Math.abs(k.keptMore))}` : "-"}</b>
          <small>AUSD more returned to the traders on Paraclr</small>
        </div>
        <div className={s.kpi}>
          <span>Equity returned to traders</span>
          <b className="mono">{k ? fmtAusd(k.returned) : "-"}</b>
          <small>AUSD by the auctions{k ? ` of ${fmtAusd(k.equity)} at auction start` : ""}</small>
        </div>
        <div className={s.kpi}>
          <span>Lane-funded shortfall</span>
          <b className="mono">{pa ? fmtAusd(ausd(pa.badDebt)) : "-"}</b>
          <small>AUSD (bad debt the lanes covered)</small>
        </div>
      </div>

      {k && (
        <p className={s.explain}>
          On Paraclr the auctions took <b>{fmtAusd(k.tookAuctions)} AUSD</b> from the traders who went under. A classic liquidation
          charging a fixed {fmtBps(fee)} of notional would have taken <b>{fmtAusd(k.fixed)} AUSD</b> from the same accounts at the
          same moment, so traders kept <b>{fmtAusd(k.keptMore)} AUSD</b> more.
          {kn ? (
            <>
              {" "}
              The naive build runs the same auction code: it took {fmtAusd(kn.tookAuctions)} AUSD (same economics); what differs is
              the storage conflicts in the X-ray below.
            </>
          ) : null}
        </p>
      )}

      <div className={s.tableWrap}>
        <table className={s.compare}>
          <thead>
            <tr>
              <th scope="col">This crash</th>
              <th scope="col">Paraclr · 8 lanes</th>
              <th scope="col">Naive · shared</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, f]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td className="mono">{pa ? f(pa) : "-"}</td>
                <td className="mono">{na ? f(na) : "-"}</td>
              </tr>
            ))}
            <tr>
              <th scope="row">Taken from traders</th>
              <td className="mono">{k ? `${fmtAusd(k.tookAuctions)} AUSD` : "-"}</td>
              <td className="mono">{kn ? `${fmtAusd(kn.tookAuctions)} AUSD` : "-"}</td>
            </tr>
            <tr>
              <th scope="row">Fixed {fmtBps(fee)} penalty would take</th>
              <td className="mono">{k ? `${fmtAusd(k.fixed)} AUSD` : "-"}</td>
              <td className="mono">{kn ? `${fmtAusd(kn.fixed)} AUSD` : "-"}</td>
            </tr>
            <tr>
              <th scope="row">Solvent after the crash</th>
              <td>{solvency.paraclr ? (solvency.paraclr.solvent ? "yes" : "no") : "-"}</td>
              <td>{solvency.naive ? (solvency.naive.solvent ? "yes" : "no") : "-"}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className={s.footnote}>
        {monad && view.explorer && paraclr ? (
          <a href={`${view.explorer}/address/${paraclr.contract}`} target="_blank" rel="noreferrer" className={s.link}>
            Every transaction is on Monad testnet ↗
          </a>
        ) : (
          <span>Local anvil run (not Monad): the same transactions, on a dev chain.</span>
        )}{" "}
        Numbers come from the run&apos;s on-chain auction events (AuctionStarted / Taken / Cancelled / Expired). Timing:{" "}
        {fmtSeconds(last.finishedAt - last.startedAt)} from the button to the finished X-ray.
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
  // Blocks since the shock: live while the run resolves, frozen at the last resolution block after it
  // (until the fresh book replaces the crashed one).
  const crashedBook = live || view?.state === "recovering" || view?.state === "seeding";
  const sinceShock =
    view && shockBlock !== null && view.head !== null && crashedBook
      ? Math.max(0, (live ? view.head : Math.min(view.head, view.last?.lastBlock ?? view.head)) - shockBlock)
      : null;
  const paraclr = view?.book.designs.find((d) => d.design === "paraclr-lanes") ?? null;
  const naive = view?.book.designs.find((d) => d.design === "naive-shared") ?? null;
  const showResults = !!view?.last && !live;
  const monad = view?.network === "monad-testnet";

  return (
    <div className={s.page}>
      <header className={s.top}>
        <Link href="/" className={s.brand} aria-label="Paraclr home">
          <ParaclrLogo tone="auto" height={26} />
        </Link>
        <p className={s.topLine}>
          <b>Arena</b> · {networkLabel(view)} · demo stack, test funds
        </p>
      </header>

      <main className={s.main}>
        <section className={s.hero} aria-labelledby="arena-title">
          <div className={s.heroText}>
            <h1 id="arena-title" className={s.h1}>
              Crash the market. Watch it clear.
            </h1>
            <p className={s.lede}>
              One button sends one oracle transaction that drops every market 20%. The same {view ? view.book.perLane * 8 : 24}{" "}
              synthetic accounts sit in two clearinghouses on {monad || !view ? "Monad testnet" : "a local dev chain"}: Paraclr, where
              each of 8 lanes has its own per-block Dutch auction, backstop pool and ledger, and a naive build of the same code where
              every lane shares one set of storage keys. Watch the underwater accounts get auctioned block by block, see what traders
              keep compared with a fixed liquidation penalty, then read the Conflict X-ray traced from the actual transactions.
            </p>
            <ul className={s.tags} aria-label="What this is">
              <li>Demo stack</li>
              <li>MockOracle shock</li>
              <li>Test funds (MockAUSD)</li>
              <li>Synthetic accounts</li>
              <li>No sign-in, no wallet</li>
            </ul>
          </div>
          <CrashButton
            view={view}
            offline={offline}
            fetchedAt={fetchedAt}
            myRunId={myRunId}
            onCrash={onCrash}
            busy={busy}
            refusal={refusal}
          />
        </section>

        {view && (
          <div className={s.phase} data-state={view.state} aria-live="polite">
            <span className={s.phaseDot} aria-hidden="true" />
            <span>
              {PHASE_TEXT[view.state] ?? view.state}
              {live && sinceShock !== null ? ` · block +${sinceShock} since the shock` : ""}
            </span>
            <span className={s.phaseMeta}>
              {view.cycles} crash{view.cycles === 1 ? "" : "es"} so far · {view.budget.daily.used}/{view.budget.daily.max} today
              {view.head !== null ? ` · head #${view.head.toLocaleString("en-US")}` : ""}
            </span>
          </div>
        )}

        {paraclr && naive ? (
          <>
            <div className={s.books}>
              <ParaclrLanes d={paraclr} sinceShock={sinceShock} />
              <NaiveBook d={naive} sinceShock={sinceShock} />
            </div>
            <Legend />
          </>
        ) : (
          <p className={s.empty}>{offline ? "The arena keeper is offline." : "Loading the books…"}</p>
        )}

        {view && <TxFeed view={view} sweeps={sweeps} fromBlock={shockBlock} />}

        {view && showResults && <Results view={view} report={report} solvency={solvency} />}

        {view && (live || showResults) && (
          <XrayPanel
            xray={live ? null : xray}
            source={view.last ? { kind: "run", runId: view.last.runId } : null}
            pending={live || xrayPending}
            error={view.last?.xrayError ?? null}
          />
        )}

        <footer className={s.foot}>
          <p>
            Demo stack only: MockOracle prices, MockAUSD test tokens, keyless synthetic accounts seeded by the keeper. Nothing here has
            real value. One crash at a time for everyone; a short cooldown follows each one
            {view ? ` (${fmtCountdown(view.limits.cooldownS)}, one per visitor every ${Math.round(view.limits.perIpWindowS / 60)} min)` : ""}.
            {view?.book.cure ? " One account per run gets a demo top-up mid-auction to show a cure." : ""}
          </p>
          <p>
            <Link href="/" className={s.link}>
              Paraclr home
            </Link>{" "}
            ·{" "}
            <Link href="/#xray" className={s.link}>
              How the X-ray works
            </Link>
          </p>
        </footer>
      </main>
    </div>
  );
}
