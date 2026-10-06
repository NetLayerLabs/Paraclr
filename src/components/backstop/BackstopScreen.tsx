"use client";

// Backstop tab: one LP pool per lane. Pools take underwater accounts in their
// lane once the auction discount reaches the pool's minimum, inheriting the
// positions at the oracle mark. Every number is read from the clearinghouse
// (backstopNav / backstopStats / backstopPositions / backstopSharesOf).
// Returns are "earned since deploy" — never annualised.

import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { useParaclr } from "@/lib/store";
import { LANE_COUNT, type MarketSymbol } from "@/lib/types";
import { CHAIN_MODE_ON, NETWORK } from "@/lib/chain/config";
import { coalesce, subscribeBlocks } from "@/lib/chain/clients";
import { readableError } from "@/lib/chain/errors";
import { useAuctionParams } from "@/lib/chain/auctionParams";
import { fmtBps, isMissingFunction, readBackstopPools, type BackstopPool } from "@/lib/chain/fair";
import { backstopDepositOnChain, backstopWithdrawOnChain } from "@/lib/chain/fairActions";
import { NetworkTag, Notice, TxTray } from "@/components/chain/ChainUi";
import { MQ_TABLE, useMedia } from "@/components/shell/useMedia";
import { baseOf, fmtAusd, fmtCompact, fmtSigned, fmtSize } from "@/components/trade/format";
import styles from "./BackstopScreen.module.css";

type LoadState = "loading" | "ready" | "unsupported" | "error";

export function BackstopScreen({ active = true }: { active?: boolean }) {
  const live = useParaclr((s) => s.chain.status === "ready");
  if (!CHAIN_MODE_ON || !live) return <BackstopUnavailable />;
  return <LiveBackstop active={active} />;
}

function Header({ simulated = false }: { simulated?: boolean }) {
  return (
    <header className={styles.head}>
      <div>
        <h1 className={styles.title}>Backstop pools</h1>
        <p className={styles.subtitle}>
          One LP pool per lane takes over underwater accounts at the auction discount · returns shown since deploy,
          never annualised
        </p>
      </div>
      <NetworkTag simulated={simulated} />
    </header>
  );
}

function BackstopUnavailable() {
  const status = useParaclr((s) => s.chain.status);
  return (
    <div className={styles.screen}>
      <Header simulated />
      <Notice tone={status === "connecting" ? "info" : "warn"}>
        {status === "connecting"
          ? `Connecting to ${NETWORK?.label ?? "the chain"}…`
          : "Backstop pools are on-chain contracts and this session is running the in-browser simulation, so there is nothing to deposit into here. Run the app against a chain (NEXT_PUBLIC_CHAIN_MODE=anvil with `npm run dev:chain`, or monad) to use them."}
      </Notice>
      <Explainer />
    </div>
  );
}

