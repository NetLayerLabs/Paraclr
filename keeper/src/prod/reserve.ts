// Monad reserve balance (docs.monad.xyz/developer-essentials/reserve-balance, read 2026-10-07).
//
// At execution time, for the SENDER of a transaction "the ending balance may be lower [than
// min(balance at transaction start, 10 MON)] by at most the transaction's gas spend", unless the
// transaction is an "emptying" one: the sender is undelegated and sent no other transaction in
// the past k = 3 blocks. So a key holding LESS than 10 MON (+ the value) can send a transaction
// that carries VALUE only as its first transaction in 3 blocks; otherwise it reverts (and still
// pays gas).
//
// Mainnet's Pyth fee is 0, so keeper transactions carry no value and this never applies there.
// Monad TESTNET's Pyth charges 1 wei per update message (verified 2026-10-07), so every
// executeOrder / auction / push carries a few wei: lane keepers below 10 MON must space their
// value-carrying transactions ≥ 3 blocks after their previous transaction. The guard does exactly
// that, per key, and only when the key is below the reserve (no cost when it holds ≥ 10 MON):
// it waits for the key's previous transaction to be mined and then for 3 more blocks (~1.2–2 s).
//
//   MONAD_RESERVE_GUARD  auto (default: on for a real Monad chain, off on anvil) | 1 | 0
//   MONAD_RESERVE_MON    10   (user_reserve_balance)

import type { Address } from "viem";
import { envStr } from "../env";
import { envNum, type Client } from "./config";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ReserveGuard {
  readonly enabled: boolean;
  readonly reserveWei: bigint;
  readonly k = 3;
  /** Block of each key's most recent transaction (a promise: it may still be in flight). */
  private readonly last = new Map<string, Promise<bigint | null>>();
  private readonly locks = new Map<string, Promise<void>>();
  stats = { spaced: 0, waitedMs: 0, passedAboveReserve: 0 };

  constructor(
    private readonly client: Client,
    isFork: boolean,
  ) {
    const mode = (envStr("MONAD_RESERVE_GUARD") ?? "auto").toLowerCase();
    this.enabled = mode === "auto" ? !isFork : !["0", "off", "false", "no"].includes(mode);
    this.reserveWei = BigInt(Math.round(envNum("MONAD_RESERVE_MON", 10) * 1e6)) * BigInt(1e12);
  }

  /**
   * Send through the guard. `send` must return the tx's mined block as a promise (null if lost).
   * Sends from one key are serialised through the guard; other keys are independent.
   */
  async send<T extends { block: Promise<bigint | null> }>(from: Address, value: bigint, maxCostWei: bigint, send: () => Promise<T>): Promise<T> {
    if (!this.enabled) return send();
    const key = from.toLowerCase();
    const before = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.locks.set(key, before.then(() => mine));
    await before;
    try {
      if (value > BigInt(0)) {
        const bal = await this.client.getBalance({ address: from });
        if (bal < this.reserveWei + value + maxCostWei) await this.spaceAfterPrevious(key);
        else this.stats.passedAboveReserve++;
      }
      const out = await send();
      this.last.set(key, out.block.catch(() => null));
      return out;
    } finally {
      release();
    }
  }

  /** Record a transaction sent outside the guard (so the next guarded one spaces after it). */
  note(from: Address, block: Promise<bigint | null>): void {
    this.last.set(from.toLowerCase(), block.catch(() => null));
  }

  private async spaceAfterPrevious(key: string): Promise<void> {
    const prev = this.last.get(key);
    if (!prev) return; // no transaction from this key since the keeper started (≥ 3 blocks ago in practice)
    const t0 = Date.now();
    let block = await Promise.race([prev, sleep(60_000).then(() => null)]);
    if (block === null) block = await this.client.getBlockNumber(); // lost / unknown: count from now
    while ((await this.client.getBlockNumber()) < block + BigInt(this.k)) await sleep(150);
    this.stats.spaced++;
    this.stats.waitedMs += Date.now() - t0;
  }

  status() {
    return { enabled: this.enabled, reserveMon: Number(this.reserveWei / BigInt(1e12)) / 1e6, k: this.k, ...this.stats };
  }
}
