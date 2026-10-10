"use client";

// Production wallet: real balances from chain, deposit (risk acknowledgement +
// caps + exact-amount approve), withdraw with a fresh Pyth price update (its
// fee shown first), and the beta limits with their utilisation. No faucet on
// mainnet; on Monad testnet, "Get testnet AUSD" (Agora's faucet contract, plus
// the sandbox keeper's faucet in the local sandbox).

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { formatEther, type Address } from "viem";
import { signOut, useParaclr } from "@/lib/store";
import { addressUrl, NETWORK } from "@/lib/chain/config";
import { readableError } from "@/lib/chain/errors";
import {
  claimExecutionFees,
  depositBlockedByPause,
  depositProd,
  depositRefusal,
  depositRoom,
  previewWithdrawAmount,
  quoteWithdrawUpdate,
  storedPriceStatus,
  withdrawProd,
} from "@/lib/chain/prod/actions";
import { showRiskAck, useRiskAcked } from "@/lib/chain/prod/riskAck";
import type { PriceUpdate } from "@/lib/chain/prod/priceUpdate";
import { Notice, TxTray } from "@/components/chain/ChainUi";
import { useAuthContext } from "@/components/auth/AuthContext";
import { PrivySignOutButton } from "@/components/auth/PrivyAuth";
import { fmtAusd } from "@/components/trade/format";
import { GasDrip } from "./GasDrip";
import { TestnetFunds } from "./TestnetFunds";
import { TokenSymbol, useCollateral } from "./Token";
import { fmtDuration, useKeeperSigned } from "./util";
import { isPrivyMethod, METHOD_LABEL } from "@/lib/types";
import { StateLine } from "@/components/trade/TradeButton";
import styles from "./Prod.module.css";

const fmtMon = (wei: bigint | null | undefined, max = 6) =>
  wei === null || wei === undefined
    ? "-"
    : Number(formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: max });

function clean(raw: string): string {
  const c = raw.replace(/,/g, ".").replace(/[^\d.]/g, "");
  const parts = c.split(".");
  return parts.length > 1 ? `${parts[0]}.${parts.slice(1).join("").slice(0, 6)}` : c;
}

function CapBar({ label, used, cap }: { label: string; used: number | null; cap: number | null }) {
  const pct = used !== null && cap ? Math.min(1, Math.max(0, used / cap)) : 0;
  const tone = pct >= 0.999 ? "full" : pct >= 0.8 ? "warn" : undefined;
  return (
    <div className={styles.cap}>
      <div className={styles.capHead}>
        <span>{label}</span>
        <span>
          <span className="mono">{used === null ? "-" : fmtAusd(used)}</span> /{" "}
          <span className="mono">{cap === null ? "-" : fmtAusd(cap)}</span> AUSD
        </span>
      </div>
      <div className={styles.bar} data-tone={tone}>
        <span style={{ width: `${pct * 100}%` }} />
      </div>
    </div>
  );
}