function LiveBackstop({ active }: { active: boolean }) {
  const contracts = useParaclr((s) => s.chain.contracts);
  const me = useParaclr((s) => (s.session?.address as Address | undefined) ?? null);
  const myLane = useParaclr((s) => s.chain.account?.lane ?? null);
  const block = useParaclr((s) => s.chain.block);
  const [pools, setPools] = useState<BackstopPool[] | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [lane, setLane] = useState<number | null>(null);
  const [refresh, setRefresh] = useState(0);
  const wide = useMedia(MQ_TABLE);

  useEffect(() => {
    if (!active || !contracts) return;
    let cancelled = false;
    const load = coalesce(async () => {
      try {
        const p = await readBackstopPools(contracts.clearinghouse, contracts.markets, me);
        if (cancelled) return;
        setPools(p);
        setState("ready");
        setError(null);
        setReadAt(Date.now());
      } catch (e) {
        if (cancelled) return;
        if (isMissingFunction(e)) setState("unsupported");
        else {
          setError(readableError(e));
          setState((s) => (s === "ready" ? s : "error"));
        }
      }
    }, 2_000);
    const off = subscribeBlocks(() => load());
    return () => {
      cancelled = true;
      off();
    };
  }, [active, contracts, me, refresh]);

  const selected = lane ?? myLane ?? 0;
  const totals = useMemo(() => {
    if (!pools) return null;
    return pools.reduce(
      (a, p) => ({
        nav: a.nav + p.equity,
        earned: a.earned + p.discountEarned,
        taken: a.taken + p.taken,
        absorbed: a.absorbed + p.notionalAbsorbed,
        mine: a.mine + p.myValue,
      }),
      { nav: 0, earned: 0, taken: 0, absorbed: 0, mine: 0 },
    );
  }, [pools]);

  if (state === "unsupported") {
    return (
      <div className={styles.screen}>
        <Header />
        <Notice tone="warn">
          The clearinghouse deployed on {NETWORK?.label} predates backstop pools (it has no{" "}
          <span className="mono">backstopNav</span>). Redeploy the contracts — e.g.{" "}
          <span className="mono">npm run dev:chain -- --redeploy</span> on anvil.
        </Notice>
        <Explainer />
      </div>
    );
  }

  return (
    <div className={styles.screen}>
      <Header />

      <div className={styles.stats}>
        <div className={styles.stat}>
          <small>Total NAV · AUSD</small>
          <b className="mono">{totals ? fmtCompact(totals.nav) : "…"}</b>
        </div>
        <div className={styles.stat}>
          <small>Discount earned · since deploy</small>
          <b className="mono" style={{ color: totals && totals.earned > 0 ? "var(--long)" : undefined }}>
            {totals ? fmtCompact(totals.earned) : "…"}
          </b>
        </div>
        <div className={styles.stat}>
          <small>Accounts taken</small>
          <b className="mono">{totals ? totals.taken : "…"}</b>
        </div>
        <div className={styles.stat}>
          <small>Notional absorbed</small>
          <b className="mono">{totals ? fmtCompact(totals.absorbed) : "…"}</b>
        </div>
      </div>

      {error && <Notice tone="warn">Couldn&apos;t read the pools: {error}</Notice>}

      <div className={styles.grid}>
        <section className={styles.pools} aria-label="Pools by lane">
          <header className={styles.poolsHead}>
            <h2>Pools by lane</h2>
            <span className="mono" title="Read from the clearinghouse">
              {block !== null && readAt ? `on-chain · #${block}` : "on-chain"}
            </span>
          </header>
          {!pools ? (
            <p className={styles.empty}>{state === "error" ? "—" : "Reading pools…"}</p>
          ) : wide ? (
            <PoolTable pools={pools} selected={selected} myLane={myLane} onSelect={setLane} />
          ) : (
            <PoolCards pools={pools} selected={selected} myLane={myLane} onSelect={setLane} />
          )}
        </section>

        <aside className={styles.side} aria-label="Deposit or withdraw">
          <PoolActions
            pool={pools?.[selected] ?? null}
            lane={selected}
            myLane={myLane}
            onLane={setLane}
            onDone={() => setRefresh((n) => n + 1)}
          />
          <TxTray />
          <Explainer compact />
        </aside>
      </div>
    </div>
  );
}

// ---- pools: table (>=720px) and cards (phones) ------------------------------------

function usePrices() {
  return useParaclr((s) => s.prices);
}

function Exposure({ pool }: { pool: BackstopPool }) {
  const prices = usePrices();
  if (pool.exposure.length === 0) return <span className={styles.dim}>none</span>;
  return (
    <span className={styles.exposure}>
      {pool.exposure.map((x) => {
        const sym = x.symbol as MarketSymbol | null;
        const mark = sym ? (prices[sym]?.price ?? x.entry) : x.entry;
        const notional = Math.abs(x.size) * mark;
        return (
          <span
            key={x.marketId}
            className="mono"
            data-side={x.size > 0 ? "long" : "short"}
            title={`${x.size > 0 ? "Long" : "Short"} ${Math.abs(x.size)} ${sym ?? x.marketId} inherited at avg entry ${x.entry}`}
          >
            {x.size > 0 ? "L" : "S"} {sym ? `${fmtSize(sym, Math.abs(x.size))} ${baseOf(sym)}` : "?"}
            <small> ≈{fmtCompact(notional)}</small>
          </span>
        );
      })}
    </span>
  );
}

