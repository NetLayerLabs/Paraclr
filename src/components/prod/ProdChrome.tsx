"use client";

// Production chrome: the persistent beta banner, the pause strip, the risk
// acknowledgement modal (before the first deposit) and the blocking screen
// shown when a production mode (mainnet or testnet) can't connect (never a
// silent simulation). On Monad testnet the banner leads with "test funds, no
// real value"; in the local sandbox it says it's a local fork, not live.

import { LogoLoader } from "@/components/brand/LogoLoader";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useParaclr } from "@/lib/store";
import { NETWORK, PRODUCTION_MODE } from "@/lib/chain/config";
import { acceptRiskAck, dismissRiskAck, useRiskAckModal } from "@/lib/chain/prod/riskAck";
import { retryChainConnect } from "@/components/chain/ChainProvider";
import { fmtAusd } from "@/components/trade/format";
// Shared beta / legal copy (content agent), so the modal and /risk say the same thing.
import {
  BETA_LABEL,
  RISK_ACK_POINTS,
  RISK_ANCHORS,
  RISK_PATH,
  TERMS_PATH,
} from "@/components/landing/disclosures";
import { NoticeClose } from "./NoticeClose";
import styles from "./Prod.module.css";

/** True when the app runs against the production contracts (or a production mode, even before connecting). */
export function useProductionUi(): boolean {
  const production = useParaclr((s) => s.chain.status === "ready" && !!s.chain.contracts?.production);
  return PRODUCTION_MODE || production;
}

/** The testnet label the plan requires everywhere in monad-testnet mode. */
export const TESTNET_FUNDS_LABEL = "Monad testnet · test funds, no real value";

export function BetaBanner() {
  const on = useProductionUi();
  const keeperSigned = useParaclr((s) => s.chain.contracts?.oracleKind === "keeper-signed");
  const rehearsal = NETWORK?.isMainnet && NETWORK.local;
  if (!on) return null;
  if (NETWORK?.isTestnetProd) {
    return (
      <div className={styles.beta} data-tone="testnet" data-notice="testnet" role="note" aria-label="Testnet notice">
        <i className={styles.bannerDot} aria-hidden />
        <span className={styles.bannerText}>
          <b>{NETWORK.sandbox ? `${NETWORK.label} · test funds, no real value` : TESTNET_FUNDS_LABEL}</b> · production
          contracts, unaudited, capped{keeperSigned ? " · prices simulated after the Pyth trial" : ""}
        </span>
        <span className={styles.bannerLinks}>
          <Link href={TERMS_PATH} target="_blank">
            Terms
          </Link>
          <Link href={RISK_PATH} target="_blank">
            Risks
          </Link>
        </span>
        <NoticeClose className={styles.bannerClose} />
      </div>
    );
  }
  return (
    <div className={styles.beta} role="note" aria-label="Beta notice">
      <i className={styles.bannerDot} aria-hidden />
      <span className={styles.bannerText}>
        <b>{BETA_LABEL.split(" · ").slice(0, 2).join(" · ")}</b> · {BETA_LABEL.split(" · ").slice(2).join(" · ")}
        {rehearsal ? " · local mainnet-fork rehearsal, not Monad" : ""}
      </span>
      <span className={styles.bannerLinks}>
        <Link href={TERMS_PATH} target="_blank">
          Terms
        </Link>
        <Link href={RISK_PATH} target="_blank">
          Risks
        </Link>
      </span>
    </div>
  );
}

export function PausedBanner() {
  const paused = useParaclr((s) => s.chain.prod?.paused === true);
  if (!paused) return null;
  return (
    <div className={styles.paused} role="alert">
      <i className={styles.bannerDot} aria-hidden />
      <span className={styles.bannerText}>
        <b>Paused by the guardian.</b> Deposits and new or increased positions are disabled. Withdrawals, reduce and
        close orders, and liquidations keep working.
      </span>
    </div>
  );
}

