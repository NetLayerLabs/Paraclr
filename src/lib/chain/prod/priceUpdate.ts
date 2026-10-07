// Pyth price data for production calls that take a `priceUpdate`
// (withdraw, cancelAuction, take, backstopDeposit / backstopWithdraw).
//
// On Monad mainnet the Pyth price *stored* on chain is pushed irregularly (seen
// up to ~2 min old at random blocks) while the contract accepts at most
// `maxPriceAge` (60 s). So:
//   1. every listed feed's stored price younger than storedFreshThreshold()
//      (70% of the contract's maxPriceAge) → send `[]`
//      (no fee, no network round trip);
//   2. otherwise fetch Hermes "latest" for ALL listed feeds (the contract
//      rejects a partial update) from the keeper's `/hermes` proxy — or
//      NEXT_PUBLIC_PYTH_HERMES_URL if set — and attach it with
//      `msg.value = IPyth.getUpdateFee(update)` (0 on Monad today, but read);
//   3. proxy unreachable and the stored price too old → "Prices are
//      refreshing — retry in a few seconds."
//
// The proxy holds the Pyth API key server-side; the browser never sees it.
// The update data is Pyth's Wormhole-signed accumulator payload and is
// verified by the Pyth contract on chain, so the proxy cannot forge or alter a
// price — it can only withhold one (then step 3 applies).

import type { Address, Hex } from "viem";
import { MARKETS, type MarketSymbol } from "../../types";
import { getState } from "../../store";
import { publicClient } from "../clients";
import { NETWORK, PYTH_HERMES_URL } from "../config";
import { ChainActionError } from "../errors";
import type { LiveContracts } from "../runtime";
import { prodAbi, pythAbi } from "./abi";
import { readLoose } from "./state";

const DEFAULT_MAX_PRICE_AGE_S = 60;

/** The contract's `maxPriceAge` (s), from the production state read. */
function maxPriceAge(): number {
  return getState().chain.prod?.params.maxPriceAge ?? DEFAULT_MAX_PRICE_AGE_S;
}

/**
 * Stored prices younger than this are used as-is: 70% of the contract's
 * `maxPriceAge`, leaving room for the block or two until the tx lands
 * (60 s → 42 s; 15 s → 10 s).
 */
export function storedFreshThreshold(maxAge: number = maxPriceAge()): number {
  return Math.max(5, Math.floor(maxAge * 0.7));
}

export const REFRESHING = "Prices are refreshing — retry in a few seconds.";

/** Hermes-compatible base for update data: an explicit override, else the keeper's proxy. */
export function updateBaseUrl(): string | null {
  if (PYTH_HERMES_URL) return PYTH_HERMES_URL;
  return NETWORK ? `${NETWORK.keeperUrl}/hermes` : null;
}

export interface PriceUpdate {
  updateData: Hex[];
  /** Native wei to attach (IPyth.getUpdateFee). */
  fee: bigint;
  /**
   * none    nothing needs pricing
   * stored  the on-chain Pyth prices are fresh enough: `[]` is sent
   * fresh   a signed update from the proxy is attached
   */
  source: "none" | "stored" | "fresh";
  /** Oldest stored price (s) among the listed feeds when checked. */
  storedAge: number | null;
}

function allFeeds(c: LiveContracts): Hex[] {
  return MARKETS.map((m) => c.pythFeeds[m]).filter((x): x is Hex => !!x);
}

/** Age (s) of the oldest Pyth price stored on chain across every listed market, at the latest block. */
export async function oldestStoredAge(c: LiveContracts): Promise<number | null> {
  const [res, head] = await Promise.all([
    readLoose(
      MARKETS.map((m: MarketSymbol) => ({
        address: c.clearinghouse,
        abi: prodAbi,
        functionName: "latestPrice",
        args: [c.markets[m]],
      })),
    ),
    publicClient()
      .getBlock({ blockTag: "latest" })
      .catch(() => null),
  ]);
  if (!head) return null;
  let oldest = 0;
  for (const r of res) {
    // An unreadable stored price counts as infinitely old.
    if (r.status !== "success" || !Array.isArray(r.result)) return Number.POSITIVE_INFINITY;
    const publishTime = Number((r.result as readonly bigint[])[2]);
    oldest = Math.max(oldest, Number(head.timestamp) - publishTime);
  }
  return oldest;
}

/** Hermes "latest" for every listed feed, through the proxy. Throws on any failure. */
export async function fetchLatestUpdate(c: LiveContracts, timeoutMs = 6_000): Promise<Hex[]> {
  const base = updateBaseUrl();
  const ids = allFeeds(c);
  if (!base || ids.length === 0) throw new Error("no Pyth update source configured");
  const q = ids.map((id) => `ids[]=${id}`).join("&");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/v2/updates/price/latest?${q}&encoding=hex&parsed=true`, {
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { binary?: { data?: string[] } };
    const data = (body.binary?.data ?? []).map((d) => (d.startsWith("0x") ? d : `0x${d}`) as Hex);
    if (data.length === 0) throw new Error("empty update");
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** IPyth.getUpdateFee(update) — 0 on Monad today, but always read. */
export async function pythUpdateFee(c: LiveContracts, updateData: Hex[]): Promise<bigint> {
  if (updateData.length === 0) return BigInt(0);
  if (!c.pyth) throw new ChainActionError("Pyth contract address unknown — can't price the update fee.");
  return publicClient().readContract({
    address: c.pyth as Address,
    abi: pythAbi,
    functionName: "getUpdateFee",
    args: [updateData],
  });
}

/**
 * The `priceUpdate` (and `msg.value`) for one production call. `needed` is
 * false when the call prices nothing (e.g. a withdrawal with no positions).
 * Throws ChainActionError(REFRESHING) when no usable price is available.
 */
export async function priceUpdateFor(c: LiveContracts, needed: boolean): Promise<PriceUpdate> {
  if (!needed) return { updateData: [], fee: BigInt(0), source: "none", storedAge: null };
  const age = await oldestStoredAge(c).catch(() => null);
  if (age !== null && age < storedFreshThreshold()) {
    return { updateData: [], fee: BigInt(0), source: "stored", storedAge: age };
  }
  try {
    const updateData = await fetchLatestUpdate(c);
    const fee = await pythUpdateFee(c, updateData);
    return { updateData, fee, source: "fresh", storedAge: age };
  } catch {
    // Proxy down: the stored prices still work while they're within the contract's limit.
    if (age !== null && age < maxPriceAge() - 2) return { updateData: [], fee: BigInt(0), source: "stored", storedAge: age };
    throw new ChainActionError(REFRESHING);
  }
}
