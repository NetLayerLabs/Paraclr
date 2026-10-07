"use client";

// Transaction lifecycle: simulate (readable revert) → sign → pending →
// confirmed/failed, tracked in a tiny store the UI renders as a tray.
// Writes from one signer are serialized so nonces never collide.

import { useSyncExternalStore } from "react";
import type { Address, Hex, TransactionReceipt } from "viem";
import { publicClient } from "./clients";
import { NETWORK } from "./config";
import { ChainActionError, readableError } from "./errors";
import type { ChainSigner } from "./signer";

export type TxStatus = "simulating" | "signing" | "pending" | "confirmed" | "failed";

export interface TrackedTx {
  id: number;
  label: string;
  status: TxStatus;
  hash: Hex | null;
  block: number | null;
  error: string | null;
  startedAt: number;
  sentAt: number | null;
  confirmedAt: number | null;
  gasUsed: bigint | null;
}

let txs: TrackedTx[] = [];
const EMPTY: TrackedTx[] = [];
const listeners = new Set<() => void>();
let nextId = 1;

function emit() {
  listeners.forEach((l) => l());
}

function add(label: string): TrackedTx {
  const tx: TrackedTx = {
    id: nextId++,
    label,
    status: "simulating",
    hash: null,
    block: null,
    error: null,
    startedAt: Date.now(),
    sentAt: null,
    confirmedAt: null,
    gasUsed: null,
  };
  txs = [...txs, tx].slice(-8);
  emit();
  return tx;
}

function update(id: number, patch: Partial<TrackedTx>) {
  txs = txs.map((t) => (t.id === id ? { ...t, ...patch } : t));
  emit();
}

export function dismissTx(id: number) {
  txs = txs.filter((t) => t.id !== id);
  emit();
}

export function clearTxs() {
  txs = [];
  emit();
}

/** Non-hook snapshot (debugging / scripts). */
export function getTxs(): TrackedTx[] {
  return txs;
}

export function useTxs(): TrackedTx[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => txs,
    () => EMPTY,
  );
}

// ---- sending -----------------------------------------------------------------

let queue: Promise<unknown> = Promise.resolve();

/** Run `fn` after every previously queued write has finished. */
export function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

export interface TxRequest {
  label: string;
  to: Address;
  data: Hex;
  /** Native value (wei): order execution fee, Pyth update fee. */
  value?: bigint;
}

/** Monad bills the gas *limit*, so keep the margin over the estimate small. */
const GAS_MARGIN_PCT = BigInt(115);

// ---- Monad reserve balance ------------------------------------------------------
// docs.monad.xyz "Reserve Balance": an account holding under 10 MON may send a
// transaction that carries MON (`commitOrder`'s execution fee, a Pyth update fee
// — 1 wei per message on testnet) only as its first transaction in 3 blocks.
// So such a transaction waits until 3 blocks have passed since this account's
// previous one (≈ 1.2–2 s). Only on a real Monad chain (anvil doesn't enforce it).

const RESERVE_WEI = BigInt(10) * BigInt(10) ** BigInt(18);
const RESERVE_BLOCKS = BigInt(3);
const lastTxBlock = new Map<string, bigint>();
const RESERVE_HINT =
  "Monad's reserve-balance rule: with under 10 MON, a transaction carrying MON must be your first in 3 blocks. Wait a moment and retry.";

/** A MON-carrying tx from an account holding under 10 MON, on a real Monad chain. */
async function reserveRuleApplies(account: Address, value: bigint | undefined): Promise<boolean> {
  if (!NETWORK?.isMonad || !value || value <= BigInt(0)) return false;
  return (await publicClient().getBalance({ address: account }).catch(() => RESERVE_WEI)) < RESERVE_WEI;
}

async function waitForReserveRule(account: Address, value: bigint | undefined): Promise<boolean> {
  const last = lastTxBlock.get(account.toLowerCase());
  if (last === undefined || !(await reserveRuleApplies(account, value))) return false;
  const pc = publicClient();
  for (let i = 0; i < 40; i++) {
    if ((await pc.getBlockNumber()) >= last + RESERVE_BLOCKS) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  return true;
}

/**
 * Simulate, estimate, send and wait for one transaction. Throws a
 * ChainActionError with a readable reason on any failure (also recorded on the
 * tracked tx).
 */
export async function sendTx(signer: ChainSigner, req: TxRequest): Promise<TransactionReceipt> {
  const pc = publicClient();
  const tx = add(req.label);
  let spaced = false;
  try {
    spaced = await waitForReserveRule(signer.address, req.value).catch(() => false);
    // eth_call first: reverts come back with data we can decode into words.
    await pc.call({ account: signer.address, to: req.to, data: req.data, value: req.value });
    const estimate = await pc.estimateGas({ account: signer.address, to: req.to, data: req.data, value: req.value });
    const gas = (estimate * GAS_MARGIN_PCT) / BigInt(100);

    update(tx.id, { status: "signing" });
    const wc = await signer.walletClient();
    const hash = await wc.sendTransaction({
      account: wc.account,
      chain: wc.chain,
      to: req.to,
      data: req.data,
      value: req.value,
      gas,
    });
    update(tx.id, { status: "pending", hash, sentAt: Date.now() });

    const receipt = await pc.waitForTransactionReceipt({ hash, pollingInterval: 250, timeout: 90_000 });
    lastTxBlock.set(signer.address.toLowerCase(), receipt.blockNumber);
    if (receipt.status !== "success") {
      throw new ChainActionError(
        `Reverted on-chain in block #${receipt.blockNumber} (gas used ${receipt.gasUsed} of ${gas}).` +
          (!spaced && (await reserveRuleApplies(signer.address, req.value)) ? ` ${RESERVE_HINT}` : ""),
      );
    }
    update(tx.id, {
      status: "confirmed",
      block: Number(receipt.blockNumber),
      confirmedAt: Date.now(),
      gasUsed: receipt.gasUsed,
    });
    return receipt;
  } catch (e) {
    const message = readableError(e);
    update(tx.id, { status: "failed", error: message });
    throw e instanceof ChainActionError ? e : new ChainActionError(message, e);
  }
}

/** Track a transaction someone else sent (e.g. the keeper faucet). */
export async function trackExternalTx(label: string, hash: Hex): Promise<TransactionReceipt | null> {
  const tx = add(label);
  update(tx.id, { status: "pending", hash, sentAt: Date.now() });
  try {
    const receipt = await publicClient().waitForTransactionReceipt({ hash, pollingInterval: 250, timeout: 90_000 });
    update(tx.id, {
      status: receipt.status === "success" ? "confirmed" : "failed",
      block: Number(receipt.blockNumber),
      confirmedAt: Date.now(),
      gasUsed: receipt.gasUsed,
      error: receipt.status === "success" ? null : "Reverted on-chain",
    });
    return receipt;
  } catch (e) {
    update(tx.id, { status: "failed", error: readableError(e) });
    return null;
  }
}
