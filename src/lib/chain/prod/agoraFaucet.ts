"use client";

// Test AUSD for the production contracts on Monad testnet.
//
// Agora runs an AUSD faucet on Monad testnet, but only as a contract (its docs
// list the address and `requestFunds(recipient)`; there is no web page). So
// the wallet calls it directly: `requestFunds(your address)` sends 10,000
// test AUSD, at most once a minute across ALL callers, and only while the
// recipient holds less than 100,000. The amounts and limits are read from the
// contract, never assumed. Gas is testnet MON (faucet.monad.xyz).
//
// In the local sandbox (an anvil fork of Monad testnet) the same contract works
// on the forked state, and the sandbox keeper also runs its own faucet (gas +
// AUSD) - see requestSandboxFaucet().

import { useEffect, useState } from "react";
import { encodeFunctionData, erc20Abi, type Address } from "viem";
import { getState, useParaclr } from "../../store";
import { AGORA_AUSD_FAUCET_TESTNET, NETWORK } from "../config";
import { chainTimeNow, coalesce, publicClient, subscribeBlocks } from "../clients";
import { ChainActionError } from "../errors";
import type { LiveContracts } from "../runtime";
import { getSigner } from "../signer";
import { refreshAccount, requestFaucet } from "../trading";
import { sendTx, serialized } from "../txs";
import { ausdToNumber } from "../units";
import { agoraFaucetAbi } from "./abi";
import { readLoose } from "./state";

export interface AgoraFaucetState {
  address: Address;
  /** AUSD per drip. */
  drip: number | null;
  /** The faucet refuses recipients holding at least this much AUSD. */
  maxOwn: number | null;
  /** Seconds between drips (global, all callers). */
  every: number | null;
  /** Chain time (s) after which the next drip is allowed. */
  nextAt: number | null;
  /** Latest block timestamp (s) when read. */
  chainTime: number | null;
  /** When it was read (ms, local clock), to count the cooldown down between reads. */
  readAt: number;
  /** AUSD the faucet still holds. */
  balance: number | null;
  /** The faucet's token is this deployment's collateral. */
  tokenMatches: boolean;
}

/** Offered only on chain 10143 when the collateral is Agora's testnet AUSD. */
export function agoraFaucetAvailable(c: LiveContracts | null): boolean {
  return !!c && !!NETWORK?.isTestnetProd && c.token.testnet;
}

export async function readAgoraFaucet(c: LiveContracts): Promise<AgoraFaucetState> {
  const f = AGORA_AUSD_FAUCET_TESTNET as Address;
  const call = (functionName: string) => ({ address: f, abi: agoraFaucetAbi, functionName });
  const [res, head] = await Promise.all([
    readLoose([
      call("faucetDripAmount"),
      call("maxAmountToOwn"),
      call("maxDripFrequency"),
      call("lastDripTimestamp"),
      call("token"),
      { address: c.ausd, abi: erc20Abi, functionName: "balanceOf", args: [f] },
    ]).catch(() => null),
    // Chain time from the shared head; a direct read only before its first poll.
    chainTimeNow() !== null
      ? Promise.resolve({ timestamp: BigInt(Math.floor(chainTimeNow() as number)) })
      : publicClient()
          .getBlock({ blockTag: "latest" })
          .catch(() => null),
  ]);
  const big = (i: number) => {
    const r = res?.[i];
    return r && r.status === "success" && typeof r.result === "bigint" ? r.result : null;
  };
  const tokenR = res?.[4];
  const token = tokenR && tokenR.status === "success" && typeof tokenR.result === "string" ? tokenR.result : null;
  const every = big(2);
  const last = big(3);
  return {
    address: f,
    drip: big(0) === null ? null : ausdToNumber(big(0)!),
    maxOwn: big(1) === null ? null : ausdToNumber(big(1)!),
    every: every === null ? null : Number(every),
    nextAt: every !== null && last !== null ? Number(last + every) : null,
    chainTime: head ? Number(head.timestamp) : null,
    readAt: Date.now(),
    balance: big(5) === null ? null : ausdToNumber(big(5)!),
    tokenMatches: token !== null && token.toLowerCase() === c.ausd.toLowerCase(),
  };
}

/** Faucet limits + cooldown, re-read on new blocks (throttled) while `enabled`. */
export function useAgoraFaucet(enabled: boolean): AgoraFaucetState | null {
  const contracts = useParaclr((s) => (s.chain.status === "ready" ? s.chain.contracts : null));
  const on = enabled && agoraFaucetAvailable(contracts);
  const [state, setState] = useState<AgoraFaucetState | null>(null);
  useEffect(() => {
    if (!on || !contracts) return;
    let cancelled = false;
    const load = coalesce(async () => {
      const s = await readAgoraFaucet(contracts).catch(() => null);
      if (!cancelled && s) setState(s);
    }, 3_000);
    load();
    const off = subscribeBlocks(() => load());
    return () => {
      cancelled = true;
      off();
    };
  }, [on, contracts]);
  return on ? state : null;
}

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/**
 * Call Agora's faucet from the signed-in wallet: `requestFunds(self)`. The
 * transaction is simulated first, so a cooldown or the holding limit comes
 * back as a readable reason before anything is signed.
 */
export function claimTestAusd(): Promise<number> {
  return serialized(async () => {
    const s = getState();
    const c = s.chain.contracts;
    if (s.chain.status !== "ready" || !c) throw new ChainActionError("Chain not connected.");
    if (!agoraFaucetAvailable(c)) throw new ChainActionError("Agora's AUSD faucet is only on Monad testnet.");
    const signer = getSigner();
    if (!signer || !s.chain.wallet.ready) throw new ChainActionError("Wallet not ready yet; try again in a moment.");
    const f = await readAgoraFaucet(c);
    if (!f.tokenMatches) {
      throw new ChainActionError("Agora's faucet pays out a different token than this deployment's collateral.");
    }
    const before = s.chain.account?.walletAusd ?? null;
    if (f.maxOwn !== null && before !== null && before >= f.maxOwn) {
      throw new ChainActionError(`Agora's faucet only tops up wallets holding less than ${fmt(f.maxOwn)} AUSD.`);
    }
    // The once-a-minute cooldown is left to the simulation in sendTx (it decodes
    // MaxFrequencyExceeded into a readable reason): the latest block's timestamp
    // lags the wall clock on an idle local fork, so a pre-check here could refuse
    // a claim the next block would accept.
    await sendTx(signer, {
      label: `Claim ${f.drip !== null ? fmt(f.drip) : ""} test AUSD from Agora's faucet`.replace("  ", " "),
      to: f.address,
      data: encodeFunctionData({ abi: agoraFaucetAbi, functionName: "requestFunds", args: [signer.address] }),
    });
    const snap = await refreshAccount();
    return snap && before !== null ? Math.max(0, snap.walletAusd - before) : (f.drip ?? 0);
  });
}

/**
 * Local sandbox only: the sandbox keeper's faucet (test MON for gas + AUSD on
 * the fork). Never offered against a real network.
 */
export function requestSandboxFaucet(): Promise<void> {
  const address = getState().session?.address as Address | undefined;
  if (!NETWORK?.sandbox) return Promise.reject(new ChainActionError("The sandbox faucet exists only in the local sandbox."));
  if (!address) return Promise.reject(new ChainActionError("Sign in first."));
  return requestFaucet(address, { onlyIfLow: false });
}
