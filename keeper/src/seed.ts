// Synthetic cross-margin book for the flash-crash benchmark, put on chain with the demo-only
// ParaclrClearinghouseDemo.seedAccounts (owner pays the collateral; no per-account EOAs).
//
// The distribution mirrors the in-browser clearing sim (src/lib/engine/accounts.ts
// generateAccounts): 1–3 positions (MON 45% / SOL 30% / BTC 25%), ~60% long, leverage
// round(2 + 18·u²) (skewed low), margin 10^(1.8 + 2.4·u) AUSD (≈63 … 15,800), and a cross-margin
// buffer of 0.15 + 2.5·u^1.6 on top of posted margin. Positions open at the current mark.
// A Monte-Carlo of this book under a uniform −20% shock with 2.5% maintenance liquidates ≈20%
// of accounts (mostly the levered longs) — the same ballpark as the frontend simulation.

import { encodeAbiParameters, encodeFunctionData, getAddress, keccak256, maxUint256, type Address, type Hex } from "viem";
import { abis, MONAD_TX_GAS_LIMIT, type KeeperContext, type MarketRef } from "./context";
import { envBigInt } from "./env";
import { estimateLimit, waitForReceipt } from "./sender";

export interface SeedPosition {
  marketId: Hex;
  isLong: boolean;
  margin: bigint; // AUSD 1e6
  leverage: bigint;
}

export interface SeedAccount {
  account: Address;
  collateral: bigint; // AUSD 1e6
  positions: SeedPosition[];
}

export const SEED_PARAMS = {
  positionsPerAccount: "1 (55%) | 2 (34%) | 3 (11%)",
  marketMix: { "MON/AUSD": 0.45, "SOL/AUSD": 0.3, "BTC/AUSD": 0.25 },
  longShare: 0.6,
  leverage: "round(2 + 18·u²)  → 2..20x, median ≈ 6x",
  marginAusd: "10^(1.8 + 2.4·u)  → ≈63 … 15,849 AUSD per position",
  collateral: "Σmargin × (1 + 0.15 + 2.5·u^1.6)",
  entry: "current oracle mark (seedAccounts opens at mark)",
} as const;

/** mulberry32: tiny deterministic PRNG so `--seed N` reproduces the same book. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Keyless synthetic address: last 20 bytes of keccak("paraclr-bench", seed, i). */
export function benchAddress(seed: number, i: number): Address {
  const h = keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "uint256" }],
      ["paraclr-bench", BigInt(seed), BigInt(i)],
    ),
  );
  return getAddress(`0x${h.slice(26)}`);
}

export function generateBook(markets: MarketRef[], count: number, seed: number): SeedAccount[] {
  const rand = rng(seed);
  const weights = markets.map((m) => SEED_PARAMS.marketMix[m.symbol as keyof typeof SEED_PARAMS.marketMix] ?? 0.1);
  const pick = (exclude: Set<number>): number => {
    let total = 0;
    weights.forEach((w, i) => {
      if (!exclude.has(i)) total += w;
    });
    let r = rand() * total;
    for (let i = 0; i < weights.length; i++) {
      if (exclude.has(i)) continue;
      r -= weights[i];
      if (r <= 0) return i;
    }
    for (let i = weights.length - 1; i >= 0; i--) if (!exclude.has(i)) return i;
    return 0;
  };

  const book: SeedAccount[] = [];
  for (let i = 0; i < count; i++) {
    const nPos = Math.min(markets.length, rand() < 0.55 ? 1 : rand() < 0.75 ? 2 : 3);
    const used = new Set<number>();
    const positions: SeedPosition[] = [];
    let posted = 0;
    for (let p = 0; p < nPos; p++) {
      const mi = pick(used);
      used.add(mi);
      const isLong = rand() < 0.6;
      const leverage = Math.round(2 + 18 * Math.pow(rand(), 2));
      const margin = Math.round(Math.pow(10, 1.8 + 2.4 * rand()));
      positions.push({ marketId: markets[mi].id, isLong, margin: BigInt(margin) * BigInt(1e6), leverage: BigInt(leverage) });
      posted += margin;
    }
    const buffer = 0.15 + Math.pow(rand(), 1.6) * 2.5;
    book.push({
      account: benchAddress(seed, i),
      collateral: BigInt(Math.round(posted * (1 + buffer))) * BigInt(1e6),
      positions,
    });
  }
  return book;
}