function PoolTable({
  pools,
  selected,
  myLane,
  onSelect,
}: {
  pools: BackstopPool[];
  selected: number;
  myLane: number | null;
  onSelect: (l: number) => void;
}) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Lane</th>
            <th className={styles.num}>NAV</th>
            <th className={styles.num} title="NAV per share">
              Share price
            </th>
            <th className={styles.num} title="Auction discounts received since deploy — not annualised">
              Earned since deploy
            </th>
            <th className={styles.num}>Taken</th>
            <th className={styles.num}>Absorbed</th>
            <th>Inherited exposure</th>
            <th className={styles.num}>Your stake</th>
          </tr>
        </thead>
        <tbody>
          {pools.map((p) => (
            <tr
              key={p.lane}
              data-selected={p.lane === selected ? "" : undefined}
              onClick={() => onSelect(p.lane)}
              title={`Select lane ${p.lane + 1}`}
            >
              <td>
                <span className={styles.laneCell}>
                  Lane {p.lane + 1}
                  {p.lane === myLane && <span className={styles.youTag}>your lane</span>}
                </span>
              </td>
              <td className={`mono ${styles.num}`}>
                {fmtAusd(p.equity)}
                {p.unrealizedPnl !== 0 && (
                  <small className={p.unrealizedPnl > 0 ? styles.up : styles.down}> {fmtSigned(p.unrealizedPnl)}</small>
                )}
              </td>
              <td className={`mono ${styles.num}`}>{p.sharePrice === null ? "—" : p.sharePrice.toFixed(4)}</td>
              <td className={`mono ${styles.num}`} style={{ color: p.discountEarned > 0 ? "var(--long)" : undefined }}>
                {fmtAusd(p.discountEarned)}
              </td>
              <td className={`mono ${styles.num}`}>{p.taken}</td>
              <td className={`mono ${styles.num}`}>{fmtCompact(p.notionalAbsorbed)}</td>
              <td>
                <Exposure pool={p} />
              </td>
              <td className={`mono ${styles.num}`}>{p.myShares > 0 ? fmtAusd(p.myValue) : <span className={styles.dim}>—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PoolCards({
  pools,
  selected,
  myLane,
  onSelect,
}: {
  pools: BackstopPool[];
  selected: number;
  myLane: number | null;
  onSelect: (l: number) => void;
}) {
  return (
    <div className={styles.cards}>
      {pools.map((p) => (
        <button
          type="button"
          key={p.lane}
          className={styles.card}
          data-selected={p.lane === selected ? "" : undefined}
          onClick={() => onSelect(p.lane)}
        >
          <span className={styles.cardTop}>
            <b>
              Lane {p.lane + 1}
              {p.lane === myLane && <span className={styles.youTag}>your lane</span>}
            </b>
            <span className="mono">{fmtAusd(p.equity)} AUSD</span>
          </span>
          <span className={styles.cardGrid}>
            <span>
              <small>Share price</small>
              <span className="mono">{p.sharePrice === null ? "—" : p.sharePrice.toFixed(4)}</span>
            </span>
            <span>
              <small>Earned since deploy</small>
              <span className="mono" style={{ color: p.discountEarned > 0 ? "var(--long)" : undefined }}>
                {fmtAusd(p.discountEarned)}
              </span>
            </span>
            <span>
              <small>Taken · absorbed</small>
              <span className="mono">
                {p.taken} · {fmtCompact(p.notionalAbsorbed)}
              </span>
            </span>
          </span>
          <span className={styles.cardExposure}>
            <small>Inherited</small>
            <Exposure pool={p} />
          </span>
          {p.myShares > 0 && (
            <span className={styles.cardMine}>
              Your stake <span className="mono">{fmtAusd(p.myValue)} AUSD</span>
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

// ---- deposit / withdraw ------------------------------------------------------------

const DEPOSIT_QUICK = [100, 1_000, 5_000];
const WITHDRAW_QUICK = [
  { label: "25%", f: 0.25 },
  { label: "50%", f: 0.5 },
  { label: "All", f: 1 },
];

function PoolActions({
  pool,
  lane,
  myLane,
  onLane,
  onDone,
}: {
  pool: BackstopPool | null;
  lane: number;
  myLane: number | null;
  onLane: (l: number) => void;
  onDone: () => void;
}) {
  const acct = useParaclr((s) => s.chain.account);
  const walletReady = useParaclr((s) => s.chain.wallet.ready);
  const params = useAuctionParams();
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [amountStr, setAmountStr] = useState("1000");
  const [pct, setPct] = useState(1);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const wallet = acct?.walletAusd ?? 0;
  const amount = Number.parseFloat(amountStr) || 0;
  const estShares = pool?.sharePrice ? amount / pool.sharePrice : amount;
  const withdrawShares = pool ? (pool.mySharesUnits * BigInt(Math.round(pct * 10_000))) / BigInt(10_000) : BigInt(0);
  const withdrawAusd = pool ? pool.myValue * pct : 0;

  const depositReason = !walletReady
    ? "Connecting wallet…"
    : !acct
      ? "Reading account…"
      : acct.native <= 0
        ? "No gas — get test funds on the Wallet tab"
        : amount <= 0
          ? "Enter an amount"
          : amount > wallet + 1e-9
            ? "Not enough AUSD in your wallet"
            : null;
  const withdrawReason = !walletReady
    ? "Connecting wallet…"
    : !pool || pool.myShares <= 0
      ? "You have no shares in this pool"
      : null;

  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (mode === "deposit") {
        const r = await backstopDepositOnChain(lane, amount);
        setMsg({ tone: "ok", text: `Deposited ${fmtAusd(amount)} AUSD into the lane ${lane + 1} backstop (block #${r.block}).` });
      } else {
        const r = await backstopWithdrawOnChain(lane, withdrawShares, withdrawAusd);
        setMsg({
          tone: "ok",
          text: `Withdrew ${fmtAusd(r.amount ?? withdrawAusd)} AUSD from the lane ${lane + 1} backstop (block #${r.block}).`,
        });
      }
      onDone();
    } catch (e) {
      setMsg({ tone: "error", text: readableError(e) });
    } finally {
      setBusy(false);
    }
  };

  const reason = mode === "deposit" ? depositReason : withdrawReason;

  return (
    <section className={styles.panel}>
      <div className={styles.modeToggle} role="tablist" aria-label="Deposit or withdraw">
        {(["deposit", "withdraw"] as const).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            className={mode === m ? styles.modeOn : styles.modeBtn}
            onClick={() => {
              setMode(m);
              setMsg(null);
            }}
          >
            {m === "deposit" ? "Deposit" : "Withdraw"}
          </button>
        ))}
      </div>

      <div className={styles.fieldHead}>
        <span className={styles.label}>Lane</span>
        {pool && (
          <span className={styles.hint}>
            NAV <span className="mono">{fmtCompact(pool.equity)}</span> · share{" "}
            <span className="mono">{pool.sharePrice === null ? "—" : pool.sharePrice.toFixed(4)}</span>
          </span>
        )}
      </div>
      <div className={styles.laneChips} role="radiogroup" aria-label="Lane">
        {Array.from({ length: LANE_COUNT }, (_, l) => (
          <button
            key={l}
            role="radio"
            aria-checked={l === lane}
            className={l === lane ? styles.laneChipOn : styles.laneChip}
            onClick={() => onLane(l)}
            title={l === myLane ? "Your trading account's lane" : undefined}
          >
            {l + 1}
            {l === myLane && <i aria-hidden />}
          </button>
        ))}
      </div>

      {mode === "deposit" ? (
        <>
          <div className={styles.fieldHead}>
            <span className={styles.label}>Amount</span>
            <span className={styles.hint}>
              Wallet <span className="mono">{acct ? fmtAusd(wallet) : "…"}</span> AUSD
            </span>
          </div>
          <label className={styles.inputWrap}>
            <input
              className={`mono ${styles.input}`}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value.replace(/,/g, ".").replace(/[^\d.]/g, ""))}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Deposit amount in AUSD"
            />
            <span className={styles.token}>AUSD</span>
          </label>
          <div className={styles.chips}>
            {DEPOSIT_QUICK.map((q) => (
              <button key={q} type="button" className={styles.chip} onClick={() => setAmountStr(String(q))}>
                {q.toLocaleString("en-US")}
              </button>
            ))}
            <button
              type="button"
              className={styles.chip}
              onClick={() => setAmountStr(String(Math.floor(wallet * 100) / 100))}
              disabled={wallet <= 0}
            >
              Max
            </button>
          </div>
          <dl className={styles.summary}>
            <div>
              <dt>≈ Shares minted</dt>
              <dd className="mono">{amount > 0 ? fmtAusd(estShares, 4) : "—"}</dd>
            </div>
            <div>
              <dt>Takes accounts at</dt>
              <dd className="mono">≥ {fmtBps(params.minDiscountBps[lane] ?? params.minDiscountBps[0])} discount</dd>
            </div>
          </dl>
        </>
      ) : (
        <>
          <div className={styles.fieldHead}>
            <span className={styles.label}>Your stake</span>
            <span className={styles.hint}>
              <span className="mono">{pool ? fmtAusd(pool.myShares, 4) : "…"}</span> shares
            </span>
          </div>
          <div className={styles.stake}>
            <span className="mono">{pool ? fmtAusd(pool.myValue) : "…"}</span> AUSD at the current NAV
          </div>
          <div className={styles.chips}>
            {WITHDRAW_QUICK.map((q) => (
              <button
                key={q.label}
                type="button"
                className={pct === q.f ? `${styles.chip} ${styles.chipOn}` : styles.chip}
                onClick={() => setPct(q.f)}
              >
                {q.label}
              </button>
            ))}
          </div>
          <dl className={styles.summary}>
            <div>
              <dt>≈ You receive</dt>
              <dd className="mono">{fmtAusd(withdrawAusd)} AUSD</dd>
            </div>
          </dl>
          <p className={styles.fine}>
            Paid from pool cash at the current NAV. The contract blocks a withdrawal that would leave the pool below
            10% of its inherited exposure, or that exceeds its cash.
          </p>
        </>
      )}

      <button type="button" className={styles.submit} disabled={busy || reason !== null} onClick={run}>
        {busy
          ? "Confirming on chain…"
          : (reason ??
            (mode === "deposit"
              ? `Deposit ${fmtAusd(amount)} AUSD to lane ${lane + 1}`
              : `Withdraw ≈${fmtAusd(withdrawAusd)} AUSD`))}
      </button>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </section>
  );
}

function Explainer({ compact = false }: { compact?: boolean }) {
  const params = useAuctionParams();
  const step = fmtBps(params.stepBps);
  const mins = params.minDiscountBps;
  const min = mins.every((m) => m === mins[0]) ? fmtBps(mins[0]) : `${fmtBps(Math.min(...mins))}–${fmtBps(Math.max(...mins))}`;
  const max = fmtBps(params.maxDiscountBps);
  return (
    <section className={compact ? styles.explainCompact : styles.explain}>
      <h3>How a pool earns — and what it risks</h3>
      <ol>
        <li>
          An account below maintenance margin goes to a per-block Dutch auction. Its discount starts at 0 and rises{" "}
          {step} per block (max {max}) — the price is set by the block clock, not by gas bidding.
        </li>
        <li>
          Once the discount reaches the pool&apos;s minimum ({min}), the lane&apos;s pool can take the account — if it
          can carry it (pool equity must stay ≥ 10% of its exposure). It inherits the positions at the oracle mark and
          is paid the discount; the trader keeps the rest of their equity.
        </li>
        <li>
          NAV = cash + unrealised PnL of inherited positions at the mark. That exposure is real market risk until it
          is reduced, so NAV can fall as well as rise. Withdrawals are blocked if they would leave the pool below 10%
          of its exposure, or exceed its cash.
        </li>
      </ol>
      <p>Earnings are shown as discount earned since deploy — never as an annualised APY.</p>
    </section>
  );
}
