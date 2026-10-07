"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ParaclrLogo } from "@/components/brand/ParaclrLogo";
import Link from "next/link";
import { useParaclr } from "@/lib/store";
import { burnerAllowed, startDemoSession } from "@/lib/auth/session";
import { CHAIN_MODE_ON, MAINNET_MODE, NETWORK, PRODUCTION_MODE } from "@/lib/chain/config";
import { useAuthContext } from "./AuthContext";
import { BiometricButton, type BiometricPhase } from "./BiometricButton";
import { PrivyOtherLogin, PrivyPasskeyLogin } from "./PrivyAuth";
import { ThemeToggle } from "@/components/shell/theme";
import styles from "./LoginScreen.module.css";

// Official marks (public/partners/): Monad, Agora and Envio from their published SVGs (Envio's symbol
// without its black tile), Pyth and Privy recoloured white from their official icons. The brand
// panel is dark in both themes.
const MONAD = { name: "Monad", logo: "/partners/monad.svg" };
const AGORA = { name: "Agora AUSD", logo: "/partners/agora.svg" };
const PYTH = { name: "Pyth", logo: "/partners/pyth-white.png" };
const PRIVY = { name: "Privy", logo: "/partners/privy-white.png" };
const ENVIO = { name: "Envio", logo: "/partners/envio.svg" };
const PARTNERS = [MONAD, AGORA, PRIVY];
// Production: prices from Pyth (delayed orders execute against Pyth updates); order history and
// activity from the Envio indexer.
const PARTNERS_PROD = [MONAD, AGORA, PYTH, PRIVY, ENVIO];

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
  const name = NETWORK.mode === "anvil" ? "Local anvil (not Monad)" : NETWORK.label;
  const text =
    status === "connecting"
      ? `Connecting to ${NETWORK.label}…`
      : status === "unavailable"
        ? `${name} unavailable · simulation`
        : `${name} · chain ${NETWORK.chainId}`;
  return (
    <div
      className={styles.badge}
      data-tone={status === "unavailable" || !NETWORK.isMonad || NETWORK.isMainnet ? "warn" : undefined}
      title={NETWORK.isTestnetProd ? "Test funds, no real value" : undefined}
    >
      <span className={styles.dot} /> {text}
    </div>
  );
}

