"use client";

// One-click testnet gas: the production keeper's visitor drip (`POST /drip`,
// keeper/src/prod/drip.ts) sends a fresh wallet a little test MON once, so a
// new passkey wallet can pay gas and the order execution fee without leaving
// the app. Rendered only on Monad testnet (not the local sandbox, which has its
// own faucet) while keeper /health says the drip is enabled and the wallet
// holds less than the drip's minimum. Errors keep faucet.monad.xyz as fallback.

import { useEffect, useRef, useState } from "react";
import { formatEther, parseEther } from "viem";
import { useParaclr } from "@/lib/store";
import { MONAD_TESTNET_FAUCET_URL, NETWORK } from "@/lib/chain/config";
import { dripStatus, KeeperError, requestDrip, type DripResult } from "@/lib/chain/keeper";
import { refreshAccount } from "@/lib/chain/trading";
import { Notice, TxLink } from "@/components/chain/ChainUi";
import styles from "./Prod.module.css";

type Phase =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "queued"; position: number | null }
  | { kind: "sending"; tx: `0x${string}` }
  | { kind: "arrived"; tx: `0x${string}` | null }
  | { kind: "error"; message: string };

const ERRORS: Record<string, string> = {
  already_dripped: "This wallet already received its test MON from the drip (once per address).",
  has_balance: "This wallet already has enough MON for gas.",
  ip_limit: "The drip limit for your network is reached for today.",
  budget_exhausted: "Today's drip budget is used up.",
  drip_empty: "The drip wallet is out of test MON right now.",
  disabled: "The gas drip is off on this keeper.",
  contract: "The drip only funds wallets, not contracts.",
};

function errorText(e: unknown): string {
  if (e instanceof KeeperError) {
    if (e.code && ERRORS[e.code]) return ERRORS[e.code];
    return e.message.replace(/^Keeper drip: /, "");
  }
  return e instanceof Error ? e.message : String(e);
}

const monText = (s: string | undefined) => {
  const n = Number(s);
  return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 4 }) : (s ?? "");
};

/**
 * "Get 0.3 test MON for gas". `nativeWei` = the wallet's MON balance (null while unknown). With
 * `faucetFallback` (the caller is blocked on gas), a wallet the drip can't serve still gets the faucet link.
 */
export function GasDrip({
  address,
  nativeWei,
  faucetFallback = false,
}: {
  address: string | null;
  nativeWei: bigint | null;
  faucetFallback?: boolean;
}) {
  const drip = useParaclr((s) => s.chain.keeper.health?.drip ?? null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // A different wallet starts over.
  const [forAddress, setForAddress] = useState(address);
  if (forAddress !== address) {
    setForAddress(address);
    setPhase({ kind: "idle" });
  }

  // Poll the keeper until the transfer is mined (or failed), then refresh the balance.
  const polling = phase.kind === "queued" || phase.kind === "sending";
  useEffect(() => {
    if (!polling || !address) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await dripStatus(address);
        if (stop || !alive.current) return;
        apply(r);
      } catch {
        /* keeper blip: keep polling */
      }
    };
    const id = window.setInterval(() => void tick(), 1_500);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [polling, address]);

  function apply(r: DripResult) {
    if (r.status === "sent") {
      setPhase({ kind: "arrived", tx: r.txHash });
      void refreshAccount();
    } else if (r.status === "sending" && r.txHash) {
      setPhase({ kind: "sending", tx: r.txHash });
    } else if (r.status === "queued") {
      setPhase({ kind: "queued", position: r.position });
    } else if (r.status === "failed") {
      setPhase({ kind: "error", message: r.error ? `The transfer failed (${r.error}).` : "The transfer failed." });
    }
  }

  if (!NETWORK?.isTestnetProd || NETWORK.sandbox || !address) return null;
  const faucetOnly = faucetFallback ? (
    <p className={styles.fine}>
      Get testnet MON at{" "}
      <a href={MONAD_TESTNET_FAUCET_URL} target="_blank" rel="noreferrer">
        faucet.monad.xyz ↗
      </a>
    </p>
  ) : null;
  if (!drip?.enabled) return faucetOnly;
  let min: bigint;
  try {
    min = parseEther(drip.minBalance ?? "0.05");
  } catch {
    min = parseEther("0.05");
  }
  // Only for wallets that need it; once a drip is under way, keep showing its progress.
  if (phase.kind === "idle" && (nativeWei === null || nativeWei >= min)) return faucetOnly;
  // Don't offer a drip the keeper can't pay (its wallet is below one drip): the faucet hint stays.
  if (phase.kind === "idle" && !dripFunded(drip.walletBalance, drip.amount)) return faucetOnly;

  const amount = monText(drip.amount ?? "0.3");
  const request = async () => {
    setPhase({ kind: "requesting" });
    try {
      const r = await requestDrip(address);
      if (alive.current) apply(r);
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof KeeperError && e.code === "has_balance") void refreshAccount();
      setPhase({ kind: "error", message: errorText(e) });
    }
  };

  const busy = phase.kind === "requesting" || phase.kind === "queued" || phase.kind === "sending";
  return (
    <div className={styles.drip}>
      {(phase.kind === "idle" || phase.kind === "requesting" || phase.kind === "queued") && (
        <button type="button" className={styles.btnPrimary} disabled={busy} onClick={() => void request()}>
          {phase.kind === "requesting"
            ? "Requesting…"
            : phase.kind === "queued"
              ? `Queued${phase.position ? ` (#${phase.position})` : ""}, sending soon…`
              : `Get ${amount} test MON for gas`}
        </button>
      )}
      {phase.kind === "sending" && (
        <Notice tone="ok">
          Sent. It arrives in a few seconds. <TxLink hash={phase.tx} label="View transfer" />
        </Notice>
      )}
      {phase.kind === "arrived" && (
        <Notice tone="ok">
          {amount} test MON arrived{nativeWei !== null ? `: balance ${monText(formatEther(nativeWei))} MON` : ""}.{" "}
          {phase.tx && <TxLink hash={phase.tx} label="View transfer" />}
        </Notice>
      )}
      {phase.kind === "error" && (
        <Notice tone="warn">
          {phase.message}{" "}
          <a href={MONAD_TESTNET_FAUCET_URL} target="_blank" rel="noreferrer">
            Get testnet MON at faucet.monad.xyz ↗
          </a>
        </Notice>
      )}
      {phase.kind === "idle" && (
        <p className={styles.fine}>
          Free testnet MON from the Paraclr keeper, once per wallet (no value). Or use{" "}
          <a href={MONAD_TESTNET_FAUCET_URL} target="_blank" rel="noreferrer">
            faucet.monad.xyz ↗
          </a>
        </p>
      )}
    </div>
  );
}

function dripFunded(balance: string | null | undefined, amount: string | undefined): boolean {
  if (balance == null) return true; // unknown: let the keeper answer
  try {
    return parseEther(balance) >= parseEther(amount ?? "0.3");
  } catch {
    return true;
  }
}
