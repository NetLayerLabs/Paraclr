"use client";

// Clearing screen, Live mode. Everything here is read from chain or reported
// by the keeper — nothing is modeled:
//   - lane stats + accounts from the clearinghouse;
//   - the auction lifecycle from the clearinghouse's auction events
//     (AuctionStarted / Taken / Cancelled / Expired), one eth_getLogs per block;
//   - a flash crash run by the keeper (`POST /crash` → poll `GET /runs/:id`):
//     its RunReport gives the measured metrics (time underwater, equity
//     returned, bad debt) and its Conflict X-ray (`GET /runs/:id/xray`).

import { useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { useParaclr } from "@/lib/store";
import { LANE_COUNT, MARKETS } from "@/lib/types";
import { coalesce, readMany, subscribeBlocks } from "@/lib/chain/clients";
import { NETWORK } from "@/lib/chain/config";
import { readableError } from "@/lib/chain/errors";
import { keeperApi, type RunReport, type XrayReport } from "@/lib/chain/keeper";
import { readLaneAccounts, readLanes, readLiquidatable, type LaneStat } from "@/lib/chain/lanes";
import { clearResolvedAuctions, useAuctionFeed, type AuctionRecord } from "@/lib/chain/auctionFeed";
import { useAuctionParams } from "@/lib/chain/auctionParams";
import { discountBpsAt, fmtBps, signedAusd, type ChainAuctionParams } from "@/lib/chain/fair";
import { fairAbi } from "@/lib/chain/fairAbi";
import { ausdToNumber } from "@/lib/chain/units";
import { takeOnChain } from "@/lib/chain/fairActions";
import type { RecordedXray } from "@/lib/chain/xray.server";
import { checkKeeper } from "@/lib/chain/runtime";
import { refreshAccount } from "@/lib/chain/trading";
import { trackExternalTx } from "@/lib/chain/txs";
import { Notice, TxLink } from "@/components/chain/ChainUi";
import { fmtAusd } from "@/components/trade/format";
import { AuctionLanes } from "./AuctionLanes";
import { AuctionMetrics } from "./AuctionMetrics";
import { LiveResultCard } from "./LiveResultCard";
import { XrayPanel, type XraySource } from "./XrayPanel";
import { fmtCompact, fmtMark } from "./format";
import styles from "./ClearingScreen.module.css";

type Phase = "idle" | "submitting" | "running" | "done" | "failed";
type XrayState = "idle" | "pending" | "ready" | "none" | "error";

const CRASH_BPS = 8000; // price × 0.8 = −20%
const POLL_MS = 400;
const RUN_TIMEOUT_MS = 180_000;
const XRAY_POLL_MS = 2_500;
const XRAY_TIMEOUT_MS = 180_000;
const EMPTY_SET = new Set<string>();
const ZERO_COUNTS = Array.from({ length: LANE_COUNT }, () => 0);
/** getLiquidatableAccounts is a heavy view (health of every account); poll it sparingly. */
const RISK_EVERY_MS = 8_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function LiveClearing({
  active,
  onUseSimulated,
  recordedXray,
}: {
  active: boolean;
  onUseSimulated: () => void;
  recordedXray: RecordedXray | null;
}) {
  const status = useParaclr((s) => s.chain.status);
  const reason = useParaclr((s) => s.chain.reason);
  const clearinghouse = useParaclr((s) => s.chain.contracts?.clearinghouse ?? null);
  const keeperStatus = useParaclr((s) => s.chain.keeper.status);
  const keeperError = useParaclr((s) => s.chain.keeper.error);
  const keeperCrashed = useParaclr((s) => s.chain.keeper.health?.crashed ?? false);
  const me = useParaclr((s) => s.session?.address?.toLowerCase() ?? null);

  const [lanes, setLanes] = useState<LaneStat[] | null>(null);
  const [laneAccounts, setLaneAccounts] = useState<string[][]>(() => Array.from({ length: LANE_COUNT }, () => []));
  const [risk, setRisk] = useState<Set<string>>(EMPTY_SET);
  const [readError, setReadError] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [report, setReport] = useState<RunReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [recoverTx, setRecoverTx] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);

  const [xray, setXray] = useState<XrayReport | null>(null);
  const [xrayState, setXrayState] = useState<XrayState>("idle");
  const [xrayError, setXrayError] = useState<string | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const live = status === "ready" && clearinghouse !== null;
  const busy = phase === "submitting" || phase === "running";
  // Keep the feed while a run is on screen even if the tab is hidden, so its
  // outcomes are never lost.
  const feed = useAuctionFeed(live && (active || phase !== "idle"));
  const params = useAuctionParams();
  const memoCounts = useMemo(() => (lanes ? lanes.map((l) => l.accountCount) : ZERO_COUNTS), [lanes]);

  // Lane stats + account list + "liquidatable now", refreshed on new blocks
  // while this view is visible and no run is in progress.
  const knownTotal = useRef(-1);
  useEffect(() => {
    if (!live || !active || busy || !clearinghouse) return;
    let cancelled = false;
    let riskAt = 0;
    const load = coalesce(async () => {
      try {
        const stats = await readLanes(clearinghouse);
        if (cancelled) return;
        setLanes(stats);
        setReadError(null);
        const counts = stats.map((s) => s.accountCount);
        const total = counts.reduce((a, b) => a + b, 0);
        if (total !== knownTotal.current) {
          const accts = await readLaneAccounts(clearinghouse, counts);
          if (cancelled) return;
          knownTotal.current = total;
          setLaneAccounts(accts);
        }
        if (Date.now() - riskAt > RISK_EVERY_MS) {
          riskAt = Date.now();
          const liq = await readLiquidatable(clearinghouse, counts).catch(() => null);
          if (!cancelled && liq) setRisk(liq);
        }
      } catch (e) {
        if (!cancelled) setReadError(readableError(e));
      }
    }, 2_500);
    const off = subscribeBlocks(() => load());
    return () => {
      cancelled = true;
      off();
    };
  }, [live, active, busy, clearinghouse, refreshKey]);

  // Accounts in this run: from the feed (live events), completed with the
  // keeper's per-account report for any the feed didn't see.
  const shockBlock = report?.shock.block ?? null;
  const records = useMemo(() => {
    const base = feed.records;
    if (shockBlock === null) return base;
    const out = new Map<string, AuctionRecord>();
    for (const [k, r] of base) if (r.status === "active" || r.startBlock >= shockBlock) out.set(k, r);
    for (const p of report?.underwater?.perAccount ?? []) {
      if (out.has(p.account)) continue;
      out.set(p.account, {
        account: p.account,
        lane: p.lane,
        startBlock: p.fromBlock,
        equity: null,
        notional: null,
        status: p.outcome,
        resolvedBlock: p.toBlock,
        discountBps: null,
        taker: null,
        traderResidual: null,
        payment: null,
        badDebt: 0,
        txHash: null,
      });
    }
    return out;
  }, [feed.records, shockBlock, report]);

  // Replay: step a cursor block by block at the measured block cadence.
  const replayTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  useEffect(() => () => clearInterval(replayTimer.current), []);

  if (!NETWORK) return null;

  if (status !== "ready") {
    return (
      <div className={styles.body}>
        {status === "connecting" ? (
          <Notice>Connecting to {NETWORK.label}…</Notice>
        ) : (
          <Notice tone="warn">
            Live mode unavailable: {reason ?? "chain not connected."}{" "}
            <button className={styles.inlineLink} onClick={onUseSimulated}>
              Use the simulation
            </button>
          </Notice>
        )}
      </div>
    );
  }

  const counts = memoCounts;
  const totalAccounts = counts.reduce((a, b) => a + b, 0);
  const insurance = lanes?.reduce((s, l) => s + l.insuranceFund, 0) ?? null;
  const badDebt = lanes?.reduce((s, l) => s + l.badDebt, 0) ?? 0;
  const keeperOk = keeperStatus === "online";
  const netName = NETWORK.isMonad ? "Monad testnet" : "local anvil";
  const unsupported = feed.status === "unsupported";
  let inAuction = 0;
  for (const r of feed.records.values()) if (r.status === "active") inAuction++;

  function stopReplay() {
    clearInterval(replayTimer.current);
    setCursor(null);
  }

  async function pollXray(runId: string) {
    setXrayState("pending");
    setXrayError(null);
    const started = Date.now();
    while (alive.current && Date.now() - started < XRAY_TIMEOUT_MS) {
      try {
        const x = await keeperApi.xray(runId);
        if (!alive.current) return;
        if (x) {
          setXray(x);
          setXrayState("ready");
          return;
        }
        // Not ready: is the run still going to produce one?
        const r = await keeperApi.run(runId).catch(() => null);
        if (r && alive.current) {
          setReport(r);
          if (r.xrayError) {
            setXrayState("none");
            setXrayError(`The keeper couldn't produce the X-ray for this run: ${r.xrayError}`);
            return;
          }
        }
      } catch (e) {
        if (!alive.current) return;
        setXrayError(readableError(e));
      }
      await sleep(XRAY_POLL_MS);
    }
    if (alive.current) {
      setXrayState("none");
      setXrayError("The keeper didn't publish a Conflict X-ray for this run (it may be disabled, or the RPC lacks the tracing it needs).");
    }
  }

  async function crash() {
    stopReplay();
    setError(null);
    setReport(null);
    setRecoverTx(null);
    setXray(null);
    setXrayState("idle");
    clearResolvedAuctions();
    setPhase("submitting");
    try {
      const { runId } = await keeperApi.crash(CRASH_BPS);
      if (!alive.current) return;
      setPhase("running");
      const started = Date.now();
      let misses = 0;
      while (alive.current) {
        await sleep(POLL_MS);
        let r: RunReport;
        try {
          r = await keeperApi.run(runId);
          misses = 0;
        } catch (e) {
          if (++misses >= 5) throw e;
          continue;
        }
        if (!alive.current) return;
        setReport(r);
        if (r.status === "done" || r.status === "failed") {
          if (r.status === "failed") setError(r.error ?? "The keeper reported the run as failed.");
          setPhase(r.status === "done" || r.batches.length > 0 ? "done" : "failed");
          setRefreshKey((n) => n + 1);
          knownTotal.current = -1;
          void refreshAccount();
          void checkKeeper();
          if (r.status === "done") void pollXray(runId);
          return;
        }
        if (Date.now() - started > RUN_TIMEOUT_MS) {
          setError("Timed out waiting for the keeper run to finish.");
          setPhase("failed");
          return;
        }
      }
    } catch (e) {
      if (!alive.current) return;
      setError(readableError(e));
      setPhase("failed");
    }
  }

  async function recover() {
    stopReplay();
    setRecovering(true);
    setError(null);
    try {
      const r = await keeperApi.recover();
      if (r.txHash) {
        setRecoverTx(r.txHash);
        await trackExternalTx("Keeper: restore pre-crash oracle prices", r.txHash);
      }
      if (!alive.current) return;
      setPhase("idle");
      setReport(null);
      setRisk(EMPTY_SET);
      clearResolvedAuctions();
      setRefreshKey((n) => n + 1);
      void refreshAccount();
      await checkKeeper();
    } catch (e) {
      if (alive.current) setError(readableError(e));
    } finally {
      if (alive.current) setRecovering(false);
    }
  }

  function replay() {
    const list = [...records.values()];
    if (list.length === 0) return;
    const from = Math.min(shockBlock ?? Infinity, ...list.map((r) => r.startBlock)) - 1;
    const to = Math.max(...list.map((r) => r.resolvedBlock ?? feed.block ?? r.startBlock));
    // Measured cadence: keeper-reported, else the cadence this browser observed.
    const u = report?.underwater;
    let interval = u && u.maxBlocks > 0 && u.maxMs > 0 ? u.maxMs / u.maxBlocks : 0;
    if (!interval) {
      const seen = [...feed.blockSeenAt.entries()].sort((a, b) => a[0] - b[0]);
      if (seen.length > 2) interval = (seen[seen.length - 1][1] - seen[0][1]) / (seen[seen.length - 1][0] - seen[0][0]);
    }
    interval = Math.max(180, Math.min(1_500, interval || NETWORK!.pollMs));
    clearInterval(replayTimer.current);
    setCursor(from);
    let b = from;
    replayTimer.current = setInterval(() => {
      b++;
      if (b > to + 1) {
        stopReplay();
        return;
      }
      setCursor(b);
    }, interval);
  }

  const vizPhase = busy ? "running" : phase === "done" ? "done" : "idle";
  const started = report?.auctions?.started ?? null;
  let resolvedNow = 0;
  for (const r of records.values()) if (r.status !== "active") resolvedNow++;

  // X-ray to show: this session's run, else the latest recorded bench file.
  const showRecorded = !xray && xrayState === "idle" && recordedXray !== null;
  const xraySource: XraySource | null = xray
    ? { kind: "run", runId: xray.runId }
    : showRecorded
      ? { kind: "file", file: recordedXray.file, savedAt: recordedXray.savedAt }
      : null;

  return (
    <div className={styles.body} data-phase={vizPhase}>
      <div className={styles.stats}>
        <div className={styles.stat}>
          <small>Accounts</small>
          <b className="mono">{lanes ? totalAccounts : "…"}</b>
        </div>
        <div className={styles.stat}>
          <small>In auction</small>
          <b className="mono" style={{ color: inAuction > 0 ? "var(--warn)" : undefined }}>
            {feed.status === "live" ? inAuction : feed.status === "loading" || feed.status === "idle" ? "…" : "—"}
          </b>
        </div>
        {phase === "idle" ? (
          <div className={styles.stat} title="Below maintenance at the current marks and not yet in an auction (refreshed every few seconds)">
            <small>Underwater</small>
            <b className="mono" style={{ color: risk.size > 0 ? "var(--short)" : undefined }}>
              {lanes ? risk.size : "…"}
            </b>
          </div>
        ) : (
          <div className={styles.stat} title="Auctions of this run resolved so far (taken, cured or expired)">
            <small>Resolved</small>
            <b className="mono" style={{ color: resolvedNow > 0 ? "var(--accent)" : undefined }}>
              {resolvedNow}
            </b>
          </div>
        )}
        <div className={styles.stat}>
          <small>Insurance</small>
          <b className="mono">{insurance === null ? "…" : fmtCompact(insurance)}</b>
        </div>
      </div>

      <LiveMarks down={phase !== "idle" || keeperCrashed} crashed={keeperCrashed} />

      {readError && <Notice tone="warn">Couldn&apos;t read lanes: {readError}</Notice>}
      {unsupported && (
        <Notice tone="warn">
          The clearinghouse on {NETWORK.label} predates auction liquidations (no{" "}
          <span className="mono">getAuctionAccounts</span>), so there is no auction lifecycle to show. Redeploy the
          contracts — e.g. <span className="mono">npm run dev:chain -- --redeploy</span> on anvil.
        </Notice>
      )}
      {feed.status === "error" && feed.error && <Notice tone="warn">Couldn&apos;t read auction events: {feed.error}</Notice>}
      {!keeperOk && (
        <Notice tone="warn">
          {keeperError ?? "Keeper status unknown."} Lanes and auctions above are still read directly from chain.
        </Notice>
      )}
      {badDebt > 0 && (
        <Notice tone="warn">
          Lanes carry <span className="mono">{fmtCompact(badDebt)}</span> AUSD of unrepaid bad debt (repaid first
          from the next inflow to that lane).
        </Notice>
      )}

      <div className={styles.controls}>
        {phase === "idle" || phase === "failed" ? (
          keeperCrashed ? (
            <div className={styles.controlRow}>
              <button className={styles.recoverBtn} onClick={recover} disabled={recovering || !keeperOk}>
                {recovering ? "Recovering…" : "Recover market"}
              </button>
              <button className={styles.ghostBtn} onClick={crash} disabled={!keeperOk || recovering || unsupported}>
                Crash again
              </button>
            </div>
          ) : (
            <button className={styles.crashBtn} onClick={crash} disabled={!keeperOk || recovering || unsupported}>
              <span>Flash crash on {netName}</span>
              <small>
                Keeper shocks the oracle −20% in one tx · underwater accounts go to per-block auctions in their lane ·
                lane backstops take them at ≥ {fmtBps(Math.min(...params.minDiscountBps))}
              </small>
            </button>
          )
        ) : phase === "done" ? (
          <div className={styles.controlRow}>
            <button className={styles.recoverBtn} onClick={recover} disabled={recovering || !keeperOk}>
              {recovering ? "Recovering…" : "Recover market"}
            </button>
            <button className={styles.ghostBtn} onClick={cursor === null ? replay : stopReplay} disabled={recovering}>
              {cursor === null ? "Replay" : "Stop"}
            </button>
          </div>
        ) : (
          <button className={styles.crashBtn} disabled>
            <span>{phase === "submitting" ? "Starting run…" : "Auctions running on chain…"}</span>
            <small>
              The keeper&apos;s sweeper starts, takes and expires auctions every block · polling the run every {POLL_MS}{" "}
              ms
            </small>
          </button>
        )}
      </div>

      {busy && (
        <div className={styles.progress} aria-live="polite">
          <span>
            Oracle shock:{" "}
            {report?.shock.txHash && report.shock.txHash !== "0x" ? (
              <>
                <TxLink hash={report.shock.txHash} />{" "}
                {shockBlock !== null ? (
                  <>
                    → block <b className="mono">#{shockBlock}</b>
                  </>
                ) : (
                  "pending…"
                )}
              </>
            ) : (
              "submitting…"
            )}
          </span>
          <span>
            Auctions: <b className="mono">{inAuction}</b> running · <b className="mono">{resolvedNow}</b> resolved
            {started !== null && (
              <>
                {" "}
                of <b className="mono">{started}</b> started
              </>
            )}
          </span>
        </div>
      )}

      {error && <Notice tone="error">{error}</Notice>}
      {recoverTx && phase === "idle" && (
        <Notice tone="ok">
          Prices restored by the keeper · <TxLink hash={recoverTx} />
        </Notice>
      )}

      <AuctionLanes
        laneAccounts={laneAccounts}
        laneCounts={counts}
        risk={risk}
        records={records}
        block={cursor ?? feed.block}
        shockBlock={shockBlock}
        params={params}
        me={me}
        demoTakers={report?.auctions?.externalTakers?.demo ?? false}
        replaying={cursor !== null}
        phase={vizPhase}
      />

      <TakeList records={feed.records} block={feed.block} params={params} />

      {report && phase === "done" && <AuctionMetrics report={report} laneBadDebt={lanes ? badDebt : null} />}
      {report && phase === "done" && <LiveResultCard report={report} records={records} me={me} />}

      {(xraySource || xrayState !== "idle") && (
        <XrayPanel
          xray={xray ?? (showRecorded ? recordedXray.report : null)}
          source={xraySource}
          pending={xrayState === "pending"}
          error={xrayState === "none" || xrayState === "error" ? xrayError : null}
        />
      )}

      {phase === "idle" && (
        <p className={styles.note}>
          {lanes ? `${totalAccounts} accounts` : "Accounts"} on the clearinghouse on {NETWORK.label}, each in lane{" "}
          <span className="mono">address % 8</span>. An account below maintenance margin is frozen and put into a
          per-block Dutch auction in its lane: the discount starts at 0 and rises {fmtBps(params.stepBps)} per block (max{" "}
          {fmtBps(params.maxDiscountBps)}), so the price is set by the block clock, not by
          gas bidding. The lane&apos;s backstop pool takes the account once the discount reaches its minimum and the
          trader keeps the rest of their equity; a top-up cures it; with no taker at the max it expires and closes at
          mark. The keeper&apos;s sweeper drives all {LANE_COUNT} lanes concurrently from {LANE_COUNT} keeper wallets —
          and anyone may call the same functions.
        </p>
      )}
    </div>
  );
}