/** One line under the sign-in heading: what you're about to trade on. */
function venueLine(status: string, production: boolean, agora: boolean): string {
  if (!CHAIN_MODE_ON || !NETWORK || status === "unavailable") {
    return "Perps margined in simulated AUSD. Everything runs in this browser; no chain.";
  }
  if (status === "connecting") return `Connecting to ${NETWORK.label}…`;
  if (production) {
    if (NETWORK.isTestnetProd) {
      return NETWORK.sandbox
        ? "The production contracts on a local fork of Monad testnet (not live), margined in Agora's testnet AUSD with Pyth prices. Test funds, no real value."
        : `The production contracts on Monad testnet, margined in ${agora ? "Agora's testnet AUSD" : "a test collateral token"} with Pyth prices. Test funds, no real value; unaudited, capped.`;
    }
    return NETWORK.isMainnet && !NETWORK.local && agora
      ? "Perps margined in real Agora AUSD on Monad mainnet. Unaudited beta, capped: use only what you can afford to lose."
      : `Production contracts on ${NETWORK.label}${agora ? "" : ", with a test collateral token"}: unaudited, capped beta.`;
  }
  return NETWORK.mode === "monad"
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
  const production = useParaclr((s) => s.chain.status === "ready" && !!s.chain.contracts?.production);
  const agora = useParaclr((s) => s.chain.contracts?.token.agora ?? false);
  const connecting = status === "connecting";
  const chainLive = status === "ready";
  const burner = burnerAllowed();
  const rehearsal = MAINNET_MODE && burner;

  return (
    <div className={styles.root}>
      <nav className={styles.top} aria-label="Site">
        <Link href="/" className={styles.brandMark} title="Paraclr home" aria-label="Paraclr home">
          <ParaclrLogo tone="auto" height={26} />
        </Link>
        <span className={styles.topActions}>
          <ThemeToggle className={styles.themeBtn} />
        </span>
      </nav>

      <div className={styles.center}>
        <div className={styles.card}>
          {/* The brand panel is a "black chapter" in both themes (docs/DESIGN.md). */}
          <section className={styles.brand}>
            <NetworkBadge />
            <h1 className={styles.headline}>
              Fair liquidations. <em>Live solvency proof.</em>
            </h1>
            <ul className={styles.trustRow}>
              <li>
                <i aria-hidden /> Per-block auctions
              </li>
              <li>
                <i aria-hidden /> Per-lane backstops
              </li>
              <li>
                <i aria-hidden /> Traders keep their leftover equity
              </li>
            </ul>
            {/* The brand's 8 lanes taking one quarter turn (the mark's geometry at panel scale). */}
            <div className={styles.lanes} aria-hidden="true">
              {Array.from({ length: 8 }, (_, i) => (
                <i key={i} style={{ "--k": i + 1 } as CSSProperties} />
              ))}
            </div>
            <footer className={styles.partners}>
              {(production || PRODUCTION_MODE ? PARTNERS_PROD : PARTNERS).map((p) => (
                <span key={p.name} className={styles.partner}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className={styles.partnerLogo} src={p.logo} width={14} height={14} alt="" />
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
              <p className={styles.signSub}>{venueLine(status, production, agora)}</p>
            </header>
            {privyEnabled ? (
              <>
                <PrivyPasskeyLogin />
                <PrivyOtherLogin disabled={connecting} />
              </>
            ) : MAINNET_MODE && !burner ? (
              <p className={styles.hint}>
                Sign-in isn&apos;t configured for this deployment (Privy app id missing). There is no demo or burner
                wallet on mainnet.
              </p>
            ) : PRODUCTION_MODE ? (
              // Testnet production: no simulated passkey next to real contracts.
              <p className={styles.hint}>
                Passkey sign-in isn&apos;t configured here (NEXT_PUBLIC_PRIVY_APP_ID unset). The demo burner wallet works
                without it.
              </p>
            ) : (
              <SimulatedPasskeyLogin disabled={connecting} chainLive={chainLive} />
            )}
            {burner && (
              <>
                {(privyEnabled || !PRODUCTION_MODE) && (
                  <div className={styles.or} aria-hidden="true">
                    <span>or</span>
                  </div>
                )}
                <button className={styles.demoBtn} disabled={connecting} onClick={() => startDemoSession()}>
                  {connecting
                    ? "Connecting…"
                    : rehearsal
                      ? "Rehearsal burner wallet (local fork only)"
                      : NETWORK?.isTestnetProd
                        ? NETWORK.sandbox
                          ? "Demo burner wallet (local sandbox)"
                          : "Demo burner wallet (testnet, no real value)"
                        : chainLive
                          ? "Try demo mode (burner wallet)"
                          : "Try demo mode"}
                </button>
              </>
            )}
            <p className={styles.fine}>
              {MAINNET_MODE
                ? rehearsal
                  ? "Local mainnet-fork rehearsal: a burner key generated in this browser, for testing only. On real mainnet only passkey sign-in is offered."
                  : "Passkey, email or a social account → a Privy embedded wallet; a wallet sign-in uses your own wallet. Every transaction asks for your confirmation."
                : NETWORK?.isTestnetProd
                  ? "Passkey, email or a social account → a Privy embedded wallet on Monad testnet; a wallet sign-in uses your own wallet. Demo → a burner key generated and stored in this browser (testnet only, never on mainnet)."
                  : chainLive
                    ? "Passkey, email or a social account → a Privy embedded wallet; a wallet sign-in uses your own wallet. Demo → a burner key generated and stored in this browser (testnet only)."
                    : "No seed phrase. Your passkey stays in your device\u2019s secure enclave."}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
