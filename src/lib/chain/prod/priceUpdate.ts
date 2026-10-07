// Pyth price data for production calls that take a `priceUpdate`
// (withdraw, cancelAuction, take, backstopDeposit / backstopWithdraw).
//
// Every state-changing call prices a market with the newest of: the update we
// send, the Pyth-stored price and the price this lane last used (both of the
// latter only while younger than `maxStoredPriceAge`, 15 s on v4). On Monad
// mainnet the stored price is pushed irregularly, so:
//   1. if, for every listed market (the deployment's, see LiveContracts.listed), the newer of the stored and the lane price
//      is younger than storedFreshThreshold() (70% of `maxStoredPriceAge`)
//      → send `[]` (no fee, no network round trip);
//   2. otherwise fetch Hermes "latest" for ALL listed feeds (partial updates are
//      fine for the contract; one request is simpler) from the keeper's
//      `/hermes` proxy — or NEXT_PUBLIC_PYTH_HERMES_URL if set — and attach it
//      with `msg.value = IPyth.getUpdateFee(update)` (0 on Monad today, but read);
//   3. proxy unreachable and those prices too old → "Prices are refreshing —
//      retry in a few seconds."
//
// The proxy holds the Pyth API key server-side; the browser never sees it.
// The update data is Pyth's Wormhole-signed accumulator payload and is
// verified by the Pyth contract on chain, so the proxy cannot forge or alter a
// price — it can only withhold one (then step 3 applies).

import type { Address, Hex } from "viem";
import type { MarketSymbol } from "../../types";
import { getState } from "../../store";
import { publicClient } from "../clients";
import { NETWORK, PYTH_HERMES_URL } from "../config";
import { ChainActionError } from "../errors";
import type { LiveContracts } from "../runtime";
import { prodAbi, pythAbi } from "./abi";
import { readLoose } from "./state";

const DEFAULT_MAX_STORED_AGE_S = 15;

/** The contract's `maxStoredPriceAge()` (s): how old a stored / lane price may be for a `[]` call. */
function maxStoredAge(): number {
  return getState().chain.prod?.params.maxStoredPriceAge ?? DEFAULT_MAX_STORED_AGE_S;
}

/**
 * Stored / lane prices younger than this are used as-is: 70% of
 * `maxStoredPriceAge`, leaving room for the block or two until the tx lands
 * (15 s → 10 s).
 */
export function storedFreshThreshold(maxAge: number = maxStoredAge()): number {
  return Math.max(3, Math.floor(maxAge * 0.7));
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
  return c.listed.map((m) => c.pythFeeds[m]).filter((x): x is Hex => !!x);
}

/**
 * Age (s), at the latest block, of the oldest usable price across every listed
 * market, where a market's price is the newer of the Pyth-stored price and the
 * price `lane` last used (`lanePrice`), when a lane is given.
 */
export async function oldestStoredAge(c: LiveContracts, lane: number | null = null): Promise<number | null> {
  const listed = c.listed;
  const calls = listed.map((m: MarketSymbol) => ({
    address: c.clearinghouse,
    abi: prodAbi,
    functionName: "latestPrice",
    args: [c.markets[m]] as readonly unknown[],
  }));
  if (lane !== null) {
    listed.forEach((m) =>
      calls.push({ address: c.clearinghouse, abi: prodAbi, functionName: "lanePrice", args: [lane, c.markets[m]] }),
    );
  }
  const [res, head] = await Promise.all([
    readLoose(calls),
    publicClient()
      .getBlock({ blockTag: "latest" })
      .catch(() => null),
  ]);
  if (!head) return null;
  const now = Number(head.timestamp);
  let oldest = 0;
  for (let i = 0; i < listed.length; i++) {
    const stored = res[i];
    const lanePx = lane !== null ? res[i + listed.length] : undefined;
    const t = (r: typeof stored | undefined, idx: number) =>
      r && r.status === "success" && Array.isArray(r.result) ? Number((r.result as readonly bigint[])[idx]) : 0;
    const newest = Math.max(t(stored, 2), t(lanePx, 1));
    // No usable price at all counts as infinitely old.
    if (newest === 0) return Number.POSITIVE_INFINITY;
    oldest = Math.max(oldest, now - newest);
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
 * false when the call prices nothing (e.g. a withdrawal with no positions);
 * `lane` is the lane whose last-used prices also count (the caller's, or the
 * pool's). Throws ChainActionError(REFRESHING) when no usable price exists.
 */
export async function priceUpdateFor(c: LiveContracts, needed: boolean, lane: number | null = null): Promise<PriceUpdate> {
  if (!needed) return { updateData: [], fee: BigInt(0), source: "none", storedAge: null };
  const age = await oldestStoredAge(c, lane).catch(() => null);
  if (age !== null && age < storedFreshThreshold()) {
    return { updateData: [], fee: BigInt(0), source: "stored", storedAge: age };
  }
  try {
    const updateData = await fetchLatestUpdate(c);
    const fee = await pythUpdateFee(c, updateData);
    return { updateData, fee, source: "fresh", storedAge: age };
  } catch {
    // Proxy down: the stored / lane prices still work while they're within the contract's limit.
    if (age !== null && age < maxStoredAge() - 2) return { updateData: [], fee: BigInt(0), source: "stored", storedAge: age };
    throw new ChainActionError(REFRESHING);
  }
}
