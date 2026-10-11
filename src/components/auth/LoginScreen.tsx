"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ParaclrLogo } from "@/components/brand/ParaclrLogo";
import Link from "next/link";
import { useParaclr } from "@/lib/store";
import { burnerAllowed, startDemoSession } from "@/lib/auth/session";
import { CHAIN_MODE_ON, MAINNET_MODE, MONAD_TESTNET_FAUCET_URL, NETWORK, PRODUCTION_MODE } from "@/lib/chain/config";
import { GITHUB_URL, README, README_AT } from "@/components/landing/content";
import { useAuthContext } from "./AuthContext";
import { BiometricButton, type BiometricPhase } from "./BiometricButton";
import { PrivyOtherLogin, PrivyPasskeyLogin } from "./PrivyAuth";
import { ThemeToggle } from "@/components/shell/theme";
import styles from "./LoginScreen.module.css";
import { fmtMon } from "@/lib/format";

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
        label="Sign in with a passkey"
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

const README_TRY = `${README}#how-to-try-it-judges-about-5-minutes`;

const fmtMonWei = (wei: bigint) => fmtMon(Number(wei) / 1e18);

/**
 * Testnet only: what happens after sign-in, so a first-time visitor knows the path before choosing a
 * method (the same steps as the README's "How to try it"), plus the no-sign-in routes to the Arena and
 * the evidence. Numbers come from chain and the keeper; while unknown, the step says it without one.
 */
function GettingStarted() {
  const params = useParaclr((s) => s.chain.prod?.params ?? null);
  const drip = useParaclr((s) => s.chain.keeper.health?.drip ?? null);
  if (!NETWORK?.isTestnetProd || NETWORK.sandbox) return null;
  const fee = params?.minExecutionFee != null ? `${fmtMonWei(params.minExecutionFee)} MON` : null;
  const dripAmount = drip?.enabled && drip.amount ? `${Number(drip.amount).toLocaleString("en-US")} ` : "";
  const cap = params?.maxDepositPerAccount != null ? ` up to ${params.maxDepositPerAccount.toLocaleString("en-US")} AUSD` : "";
  const lev = params?.maxLeverage != null ? `, up to ${params.maxLeverage}x` : "";
  return (
    <section className={styles.steps} aria-labelledby="steps-title">
      <h2 id="steps-title" className={styles.stepsTitle}>
        After you sign in
      </h2>
      <ol className={styles.stepList}>
        <li>
          <span className={styles.stepNum}>01</span>
          <b>Get test MON</b>
          <span>
            Press &ldquo;Get {dripAmount}test MON for gas&rdquo; (once per wallet) or use{" "}
            <a href={MONAD_TESTNET_FAUCET_URL} target="_blank" rel="noreferrer">
              faucet.monad.xyz ↗
            </a>
            . MON pays gas and the {fee ? `${fee} ` : ""}execution fee each order pays its executor.
          </span>
        </li>
        <li>
          <span className={styles.stepNum}>02</span>
          <b>Claim test AUSD</b>
          <span>From Agora&apos;s testnet faucet, in the order panel or on the Wallet tab. One claim a minute across everyone.</span>
        </li>
        <li>
          <span className={styles.stepNum}>03</span>
          <b>Deposit and trade</b>
          <span>
            Deposit{cap}, then long or short SOL or BTC{lev}. An order fills at the first Pyth price after a short delay;
            close it from Positions.
          </span>
        </li>
        <li>
          <span className={styles.stepNum}>04</span>
          <b>Watch a liquidation</b>
          <span>
            An underwater account goes to a per-block Dutch auction in its lane, and the trader keeps the equity the
            taker isn&apos;t paid. See it on the Clearing tab, or with no sign-in in the{" "}
            <Link href="/arena">Arena</Link>.
          </span>
        </li>
      </ol>
      <p className={styles.stepsMore}>
        <Link href="/arena">Arena: crash the market, no sign-in</Link>
        <a href={README_AT.xray} target="_blank" rel="noreferrer">
          Conflict X-ray ↗
        </a>
        <a href={README_TRY} target="_blank" rel="noreferrer">
          README ↗
        </a>
        <a href={GITHUB_URL} target="_blank" rel="noreferrer">
          GitHub ↗
        </a>
      </p>
    </section>
  );
}

/**
 * In-app sign-in (the marketing pitch lives on the landing page at "/"): one full-width page in the
 * app's surface, a short headline beside one primary control, other methods as a quiet secondary,
 * partners as a "Built on" line, and the lane bend at the page's corner.
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

  const partners = production || PRODUCTION_MODE ? PARTNERS_PROD : PARTNERS;

  return (
    <div className={styles.root}>
      {/* The one bend the app allows (docs/DESIGN.md §10.6): 8 lanes turning round the page's corner. */}
      <div className={styles.lanes} aria-hidden="true">
        {Array.from({ length: 8 }, (_, i) => (
          <i key={i} style={{ "--k": i + 1 } as CSSProperties} />
        ))}
      </div>

      <nav className={styles.top} aria-label="Site">
        <Link href="/" className={styles.brandMark} title="Paraclr home" aria-label="Paraclr home">
          <ParaclrLogo tone="auto" height={26} />
        </Link>
        <span className={styles.topActions}>
          <ThemeToggle className={styles.themeBtn} />
        </span>
      </nav>

      <div className={styles.center}>
        <section className={styles.brand} aria-labelledby="signin-title">
          <NetworkBadge />
          <h1 id="signin-title" className={styles.headline}>
            Fair liquidations. <em>Sign in to trade.</em>
          </h1>
          <p className={styles.signSub}>{venueLine(status, production, agora)}</p>
        </section>

        <section className={styles.actions} aria-label="Sign-in methods">
          {privyEnabled ? (
            <>
              <PrivyPasskeyLogin />
              <div className={styles.or} aria-hidden="true">
                <span>or</span>
              </div>
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
              {!privyEnabled && !PRODUCTION_MODE && (
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
                ? `Passkey, email or a social account → a Privy embedded wallet on Monad testnet; a wallet sign-in uses your own wallet.${burner ? " Demo → a burner key generated and stored in this browser (testnet only, never on mainnet)." : " Test funds, no real value."}`
                : chainLive
                  ? "Passkey, email or a social account → a Privy embedded wallet; a wallet sign-in uses your own wallet. Demo → a burner key generated and stored in this browser (testnet only)."
                  : "No seed phrase. Your passkey stays in your device\u2019s secure enclave."}
          </p>
        </section>
      </div>

      <GettingStarted />

      <footer className={styles.partners}>
        <span className={styles.builtOn}>Built on</span>
        <ul>
          {partners.map((p) => (
            <li key={p.name} className={styles.partner}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className={styles.partnerLogo} src={p.logo} width={14} height={14} alt="" />
              {p.name}
            </li>
          ))}
        </ul>
      </footer>
    </div>
  );
}