/** A production mode that couldn't connect: explain and offer a retry - never a simulated terminal. */
export function MainnetUnavailable() {
  const reason = useParaclr((s) => s.chain.reason);
  const status = useParaclr((s) => s.chain.status);
  const where = NETWORK?.label ?? "Monad mainnet";
  const title = NETWORK?.sandbox
    ? "Can't reach the local sandbox"
    : NETWORK?.isTestnetProd
      ? "Can't reach the testnet deployment"
      : "Can't reach the mainnet beta";
  if (status === "connecting") {
    return (
      <main className={styles.blocked}>
        <LogoLoader label={`Connecting to ${where}`} />
      </main>
    );
  }
  return (
    <main className={styles.blocked}>
      <section className={styles.blockedCard}>
        <h1>{title}</h1>
        {(
          <>
            <p>
              The app is configured for the production contracts on {where} and never falls back to a simulation
              here, so pretend balances can&apos;t be mistaken for {NETWORK?.isTestnetProd ? "on-chain" : "real"} ones.
              Reason:
            </p>
            <p>
              <code>{reason ?? "unknown"}</code>
            </p>
            <div className={styles.modalActions} style={{ justifyContent: "flex-start" }}>
              <button type="button" className={styles.btnPrimary} onClick={retryChainConnect}>
                Retry
              </button>
              <Link href="/" className={styles.btnGhost} style={{ display: "inline-flex", alignItems: "center" }}>
                Back to home
              </Link>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

const CONFIRMS = [
  {
    id: "risk",
    text: "I've read these risks. This is an unaudited, capped beta and I can lose everything I deposit.",
  },
  {
    id: "legal",
    text: "Using Paraclr is legal where I live, and I accept the Terms.",
  },
] as const;

export function RiskAckModal() {
  const { open, address } = useRiskAckModal();
  // Mounted fresh on every open, so the checkboxes always start unticked.
  if (!open || !address) return null;
  return <RiskAckDialog />;
}

function RiskAckDialog() {
  const params = useParaclr((s) => s.chain.prod?.params ?? null);
  const token = useParaclr((s) => s.chain.contracts?.token ?? null);
  const keeperSigned = useParaclr((s) => s.chain.contracts?.oracleKind === "keeper-signed");
  const realMoney = !!NETWORK?.isMainnet && !NETWORK.local && !!token?.agora && !token.test;
  const testnet = !!NETWORK?.isTestnetProd;
  const [on, setOn] = useState<Record<string, boolean>>({});
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialog.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismissRiskAck();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const capLine = [
    params?.maxDepositPerAccount != null ? `${fmtAusd(params.maxDepositPerAccount)} AUSD per account` : null,
    params?.maxTvlPerLane != null ? `${fmtAusd(params.maxTvlPerLane)} AUSD per lane` : null,
    params?.maxLeverage != null ? `leverage up to ${params.maxLeverage}x` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const all = CONFIRMS.every((c) => on[c.id]);

  return (
    <div className={styles.overlay} role="presentation" onClick={(e) => e.target === e.currentTarget && dismissRiskAck()}>
      <div
        ref={dialog}
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="risk-title"
        tabIndex={-1}
      >
        <span className={styles.modalKicker}>Before your first deposit</span>
        <h2 id="risk-title">
          {realMoney
            ? "Real money, unaudited beta"
            : testnet
              ? "Unaudited beta on testnet: read before depositing"
              : "Unaudited beta: read before depositing"}
        </h2>
        <p>
          {realMoney
            ? "You're about to deposit real Agora AUSD on Monad mainnet into Paraclr's clearinghouse contract."
            : testnet && token?.testnet
              ? `You're about to deposit Agora's testnet AUSD into the production clearinghouse on ${NETWORK?.label ?? "Monad testnet"}: test funds with no real value, but the same contract code and rules as the mainnet beta.`
              : `You're about to deposit ${token?.symbol ?? "collateral"} into the production clearinghouse on ${NETWORK?.label ?? "this chain"}${token?.test ? " (a test token, not real AUSD)" : ""}.`}{" "}
          Please read each point.
        </p>
        <ul className={styles.points}>
          {RISK_ACK_POINTS.map((pt) => (
            <li key={pt.anchor}>
              <span>
                {pt.anchor === RISK_ANCHORS.oracle && keeperSigned
                  ? "Prices are simulated after the Pyth trial: the Paraclr keeper signs them (relaying Pyth's mainnet prices) and a testnet-only oracle checks its signature, not Pyth. Orders fill at a price you can't see when you submit them."
                  : pt.text}
                {pt.anchor === RISK_ANCHORS.caps && capLine ? <b> Now: {capLine}.</b> : null}
              </span>
              <Link href={`${RISK_PATH}#${pt.anchor}`} target="_blank">
                Details
              </Link>
            </li>
          ))}
        </ul>
        <ul className={styles.checks}>
          {CONFIRMS.map((c) => (
            <li key={c.id}>
              <label className={styles.check} data-on={on[c.id] ? "" : undefined}>
                <input
                  type="checkbox"
                  checked={!!on[c.id]}
                  onChange={(e) => setOn((s) => ({ ...s, [c.id]: e.target.checked }))}
                />
                <span>
                  <b>{c.text}</b>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className={styles.modalLinks}>
          <Link href={TERMS_PATH} target="_blank">
            Read the Terms
          </Link>
          <Link href={RISK_PATH} target="_blank">
            Read the full risk disclosure
          </Link>
        </div>
        <div className={styles.modalActions}>
          <button type="button" className={styles.btnGhost} onClick={dismissRiskAck}>
            Not now
          </button>
          <button type="button" className={styles.btnPrimary} disabled={!all} onClick={acceptRiskAck}>
            I understand - continue
          </button>
        </div>
      </div>
    </div>
  );
}