export interface SeedTx {
  txHash: Hex;
  block: number;
  accounts: number;
  gasUsed: string;
  gasLimit: string;
}

function seedData(chunk: SeedAccount[]): Hex {
  return encodeFunctionData({
    abi: abis.clearinghouse,
    functionName: "seedAccounts",
    args: [chunk.map((a) => ({ account: a.account, collateral: a.collateral, positions: a.positions }))],
  });
}

/**
 * Seed `book` from the operator (= owner) key into `clearinghouse` (default: the lane-sharded
 * design; the bench seeds the naive design with the identical book too). Mints/approves the AUSD
 * it needs, then sends gas-capped chunks one at a time (sequential keeps in-flight fees inside
 * Monad's reserve budget).
 */
export async function seedBook(
  ctx: KeeperContext,
  book: SeedAccount[],
  log: (msg: string) => void = console.log,
  clearinghouse: Address = ctx.dep.clearinghouse,
): Promise<{ txs: SeedTx[]; totalCollateral: bigint; gasUsed: bigint; gasLimit: bigint }> {
  const { client, config } = ctx;
  const dep = { ausd: ctx.dep.ausd, clearinghouse };
  const op = ctx.senders.for(ctx.roles.operator);
  const wait = { pollMs: Math.max(config.receiptPollMs, 100), timeoutMs: config.receiptTimeoutMs };
  const total = book.reduce((s, a) => s + a.collateral, BigInt(0));

  const [bal, allowance] = await Promise.all([
    client.readContract({ address: dep.ausd, abi: abis.ausd, functionName: "balanceOf", args: [op.address] }),
    client.readContract({ address: dep.ausd, abi: abis.ausd, functionName: "allowance", args: [op.address, dep.clearinghouse] }),
  ]);
  const prep: Hex[] = [];
  if (bal < total) {
    const data = encodeFunctionData({ abi: abis.ausd, functionName: "ownerMint", args: [op.address, total - bal] });
    const { limit } = await estimateLimit(client, { account: op.address, to: dep.ausd, data }, config.gasMarginBps);
    prep.push((await op.send({ to: dep.ausd, data, gas: limit })).hash);
  }
  if (allowance < total) {
    const data = encodeFunctionData({ abi: abis.ausd, functionName: "approve", args: [dep.clearinghouse, maxUint256] });
    const { limit } = await estimateLimit(client, { account: op.address, to: dep.ausd, data }, config.gasMarginBps);
    prep.push((await op.send({ to: dep.ausd, data, gas: limit })).hash);
  }
  for (const h of prep) {
    const { receipt } = await waitForReceipt(client, h, wait);
    if (receipt.status !== "success") throw new Error(`AUSD mint/approve ${h} reverted`);
  }

  const txs: SeedTx[] = [];
  let gasUsed = BigInt(0);
  let gasLimitTotal = BigInt(0);
  let size = 20; // first chunk calibrates gas/account
  // Own knob so a tiny KEEPER_MAX_TX_GAS (to exercise lane-batch splitting) doesn't also force 1 account/seed tx.
  const cap = envBigInt("SEED_MAX_TX_GAS", MONAD_TX_GAS_LIMIT);
  for (let i = 0; i < book.length; ) {
    let chunk = book.slice(i, i + size);
    let data = seedData(chunk);
    let est = await estimateLimit(client, { account: op.address, to: dep.clearinghouse, data }, config.gasMarginBps);
    while (est.limit > cap && chunk.length > 1) {
      chunk = chunk.slice(0, Math.ceil(chunk.length / 2));
      data = seedData(chunk);
      est = await estimateLimit(client, { account: op.address, to: dep.clearinghouse, data }, config.gasMarginBps);
    }
    const sub = await op.send({ to: dep.clearinghouse, data, gas: est.limit });
    const { receipt } = await waitForReceipt(client, sub.hash, wait);
    if (receipt.status !== "success") throw new Error(`seedAccounts ${sub.hash} reverted`);
    txs.push({
      txHash: sub.hash,
      block: Number(receipt.blockNumber),
      accounts: chunk.length,
      gasUsed: receipt.gasUsed.toString(),
      gasLimit: est.limit.toString(),
    });
    gasUsed += receipt.gasUsed;
    gasLimitTotal += est.limit;
    i += chunk.length;
    log(`  seeded ${i}/${book.length} accounts (tx ${sub.hash.slice(0, 10)}…, ${receipt.gasUsed} gas, block ${receipt.blockNumber})`);
    // Re-size from measured gas/account, aiming at ~85% of the cap, at most 100 accounts/tx.
    const perAccount = Number(est.estimate) / chunk.length;
    size = Math.max(1, Math.min(100, Math.floor((Number(cap) * 0.85) / (perAccount * (1 + config.gasMarginBps / 10_000)))));
  }
  return { txs, totalCollateral: total, gasUsed, gasLimit: gasLimitTotal };
}