export function ProdWallet() {
  const session = useParaclr((s) => s.session);
  const acct = useParaclr((s) => s.chain.account);
  const accountError = useParaclr((s) => s.chain.accountError);
  const wallet = useParaclr((s) => s.chain.wallet);
  const prod = useParaclr((s) => s.chain.prod);
  const { privyEnabled } = useAuthContext();
  const token = useCollateral();
  // Testnet after the Pyth trial: prices come from the keeper-signed fallback oracle.
  const keeperSigned = useKeeperSigned();
  const acked = useRiskAcked(session?.address);
  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [amountStr, setAmountStr] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);
  const feesOwed = useParaclr((s) => s.chain.prod?.mine?.feesOwed ?? BigInt(0));
  const [claiming, setClaiming] = useState(false);
  const claim = async () => {
    setClaiming(true);
    setMsg(null);
    try {
      await claimExecutionFees();
      setMsg({ tone: "ok", text: "Claimed your execution fees / refunds." });
    } catch (e) {
      setMsg({ tone: "error", text: readableError(e) });
    } finally {
      setClaiming(false);
    }
  };
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  // When the stored Pyth prices are too old to use directly, preview the signed
  // update a withdrawal would attach (via the keeper's /hermes proxy) and its fee.
  const [quote, setQuote] = useState<{ q: PriceUpdate | null; error: string | null }>({ q: null, error: null });
  const holds = (acct?.positions.length ?? 0) > 0;
  useEffect(() => {
    if (tab !== "withdraw" || !wallet.ready || !holds) return;
    let cancelled = false;
    const load = () =>
      quoteWithdrawUpdate().then(
        (q) => !cancelled && setQuote({ q, error: null }),
        (e) => !cancelled && setQuote({ q: null, error: readableError(e) }),
      );
    void load();
    const id = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [tab, wallet.ready, holds]);

  // Withdraw preview: while the lane has bad debt, payouts are haircut pro rata.
  const haircutBps = prod?.lane?.solvency?.haircutBps ?? 0;
  const amountNum = Number.parseFloat(amountStr) || 0;
  const [preview, setPreview] = useState<{ amount: number; paid: number } | null>(null);
  useEffect(() => {
    if (tab !== "withdraw" || haircutBps <= 0 || amountNum <= 0 || !session) return;
    let cancelled = false;
    const t = setTimeout(() => {
      previewWithdrawAmount(session.address as Address, amountNum).then(
        (paid) => !cancelled && paid !== null && setPreview({ amount: amountNum, paid }),
        () => undefined,
      );
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [tab, haircutBps, amountNum, session]);

  if (!session || !NETWORK) return null;

  const explorer = addressUrl(session.address);
  // The health check uses the Pyth prices stored on chain (the app never sends update data).
  const priced = storedPriceStatus(acct);
  const params = prod?.params ?? null;
  const room = depositRoom(acct);
  const paused = prod?.paused === true;
  const depositPaused = depositBlockedByPause(acct);
  const walletAusd = acct?.walletAusd ?? 0;
  const free = acct?.freeCollateral ?? 0;
  // Holders may also add margin beyond the caps, up to the top-up allowance.
  const maxDeposit = Math.min(walletAusd, (room.room === null ? walletAusd : room.room) + room.topUp);
  const laneDebt = prod?.lane?.solvency?.badDebt ?? 0;
  const amount = Number.parseFloat(amountStr) || 0;
  const isPasskey = isPrivyMethod(session.method);
  const testnet = NETWORK.isTestnetProd;
  const walletKind = isPasskey
    ? `${METHOD_LABEL[session.method]} · Privy`
    : testnet
      ? NETWORK.sandbox
        ? "Demo burner · local sandbox"
        : "Demo burner · testnet only"
      : "Rehearsal burner (local only)";

  const depositReason = !wallet.ready
    ? (wallet.error ?? "Connecting wallet…")
    : !acct
      ? "Reading account…"
      : depositPaused
        ? "Deposits paused by the guardian"
        : amount <= 0
          ? "Enter an amount"
          : amount > walletAusd + 1e-9
            ? `Not enough ${token.symbol} in your wallet`
            : depositRefusal(acct, amount)
              ? depositRefusal(acct, amount)
              : acct.native <= 0
                ? `Need ${NETWORK.nativeSymbol} for gas`
                : null;
  const withdrawReason = !wallet.ready
    ? (wallet.error ?? "Connecting wallet…")
    : !acct
      ? "Reading account…"
      : acct.auction?.active
        ? "Frozen while in a liquidation auction"
        : amount <= 0
          ? "Enter an amount"
          : amount > free + 1e-9
            ? "More than your free collateral"
            : priced.needed && quote.error
              ? "Prices are refreshing - retry in a few seconds"
              : acct.native <= 0
                ? `Need ${NETWORK.nativeSymbol} for gas`
                : null;
  const reason = tab === "deposit" ? depositReason : withdrawReason;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(session.address);
      setCopied(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked */
    }
  };

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (tab === "deposit") {
        await depositProd(amount);
        setMsg({ tone: "ok", text: `Deposited ${fmtAusd(amount)} ${token.symbol} into the clearinghouse.` });
      } else {
        const all = Math.abs(amount - free) < 0.005;
        const got = await withdrawProd(all ? "max" : amount);
        setMsg({ tone: "ok", text: `Withdrew ${fmtAusd(got)} ${token.symbol} to your wallet.` });
      }
      setAmountStr("");
    } catch (e) {
      setMsg({ tone: "error", text: readableError(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.wallet}>
      <section className={styles.card}>
        <div className={styles.cardTitle}>
          <span>Wallet · {NETWORK.label}</span>
          <span>{walletKind}</span>
        </div>
        <div className={styles.addrRow}>
          <code title={session.address}>{session.address}</code>
          <button type="button" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
          {explorer && (
            <a href={explorer} target="_blank" rel="noreferrer">
              {NETWORK.isMainnet ? "Monadscan" : "Explorer"} ↗
            </a>
          )}
        </div>
        {testnet ? (
          <p className={styles.fine}>
            Fund it with {token.testnet ? "Agora's testnet AUSD" : `the test ${token.symbol}`} and some
            {NETWORK.sandbox ? "" : " testnet"} {NETWORK.nativeSymbol} for gas and fees - test funds, no real value.
          </p>
        ) : (
          <p className={styles.fine}>
            Send {token.test ? `the test ${token.symbol}` : "Agora AUSD"} and some {NETWORK.nativeSymbol} for gas and fees
            to this address on {NETWORK.isMainnet && !NETWORK.local ? "Monad mainnet" : NETWORK.label} - there is no
            faucet.
          </p>
        )}
        <dl className={styles.kv}>
          <div>
            <dt>
              Wallet <TokenSymbol />
            </dt>
            <dd className="mono">{acct ? fmtAusd(walletAusd) : "…"}</dd>
          </div>
          <div>
            <dt>{NETWORK.nativeSymbol} for fees</dt>
            <dd className="mono" data-low={acct && acct.native < 0.05 ? "" : undefined}>
              {acct ? fmtMon(acct.nativeUnits, 4) : "…"}
            </dd>
          </div>
          <div>
            <dt>Deposited</dt>
            <dd className="mono">{acct ? fmtAusd(acct.collateral) : "…"}</dd>
          </div>
          <div data-hero="">
            <dt>Equity</dt>
            <dd className="mono">{acct?.equity != null ? fmtAusd(acct.equity) : "-"}</dd>
          </div>
          <div>
            <dt>Free to withdraw</dt>
            <dd className="mono">{acct?.freeCollateral != null ? fmtAusd(acct.freeCollateral) : "-"}</dd>
          </div>
          <div>
            <dt>Lane</dt>
            <dd className="mono">{acct ? `L${acct.lane}` : "…"}</dd>
          </div>
        </dl>
        <GasDrip address={session.address} nativeWei={acct ? acct.nativeUnits : null} />
        {feesOwed > BigInt(0) && (
          <div className={styles.row}>
            <span className={styles.fine}>
              Claimable execution fees / refunds: <span className="mono">{fmtMon(feesOwed)}</span> {NETWORK.nativeSymbol}
            </span>
            <button type="button" className={styles.btnGhost} disabled={claiming} onClick={claim}>
              {claiming ? "Claiming…" : "Claim"}
            </button>
          </div>
        )}
        {accountError && <Notice tone="warn">Couldn&apos;t read your account: {accountError}</Notice>}
        {acct?.healthError && <p className={styles.fine}>{acct.healthError}</p>}
      </section>

      {testnet && <TestnetFunds />}

      <section className={styles.card}>
        <div className={styles.tabs} role="tablist" aria-label="Deposit or withdraw">
          {(["deposit", "withdraw"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => {
                setTab(t);
                setMsg(null);
                setAmountStr("");
              }}
            >
              {t === "deposit" ? "Deposit" : "Withdraw"}
            </button>
          ))}
        </div>
        {tab === "deposit" && paused && (
          <Notice tone="warn">
            {depositPaused
              ? "Deposits are paused by the guardian. Withdrawals and closing positions still work."
              : "Paused by the guardian: you can still top up margin for your open positions, and withdraw or close."}
          </Notice>
        )}
        <label className={styles.field}>
          <input
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={amountStr}
            onChange={(e) => setAmountStr(clean(e.target.value))}
            aria-label={tab === "deposit" ? "Deposit amount" : "Withdraw amount"}
          />
          <TokenSymbol />
        </label>
        <div className={styles.quick}>
          {tab === "deposit"
            ? [0.25, 0.5, 1].map((f) => (
                <button key={f} type="button" disabled={maxDeposit <= 0} onClick={() => setAmountStr(String(Math.floor(maxDeposit * f * 100) / 100))}>
                  {f === 1 ? "Max allowed" : `${f * 100}%`}
                </button>
              ))
            : [0.25, 0.5, 1].map((f) => (
                <button key={f} type="button" disabled={free <= 0} onClick={() => setAmountStr(String(Math.floor(free * f * 1e6) / 1e6))}>
                  {f === 1 ? "All free" : `${f * 100}%`}
                </button>
              ))}
        </div>
        {tab === "deposit" ? (
          <dl className={styles.fees}>
            {room.holder && (
              <div title="Allowed beyond the caps while your equity is below your initial margin, up to the amount that restores it. Recomputed at fresh Pyth prices when you submit.">
                <dt>Add margin beyond the cap</dt>
                <dd className="mono">up to {fmtAusd(room.topUp)}</dd>
              </div>
            )}
            <div>
              <dt>Room under your account cap</dt>
              <dd className="mono">{room.accountRoom === null ? "-" : fmtAusd(room.accountRoom)}</dd>
            </div>
            <div>
              <dt>Room under lane {acct ? acct.lane : ""} TVL cap</dt>
              <dd className="mono">{room.laneRoom === null ? "-" : fmtAusd(room.laneRoom)}</dd>
            </div>
            <div className={styles.feesTotal}>
              <dt>Approval</dt>
              <dd>exact amount, never unlimited</dd>
            </div>
          </dl>
        ) : (
          <dl className={styles.fees}>
            <div>
              <dt>Health check priced at</dt>
              <dd>
                {!priced.needed
                  ? "not needed (no open positions)"
                  : quote.q?.source === "fresh"
                    ? keeperSigned
                      ? "fresh keeper-signed update"
                      : "fresh signed Pyth update (via the keeper)"
                    : `${keeperSigned ? "Price" : "Pyth price"} stored on chain${priced.oldestAge !== null ? ` (${Math.round(priced.oldestAge)}s old)` : ""}`}
              </dd>
            </div>
            <div>
              <dt>Stored-price age limit</dt>
              <dd className="mono">{priced.maxStoredAge !== null ? fmtDuration(priced.maxStoredAge) : "-"}</dd>
            </div>
            <div className={styles.feesTotal}>
              <dt>{keeperSigned ? "Price update fee" : "Pyth update fee"}</dt>
              <dd className="mono">
                {quote.q?.source === "fresh" ? (
                  <>
                    {fmtMon(quote.q.fee, 9)} <small>{NETWORK.nativeSymbol}</small>
                  </>
                ) : priced.needed && quote.error ? (
                  "update unavailable"
                ) : (
                  "none (no update needed)"
                )}
              </dd>
            </div>
          </dl>
        )}
        {tab === "withdraw" && priced.needed && quote.error && (
          <Notice tone="warn">
            Prices are refreshing: the {keeperSigned ? "price" : "Pyth price"} stored on chain is too old for the contract and a fresh update
            couldn&apos;t be fetched right now. Retry in a few seconds.
          </Notice>
        )}
        {tab === "deposit" && !room.holder && laneDebt > 0 && (
          <Notice tone="warn">
            Lane {acct ? acct.lane : ""} has {fmtAusd(laneDebt)} AUSD of bad debt, so new deposits into it are refused
            until it is repaid. Accounts with open positions can still add margin.
          </Notice>
        )}
        {tab === "deposit" && acct && !acct.registered && (
          <p className={styles.fine}>
            Your first deposit must be at least {fmtAusd(params?.minFirstDeposit ?? 1)} {token.symbol}.
          </p>
        )}
        {tab === "withdraw" && haircutBps > 0 && (
          <Notice tone="warn">
            Lane {acct ? acct.lane : ""} has bad debt: withdrawals are cut by {(haircutBps / 100).toFixed(2)}% until
            it is repaid
            {preview && preview.amount === amountNum && amountNum > 0 ? (
              <>
                {" "}
                - withdrawing <span className="mono">{fmtAusd(amountNum)}</span> pays{" "}
                <span className="mono">{fmtAusd(preview.paid)}</span> {token.symbol}
              </>
            ) : null}
            .
          </Notice>
        )}
        {tab === "deposit" && !acked && !depositPaused && (
          <p className={styles.fine}>Your first deposit asks you to confirm the beta risk notice.</p>
        )}
        {/* Always labelled with what it does; a blocking reason sits on the state line under it. */}
        <button
          type="button"
          className={styles.submit}
          disabled={busy || reason !== null}
          aria-describedby={reason !== null && !busy ? "wallet-submit-state" : undefined}
          onClick={submit}
        >
          {busy
            ? "Confirming on chain…"
            : tab === "deposit"
              ? amount > 0
                ? `Deposit ${fmtAusd(amount)} ${token.symbol}`
                : `Deposit ${token.symbol}`
              : amount > 0
                ? `Withdraw ${fmtAusd(amount)} ${token.symbol}`
                : `Withdraw ${token.symbol}`}
        </button>
        <StateLine id="wallet-submit-state" reason={busy ? null : reason} />
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <details className={styles.more}>
          <summary>Withdrawals stay open while trading is paused</summary>
          <p className={styles.fine}>
            {keeperSigned
              ? "The health check uses the price stored on chain when it's fresh, else a fresh update signed by the Paraclr keeper: simulated after the Pyth trial, checked against the keeper's key on chain, not attested by Pyth."
              : "The health check uses the Pyth price stored on chain when it's fresh, else a Pyth-signed update relayed by the keeper (verified on chain, so the relay can't alter it)."}
          </p>
        </details>
      </section>

      <section className={styles.card}>
        <div className={styles.cardTitle}>
          <span>Beta limits</span>
          <span>changeable only via the timelock</span>
        </div>
        <div className={styles.caps}>
          <CapBar label="Your deposits" used={acct ? Math.max(0, acct.collateral) : null} cap={params?.maxDepositPerAccount ?? null} />
          <CapBar label={`Lane ${acct ? acct.lane : ""} TVL`} used={prod?.lane?.tvl ?? null} cap={params?.maxTvlPerLane ?? null} />
        </div>
        <dl className={styles.kv}>
          <div>
            <dt>Max leverage</dt>
            <dd className="mono">{params?.maxLeverage != null ? `${params.maxLeverage}x` : "-"}</dd>
          </div>
          <div>
            <dt>Min position</dt>
            <dd className="mono">{params?.minPositionNotional != null ? fmtAusd(params.minPositionNotional) : "-"}</dd>
          </div>
          <div>
            <dt>Trading fee</dt>
            <dd className="mono">{params?.tradingFeeBps != null ? `${(params.tradingFeeBps / 100).toFixed(2)}%` : "-"}</dd>
          </div>
          <div>
            <dt>Execution fee</dt>
            <dd className="mono">
              {fmtMon(params?.minExecutionFee)} {NETWORK.nativeSymbol}
            </dd>
          </div>
          <div>
            <dt>Order fill window</dt>
            <dd className="mono">
              {params?.minExecDelay != null && params.maxExecDelay != null
                ? `${fmtDuration(params.minExecDelay)}–${fmtDuration(params.maxExecDelay)}`
                : "-"}
            </dd>
          </div>
          <div>
            <dt>Funding interval</dt>
            <dd className="mono">{params?.fundingInterval != null ? fmtDuration(params.fundingInterval) : "-"}</dd>
          </div>
        </dl>
        <p className={styles.fine}>
          Unaudited beta: use only what you can afford to lose. <Link href="/terms" target="_blank">Terms</Link> ·{" "}
          <Link href="/risk" target="_blank">Risks</Link> ·{" "}
          <button type="button" className={styles.fine} style={{ textDecoration: "underline" }} onClick={() => showRiskAck(session.address)}>
            Re-read the risk notice
          </button>
        </p>
      </section>

      <div>
        <TxTray />
      </div>

      <div className={styles.walletWide}>
        {privyEnabled && isPasskey ? (
          <PrivySignOutButton className={styles.btnGhost} />
        ) : (
          <button type="button" className={styles.btnGhost} onClick={signOut}>
            Sign out
          </button>
        )}
      </div>
    </div>
  );
}
