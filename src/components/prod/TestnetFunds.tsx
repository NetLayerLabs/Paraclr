"use client";

// "Get testnet AUSD" (monad-testnet mode only). Agora's AUSD faucet on Monad
// testnet is a contract with no web page, so this card calls it from the
// signed-in wallet (`requestFunds(you)`), shows its limits as read from the
// contract, and links the contract, Agora's docs and Monad's MON faucet for
// gas. In the local sandbox the sandbox keeper's faucet (MON + AUSD on the
// fork) comes first, since a fresh burner has no gas there.

import { useState } from "react";
import { useParaclr } from "@/lib/store";
import {
  AGORA_AUSD_FAUCET_TESTNET,
  AGORA_DEPLOYMENTS_DOCS,
  MONAD_TESTNET_EXPLORER,
  MONAD_TESTNET_FAUCET_URL,
  NETWORK,
} from "@/lib/chain/config";
import { readableError } from "@/lib/chain/errors";
import { claimTestAusd, requestSandboxFaucet, useAgoraFaucet } from "@/lib/chain/prod/agoraFaucet";
import { Notice } from "@/components/chain/ChainUi";
import { fmtAusd } from "@/components/trade/format";
import { TokenSymbol } from "./Token";
import { useNow } from "./util";
import styles from "./Prod.module.css";

const whole = (n: number | null) => (n === null ? "-" : n.toLocaleString("en-US", { maximumFractionDigits: 0 }));

export function TestnetFunds() {
  const acct = useParaclr((s) => s.chain.account);
  const wallet = useParaclr((s) => s.chain.wallet);
  const sandboxFaucet = useParaclr((s) => s.chain.faucet);
  const testnetToken = useParaclr((s) => s.chain.contracts?.token.testnet ?? false);
  const faucet = useAgoraFaucet(true);
  const now = useNow(1_000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  if (!NETWORK?.isTestnetProd) return null;
  const sandbox = NETWORK.sandbox;

  // Cooldown: the contract's clock, extrapolated from when it was read.
  const wait =
    faucet?.nextAt != null && faucet.chainTime !== null
      ? Math.max(0, Math.ceil(faucet.nextAt - (faucet.chainTime + Math.max(0, now - faucet.readAt) / 1000)))
      : 0;
  const overCap = faucet?.maxOwn != null && acct !== null && acct.walletAusd >= faucet.maxOwn;
  const reason = !testnetToken
    ? "This deployment's collateral isn't Agora's testnet AUSD"
    : !wallet.ready
      ? (wallet.error ?? "Connecting wallet…")
      : !acct
        ? "Reading your wallet…"
        : faucet && !faucet.tokenMatches
          ? "The faucet pays a different token"
          : overCap
            ? `You hold the faucet's maximum (${whole(faucet?.maxOwn ?? null)} AUSD)`
            : acct.native <= 0
              ? sandbox
                ? "Need MON for gas: use the sandbox faucet first"
                : "Need testnet MON for gas first"
              : wait > 0
                ? `Faucet cooling down · ${wait}s`
                : null;

  const claim = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const got = await claimTestAusd();
      setMsg({ tone: "ok", text: `Received ${fmtAusd(got)} test AUSD from Agora's faucet.` });
    } catch (e) {
      setMsg({ tone: "error", text: readableError(e) });
    } finally {
      setBusy(false);
    }
  };

  const sandboxBusy = sandboxFaucet.status === "requesting" || sandboxFaucet.status === "checking";
  const drip = faucet?.drip ?? null;

  return (
    <section className={styles.card} aria-labelledby="testnet-funds-title">
      <div className={styles.cardTitle}>
        <span id="testnet-funds-title">Get testnet AUSD</span>
        <span>
          <TokenSymbol />
        </span>
      </div>

      {sandbox && (
        <>
          <p className={styles.fine}>
            Local sandbox (fork of Monad testnet, not live): the sandbox keeper sends this wallet MON for gas and test
            AUSD on the fork.
          </p>
          <button
            type="button"
            className={styles.btnPrimary}
            disabled={!wallet.ready || sandboxBusy}
            onClick={() => {
              setMsg(null);
              requestSandboxFaucet().catch((e: unknown) => setMsg({ tone: "error", text: readableError(e) }));
            }}
          >
            {sandboxBusy ? "Requesting…" : "Sandbox faucet: MON + AUSD"}
          </button>
          {sandboxFaucet.status === "failed" && sandboxFaucet.message && (
            <Notice tone="warn">Sandbox faucet: {sandboxFaucet.message}</Notice>
          )}
          {sandboxFaucet.status === "funded" && <Notice tone="ok">{sandboxFaucet.message ?? "Funded."}</Notice>}
        </>
      )}

      <p className={styles.fine}>
        Agora&apos;s AUSD faucet on Monad testnet is a contract, not a web page. This button calls its{" "}
        <code>requestFunds(your address)</code> from your wallet: {drip !== null ? `${whole(drip)} AUSD` : "a fixed amount"}{" "}
        per claim, one claim a minute across everyone, while you hold under{" "}
        {faucet?.maxOwn != null ? `${whole(faucet.maxOwn)} AUSD` : "its limit"}. Test funds, no real value.
      </p>
      <dl className={styles.kv}>
        <div>
          <dt>Per claim</dt>
          <dd className="mono">{whole(drip)}</dd>
        </div>
        <div>
          <dt>Max held</dt>
          <dd className="mono">{whole(faucet?.maxOwn ?? null)}</dd>
        </div>
        <div>
          <dt>Next claim</dt>
          <dd className="mono">{faucet ? (wait > 0 ? `in ${wait}s` : "now") : "…"}</dd>
        </div>
      </dl>
      <button type="button" className={sandbox ? styles.btnGhost : styles.btnPrimary} disabled={busy || reason !== null} onClick={claim}>
        {busy ? "Claiming on chain…" : (reason ?? `Claim ${drip !== null ? whole(drip) : ""} test AUSD`.replace("  ", " "))}
      </button>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <p className={styles.fine}>
        <a href={`${MONAD_TESTNET_EXPLORER}/address/${AGORA_AUSD_FAUCET_TESTNET}`} target="_blank" rel="noreferrer">
          Faucet contract{sandbox ? " (on the real testnet)" : ""} ↗
        </a>{" "}
        ·{" "}
        <a href={AGORA_DEPLOYMENTS_DOCS} target="_blank" rel="noreferrer">
          Agora&apos;s address list ↗
        </a>
        {!sandbox && (
          <>
            {" "}
            ·{" "}
            <a href={MONAD_TESTNET_FAUCET_URL} target="_blank" rel="noreferrer">
              Testnet MON for gas ↗
            </a>
          </>
        )}
      </p>
    </section>
  );
}