/** Oracle marks row; subscribes to prices itself so ticks don't re-render the lanes. */
function LiveMarks({ down, crashed }: { down: boolean; crashed: boolean }) {
  const prices = useParaclr((s) => s.prices);
  return (
    <div className={styles.marks}>
      {MARKETS.map((m) => {
        const p = prices[m]?.price;
        return (
          <span key={m} className="mono" data-down={down ? "" : undefined}>
            {m.split("/")[0]} {p != null ? fmtMark(p) : "—"}
          </span>
        );
      })}
      <span className={styles.marksSource}>on-chain marks</span>
      {crashed && <span className={styles.marksShock}>crashed</span>}
    </div>
  );
}

/**
 * External takers: auctions running in the signed-in account's own lane (the
 * contract only lets a same-lane account take, so every write stays
 * lane-local). The taker inherits the positions at the mark and earns up to
 * discount × notional, capped at the trader's equity (min(P, max(E, 0)) — the
 * lane never subsidises an external taker), and must stay above initial margin.
 */
function TakeList({
  records,
  block,
  params,
}: {
  records: ReadonlyMap<string, AuctionRecord>;
  block: number | null;
  params: ChainAuctionParams;
}) {
  const acct = useParaclr((s) => s.chain.account);
  const walletReady = useParaclr((s) => s.chain.wallet.ready);
  const clearinghouse = useParaclr((s) => s.chain.contracts?.clearinghouse ?? null);
  const me = useParaclr((s) => s.session?.address?.toLowerCase() ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [health, setHealth] = useState<Map<string, { equity: number; notional: number }>>(() => new Map());

  const lane = acct?.lane ?? null;
  const mine = useMemo(
    () =>
      lane === null
        ? []
        : [...records.values()].filter((r) => r.status === "active" && r.lane === lane && r.account !== me).slice(0, 6),
    [records, lane, me],
  );
  const key = mine.map((r) => r.account).join(",");

  // Current equity / notional of each listed auction (the payment cap), per block.
  useEffect(() => {
    if (!clearinghouse || !key) return;
    let cancelled = false;
    const accounts = key.split(",");
    readMany({
      contracts: accounts.map((a) => ({
        address: clearinghouse,
        abi: fairAbi,
        functionName: "accountHealth" as const,
        args: [a as Address] as const,
      })),
    })
      .then((res) => {
        if (cancelled) return;
        const next = new Map<string, { equity: number; notional: number }>();
        res.forEach((r, i) => {
          if (r.status !== "success") return;
          const [eq, , , n] = r.result;
          next.set(accounts[i], { equity: signedAusd(eq), notional: ausdToNumber(n) });
        });
        setHealth(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [clearinghouse, key, block]);

  // The contract rejects a taker that is itself in auction.
  if (!acct || !me || block === null || acct.auction?.active) return null;
  if (mine.length === 0 && !msg) return null;
  const total = [...records.values()].filter((r) => r.status === "active" && r.lane === acct.lane && r.account !== me).length;

  const take = async (account: string) => {
    setBusy(account);
    setMsg(null);
    try {
      const r = await takeOnChain(account as Address);
      setMsg({
        tone: "ok",
        text: `Took ${account.slice(0, 6)}…${account.slice(-4)} in block #${r.block}${r.payment !== null ? ` · you earned ${fmtAusd(r.payment)} AUSD` : ""}. Its positions are now yours, entered at the mark.`,
      });
    } catch (e) {
      setMsg({ tone: "error", text: readableError(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={styles.takeList} aria-label="Auctions in your lane">
      <header>
        <b>Auctions in your lane (lane {acct.lane + 1})</b>
        <span>
          Take one to inherit its positions at the mark. You earn up to the current discount × notional, capped at the
          trader&apos;s remaining equity (the lane never pays an external taker). Same-lane only; you must stay above
          initial margin afterwards.
        </span>
      </header>
      {mine.map((r) => {
        const d = discountBpsAt(r.startBlock, block, params);
        const h = health.get(r.account);
        const notional = h?.notional ?? r.notional;
        const full = notional !== null ? (d / 10_000) * notional : null;
        const pay = full !== null && h ? Math.min(full, Math.max(0, h.equity)) : full;
        const capped = full !== null && pay !== null && pay < full - 0.005;
        return (
          <div key={r.account} className={styles.takeRow}>
            <span className="mono">
              {r.account.slice(0, 6)}…{r.account.slice(-4)}
            </span>
            <span className="mono">{fmtBps(d)}</span>
            <span
              className="mono"
              title={capped ? `Discount × notional = ${fmtAusd(full ?? 0)}, capped at the trader's equity` : undefined}
            >
              {notional !== null ? `${fmtCompact(notional)} notional` : "—"}
              {pay !== null && (
                <>
                  {" "}
                  · you earn {fmtAusd(pay)}
                  {capped ? " (capped at equity)" : ""}
                </>
              )}
            </span>
            <button type="button" disabled={busy !== null || !walletReady} onClick={() => take(r.account)}>
              {busy === r.account ? "Taking…" : "Take"}
            </button>
          </div>
        );
      })}
      {total > mine.length && <small>+{total - mine.length} more</small>}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </section>
  );
}