/**
 * Top up every lane's backstop pool of `clearinghouse` to `perLane` AUSD of cash (operator mints
 * and deposits the difference). In shared-state mode (the naive baseline) there is ONE pool, which
 * is topped up to 8 × perLane, so both designs get the same total backstop liquidity.
 */
export async function fundBackstopPools(
  ctx: KeeperContext,
  clearinghouse: Address,
  perLane: bigint,
  log: (msg: string) => void = console.log,
): Promise<Array<{ key: number; deposited: string; txHash: Hex }>> {
  const { client, config } = ctx;
  const op = ctx.senders.for(ctx.roles.operator);
  const wait = { pollMs: Math.max(config.receiptPollMs, 100), timeoutMs: config.receiptTimeoutMs };
  const shared = await client.readContract({ address: clearinghouse, abi: abis.clearinghouse, functionName: "sharedState" });
  const keys = shared ? [0] : Array.from({ length: 8 }, (_, i) => i);
  const target = shared ? perLane * BigInt(8) : perLane;
  const navs = await Promise.all(
    keys.map((k) => client.readContract({ address: clearinghouse, abi: abis.clearinghouse, functionName: "backstopNav", args: [k] })),
  );
  const todo = keys.map((k, i) => ({ k, need: target - navs[i][1] })).filter((t) => t.need > BigInt(0));
  if (todo.length === 0) return [];
  const total = todo.reduce((s, t) => s + t.need, BigInt(0));
  const [bal, allowance] = await Promise.all([
    client.readContract({ address: ctx.dep.ausd, abi: abis.ausd, functionName: "balanceOf", args: [op.address] }),
    client.readContract({ address: ctx.dep.ausd, abi: abis.ausd, functionName: "allowance", args: [op.address, clearinghouse] }),
  ]);
  const prep: Hex[] = [];
  if (bal < total) {
    const data = encodeFunctionData({ abi: abis.ausd, functionName: "ownerMint", args: [op.address, total - bal] });
    const { limit } = await estimateLimit(client, { account: op.address, to: ctx.dep.ausd, data }, config.gasMarginBps);
    prep.push((await op.send({ to: ctx.dep.ausd, data, gas: limit })).hash);
  }
  if (allowance < total) {
    const data = encodeFunctionData({ abi: abis.ausd, functionName: "approve", args: [clearinghouse, maxUint256] });
    const { limit } = await estimateLimit(client, { account: op.address, to: ctx.dep.ausd, data }, config.gasMarginBps);
    prep.push((await op.send({ to: ctx.dep.ausd, data, gas: limit })).hash);
  }
  for (const h of prep) {
    const { receipt } = await waitForReceipt(client, h, wait);
    if (receipt.status !== "success") throw new Error(`AUSD mint/approve ${h} reverted`);
  }
  const out: Array<{ key: number; deposited: string; txHash: Hex }> = [];
  for (const t of todo) {
    const data = encodeFunctionData({ abi: abis.clearinghouse, functionName: "backstopDeposit", args: [t.k, t.need] });
    const { limit } = await estimateLimit(client, { account: op.address, to: clearinghouse, data }, config.gasMarginBps);
    const sub = await op.send({ to: clearinghouse, data, gas: limit });
    const { receipt } = await waitForReceipt(client, sub.hash, wait);
    if (receipt.status !== "success") throw new Error(`backstopDeposit(${t.k}) ${sub.hash} reverted`);
    out.push({ key: t.k, deposited: t.need.toString(), txHash: sub.hash });
  }
  log(`  backstop ${shared ? "shared pool" : `${todo.length} lane pool(s)`} topped up: +${Number(total) / 1e6} AUSD`);
  return out;
}
