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
import { acceptRiskAck, dismissRiskAck, useRiskAcked, useRiskAckModal } from "@/lib/chain/prod/riskAck";
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
import rs from "./RiskAck.module.css";

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
          <b>{NETWORK.sandbox ? `${NETWORK.label} · test funds, no real value` : TESTNET_FUNDS_LABEL}</b>
          <span className={styles.bannerMore}>
            {" "}
            · production contracts, unaudited, capped{keeperSigned ? " · prices simulated after the Pyth trial" : ""}
          </span>
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
  return <RiskAckDialog address={address} />;
}

/** Short heading per risk point (the point's text follows it). */
const RISK_TITLES: Record<string, string> = {
  [RISK_ANCHORS.smartContract]: "Unaudited code",
  [RISK_ANCHORS.liquidation]: "Liquidation",
  [RISK_ANCHORS.oracle]: "Oracle prices",
  [RISK_ANCHORS.caps]: "Caps and pause",
  [RISK_ANCHORS.stablecoin]: "Collateral",
  [RISK_ANCHORS.recovery]: "No recovery",
  [RISK_ANCHORS.regulatory]: "Your jurisdiction",
};

function RiskAckDialog({ address }: { address: string }) {
  const params = useParaclr((s) => s.chain.prod?.params ?? null);
  const token = useParaclr((s) => s.chain.contracts?.token ?? null);
  const keeperSigned = useParaclr((s) => s.chain.contracts?.oracleKind === "keeper-signed");
  const acked = useRiskAcked(address);
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
    params?.maxLeverage != null ? `up to ${params.maxLeverage}x` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const all = CONFIRMS.every((c) => on[c.id]);
  const where = realMoney ? "Monad mainnet · real funds" : testnet ? `${NETWORK?.label ?? "Monad testnet"} · test funds` : (NETWORK?.label ?? "this chain");

  return (
    <div className={rs.overlay} role="presentation" onClick={(e) => e.target === e.currentTarget && dismissRiskAck()}>
      <div ref={dialog} className={rs.sheet} role="dialog" aria-modal="true" aria-labelledby="risk-title" tabIndex={-1}>
        <div className={rs.body}>
          <p className={rs.kicker}>
            <i aria-hidden="true" />
            {acked ? "Risk notice" : "Before your first deposit"} · {where}
          </p>
          <h2 id="risk-title" className={rs.title}>
            {realMoney ? "Real money, unaudited beta." : "Read before you deposit."}
            <span>{realMoney ? "Use only what you can afford to lose." : "Unaudited, capped beta."}</span>
          </h2>
          <p className={rs.lede}>
            {realMoney
              ? "You're about to deposit real Agora AUSD into Paraclr's clearinghouse on Monad mainnet."
              : testnet && token?.testnet
                ? "Agora's testnet AUSD has no real value, but the contract code and rules are the ones the mainnet beta uses."
                : `You're about to deposit ${token?.symbol ?? "collateral"} into the production clearinghouse${token?.test ? " (a test token, not real AUSD)" : ""}.`}
          </p>
          <ol className={rs.points}>
            {RISK_ACK_POINTS.map((pt, i) => (
              <li key={pt.anchor} className={rs.point}>
                <span className={rs.num}>{String(i + 1).padStart(2, "0")}</span>
                <span className={rs.pointText}>
                  <b>{RISK_TITLES[pt.anchor] ?? "Risk"}</b>
                  {pt.anchor === RISK_ANCHORS.oracle && keeperSigned
                    ? "Prices are simulated after the Pyth trial: the Paraclr keeper signs them (relaying Pyth's mainnet prices) and a testnet-only oracle checks its signature, not Pyth. Orders fill at a price you can't see when you submit them."
                    : pt.text}
                  {pt.anchor === RISK_ANCHORS.caps && capLine ? <span className={rs.caps}>Now: {capLine}</span> : null}
                </span>
                <Link
                  className={rs.more}
                  href={`${RISK_PATH}#${pt.anchor}`}
                  target="_blank"
                  aria-label={`${RISK_TITLES[pt.anchor] ?? "Risk"}: details (opens in a new tab)`}
                >
                  More ↗
                </Link>
              </li>
            ))}
          </ol>
          <div className={rs.checks}>
            {CONFIRMS.map((c) => (
              <label key={c.id} className={rs.check}>
                <input
                  type="checkbox"
                  checked={!!on[c.id]}
                  onChange={(e) => setOn((s) => ({ ...s, [c.id]: e.target.checked }))}
                />
                <span className={rs.box} aria-hidden="true">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M2.5 6.2 L5 8.6 L9.6 3.6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <span>{c.text}</span>
              </label>
            ))}
          </div>
        </div>
        <div className={rs.foot}>
          <div className={rs.links}>
            <Link href={TERMS_PATH} target="_blank">
              Terms
            </Link>
            <Link href={RISK_PATH} target="_blank">
              Full risk disclosure
            </Link>
          </div>
          <div className={rs.actions}>
            <button type="button" className={rs.ghost} onClick={dismissRiskAck}>
              Not now
            </button>
            <button type="button" className={rs.primary} disabled={!all} onClick={acceptRiskAck} aria-describedby="risk-hint">
              I understand - continue
            </button>
          </div>
          <p id="risk-hint" className={rs.hint} aria-live="polite">
            {all ? "" : "Tick both boxes to continue."}
          </p>
        </div>
      </div>
    </div>
  );
}
