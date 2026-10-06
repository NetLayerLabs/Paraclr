"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParaclr } from "@/lib/store";
import { startDemoSession } from "@/lib/auth/session";
import { CHAIN_MODE_ON, NETWORK } from "@/lib/chain/config";
import { useAuthContext } from "./AuthContext";
import { BiometricButton, type BiometricPhase } from "./BiometricButton";
import { PrivyPasskeyLogin } from "./PrivyAuth";
import styles from "./LoginScreen.module.css";

const PARTNERS = [
  { name: "Monad", color: "var(--accent)" },
  { name: "Agora AUSD", color: "var(--ausd)" },
  { name: "Chainlink", color: "var(--link)" },
  { name: "Privy", color: "var(--text)" },
];

/**
 * Without a Privy app id, the FaceID button plays the biometric flow and enters
 * demo mode (a browser burner wallet when the chain is live).
 */
function SimulatedPasskeyLogin({ disabled, chainLive }: { disabled: boolean; chainLive: boolean }) {
  const [phase, setPhase] = useState<BiometricPhase>("idle");
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const start = () => {
    setPhase("scanning");
    timers.current.push(
      window.setTimeout(() => setPhase("success"), 900),
      window.setTimeout(() => startDemoSession({ passkeySimulated: true }), 1350),
    );
  };

  return (
    <>
      <BiometricButton
        phase={phase}
        label="Sign in with FaceID"
        disabled={disabled || phase !== "idle"}
        onClick={start}
      />
      <p className={styles.hint}>
        {chainLive
          ? "Privy not configured, so the passkey is simulated and you get a demo burner wallet."
          : "Privy not configured, so the passkey is simulated (demo mode)."}
      </p>
    </>
  );
}

function NetworkBadge() {
  const status = useParaclr((s) => s.chain.status);
  if (!CHAIN_MODE_ON || !NETWORK) {
    return (
      <div className={styles.badge}>
        <span className={styles.dot} /> Simulation · no chain
      </div>
    );
  }
  const name = NETWORK.isMonad ? "Monad testnet" : "Local anvil (not Monad)";
  const text =
    status === "connecting"
      ? `Connecting to ${NETWORK.label}…`
      : status === "unavailable"
        ? `${name} unavailable · simulation`
        : `${name} · chain ${NETWORK.chainId}`;
  return (
    <div className={styles.badge} data-tone={status === "unavailable" || !NETWORK.isMonad ? "warn" : undefined}>
      <span className={styles.dot} /> {text}
    </div>
  );
}

/** One line under the sign-in heading: what you're about to trade on. */
function venueLine(status: string): string {
  if (!CHAIN_MODE_ON || !NETWORK || status === "unavailable") {
    return "Perps margined in simulated AUSD. Everything runs in this browser; no chain.";
  }
  if (status === "connecting") return `Connecting to ${NETWORK.label}…`;
  return NETWORK.isMonad
    ? "Perps margined in test AUSD, settled by the on-chain clearinghouse on Monad testnet."
    : "Perps margined in test AUSD, settled by the clearinghouse on a local anvil chain (not Monad).";
}

/**
 * In-app sign-in (the marketing pitch lives on the landing page at "/"):
 * a compact brand panel next to the sign-in card on wider screens, stacked on
 * phones.
 */
export function LoginScreen() {
  const { privyEnabled } = useAuthContext();
  const status = useParaclr((s) => s.chain.status);
  const connecting = status === "connecting";
  const chainLive = status === "ready";

  return (
    <div className={styles.root}>
      <div className={styles.grid} aria-hidden="true" />
      <div className={styles.glow} aria-hidden="true" />

      <nav className={styles.top}>
        <Link href="/" className={styles.back}>
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
            <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back to home
        </Link>
      </nav>

      <div className={styles.center}>
        <div className={styles.card}>
          <section className={styles.brand}>
            <NetworkBadge />
            <h1 className={styles.wordmark}>
              para<span>clr</span>
            </h1>
            <p className={styles.tagline}>
              Fair liquidations.
              <br />
              <em>Live solvency proof.</em>
            </p>
            <div className={styles.lanesWrap}>
              <div className={styles.lanes} aria-hidden="true">
                {Array.from({ length: 8 }, (_, i) => (
                  <span key={i} style={{ animationDelay: `${i * 0.13}s` }} />
                ))}
              </div>
              <p className={styles.lanesCaption}>
                Per-block auctions · per-lane backstops · traders keep their leftover equity
              </p>
            </div>
            <footer className={styles.partners}>
              {PARTNERS.map((p) => (
                <span key={p.name} className={styles.partner}>
                  <span className={styles.partnerDot} style={{ background: p.color }} />
                  {p.name}
                </span>
              ))}
            </footer>
          </section>

          <section className={styles.actions} aria-labelledby="signin-title">
            <header className={styles.signHead}>
              <h2 id="signin-title" className={styles.signTitle}>
                Sign in
              </h2>
              <p className={styles.signSub}>{venueLine(status)}</p>
            </header>
            {privyEnabled ? (
              <PrivyPasskeyLogin />
            ) : (
              <SimulatedPasskeyLogin disabled={connecting} chainLive={chainLive} />
            )}
            <div className={styles.or} aria-hidden="true">
              <span>or</span>
            </div>
            <button className={styles.demoBtn} disabled={connecting} onClick={() => startDemoSession()}>
              {connecting ? "Connecting…" : chainLive ? "Try demo mode (burner wallet)" : "Try demo mode"}
            </button>
            <p className={styles.fine}>
              {chainLive
                ? "Passkey → Privy embedded wallet. Demo → a burner key generated and stored in this browser (testnet only)."
                : "No seed phrase. Your passkey stays in your device\u2019s secure enclave."}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
