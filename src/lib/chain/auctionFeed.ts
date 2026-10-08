"use client";

// Live auction lifecycle, straight from the clearinghouse's events.
//
// While at least one component subscribes, every new block costs one
// eth_getLogs (AuctionStarted / Taken / Cancelled / Expired since the last
// block seen). On subscribe, auctions already running are loaded with
// getAuctionAccounts + auctionOf. The discount of an active auction is not
// polled: it is the contract's own clock, min(MAX, STEP × (block − start)),
// evaluated at the latest block.

import { useEffect, useSyncExternalStore } from "react";
import { formatLog, pad, parseEventLogs, toEventSelector, toHex, type Address, type Hex } from "viem";
import { useParaclr } from "../store";
import { getLatestBlock, publicClient, subscribeBlocks } from "./clients";
import { readableError } from "./errors";
import { isMissingFunction, readActiveAuctions, readAuctionStates, signedAusd } from "./fair";
import { fairAbi } from "./fairAbi";
import { ausdToNumber } from "./units";

export type AuctionStatus = "active" | "backstop" | "external" | "cured" | "expired";

export interface AuctionRecord {
  account: string; // lowercase
  lane: number;
  startBlock: number;
  /** Equity / notional when the auction started (AUSD); null if it started before we watched. */
  equity: number | null;
  notional: number | null;
  status: AuctionStatus;
  resolvedBlock: number | null;
  /** Discount at take / expiry. */
  discountBps: number | null;
  taker: string | null;
  traderResidual: number | null;
  payment: number | null;
  badDebt: number;
  txHash: Hex | null;
}

export interface AuctionFeedState {
  status: "idle" | "loading" | "live" | "unsupported" | "error";
  error: string | null;
  /** Latest block applied. */
  block: number | null;
  records: ReadonlyMap<string, AuctionRecord>;
  /** Browser time each block was first applied (ms epoch) - replay pacing only. */
  blockSeenAt: ReadonlyMap<number, number>;
}

const AUCTION_EVENTS = fairAbi.filter(
  (x) =>
    x.type === "event" &&
    (x.name === "AuctionStarted" || x.name === "AuctionTaken" || x.name === "AuctionCancelled" || x.name === "AuctionExpired"),
);

const EMPTY: AuctionFeedState = {
  status: "idle",
  error: null,
  block: null,
  records: new Map(),
  blockSeenAt: new Map(),
};
/** Max blocks per eth_getLogs (public RPCs cap the range). */
const MAX_RANGE = 100;

let state: AuctionFeedState = EMPTY;
const listeners = new Set<() => void>();
let refs = 0;
let stop: (() => void) | null = null;
let watching: Address | null = null;

function set(patch: Partial<AuctionFeedState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function getAuctionFeed(): AuctionFeedState {
  return state;
}

/** Forget resolved auctions (e.g. after "Recover market"); active ones stay. */
export function clearResolvedAuctions() {
  const next = new Map<string, AuctionRecord>();
  for (const [k, r] of state.records) if (r.status === "active") next.set(k, r);
  set({ records: next });
}

type DecodedLog = {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint | null;
  transactionHash: Hex | null;
  logIndex: number | null;
};

function applyLogs(logs: DecodedLog[], records: Map<string, AuctionRecord>) {
  logs.sort((a, b) => Number((a.blockNumber ?? BigInt(0)) - (b.blockNumber ?? BigInt(0))) || (a.logIndex ?? 0) - (b.logIndex ?? 0));
  for (const log of logs) {
    const a = log.args;
    const account = String(a.account ?? "").toLowerCase();
    if (!account) continue;
    const block = Number(log.blockNumber ?? BigInt(0));
    const lane = Number(a.lane ?? 0);
    const prev = records.get(account);
    const base: AuctionRecord = prev ?? {
      account,
      lane,
      startBlock: block,
      equity: null,
      notional: null,
      status: "active",
      resolvedBlock: null,
      discountBps: null,
      taker: null,
      traderResidual: null,
      payment: null,
      badDebt: 0,
      txHash: null,
    };
    switch (log.eventName) {
      case "AuctionStarted":
        records.set(account, {
          ...base,
          lane,
          startBlock: Number(a.startBlock ?? BigInt(block)),
          equity: typeof a.equity === "bigint" ? signedAusd(a.equity) : null,
          notional: typeof a.notional === "bigint" ? ausdToNumber(a.notional) : null,
          status: "active",
          resolvedBlock: null,
          discountBps: null,
          taker: null,
          traderResidual: null,
          payment: null,
          badDebt: 0,
          txHash: null,
        });
        break;
      case "AuctionTaken": {
        const elapsed = Number(a.blocksElapsed ?? BigInt(0));
        records.set(account, {
          ...base,
          lane,
          startBlock: prev ? base.startBlock : block - elapsed,
          notional: typeof a.notional === "bigint" ? ausdToNumber(a.notional) : base.notional,
          status: a.backstop ? "backstop" : "external",
          resolvedBlock: block,
          discountBps: Number(a.discountBps ?? 0),
          taker: String(a.taker ?? "").toLowerCase() || null,
          traderResidual: typeof a.traderResidual === "bigint" ? ausdToNumber(a.traderResidual) : null,
          payment: typeof a.payment === "bigint" ? ausdToNumber(a.payment) : null,
          badDebt: typeof a.badDebt === "bigint" ? ausdToNumber(a.badDebt) : 0,
          txHash: log.transactionHash,
        });
        break;
      }
      case "AuctionCancelled":
        records.set(account, { ...base, lane, status: "cured", resolvedBlock: block, txHash: log.transactionHash });
        break;
      case "AuctionExpired":
        records.set(account, {
          ...base,
          lane,
          status: "expired",
          resolvedBlock: block,
          badDebt: typeof a.badDebt === "bigint" ? ausdToNumber(a.badDebt) : 0,
          txHash: log.transactionHash,
        });
        break;
    }
  }
}

async function fetchLogs(address: Address, fromBlock: bigint, toBlock: bigint): Promise<DecodedLog[]> {
  const logs = await publicClient().getLogs({ address, events: AUCTION_EVENTS, fromBlock, toBlock, strict: false });
  return logs as unknown as DecodedLog[];
}

/** Gap (blocks) beyond which a resumed feed reloads instead of replaying logs. */
const MAX_RESUME = 2_000;
let lastAddress: Address | null = null;

function emptyRecord(account: string, lane: number, startBlock: number): AuctionRecord {
  return {
    account,
    lane,
    startBlock,
    equity: null,
    notional: null,
    status: "active",
    resolvedBlock: null,
    discountBps: null,
    taker: null,
    traderResidual: null,
    payment: null,
    badDebt: 0,
    txHash: null,
  };
}

function start(address: Address) {
  let cancelled = false;
  let busy = false;
  let pending: bigint | null = null;
  let last: bigint | null = null;
  watching = address;

  const init = async () => {
    try {
      const head = getLatestBlock() ?? (await publicClient().getBlockNumber());
      const lanes = await readActiveAuctions(address);
      const all = lanes.flatMap((l) => l.accounts);
      const states = await readAuctionStates(address, all);
      if (cancelled) return;
      const records = new Map<string, AuctionRecord>();
      for (const l of lanes) {
        for (const account of l.accounts) {
          const st = states.get(account);
          if (st?.active) records.set(account, emptyRecord(account, l.lane, st.startBlock));
        }
      }
      last = head;
      set({ status: "live", error: null, block: Number(head), records, blockSeenAt: new Map([[Number(head), Date.now()]]) });
      if (pending !== null) void step(pending);
    } catch (e) {
      if (cancelled) return;
      if (isMissingFunction(e)) set({ status: "unsupported", error: null });
      else set({ status: "error", error: readableError(e) });
    }
  };

  const step = async (head: bigint) => {
    if (busy || last === null) {
      pending = head;
      return;
    }
    if (head <= last) return;
    busy = true;
    pending = null;
    try {
      const logs: DecodedLog[] = [];
      let from = head - last > BigInt(MAX_RESUME) ? head - BigInt(MAX_RESUME) : last + BigInt(1);
      while (from <= head) {
        const to = from + BigInt(MAX_RANGE - 1) < head ? from + BigInt(MAX_RANGE - 1) : head;
        logs.push(...(await fetchLogs(address, from, to)));
        if (cancelled) return;
        from = to + BigInt(1);
      }
      last = head;
      const records = logs.length ? new Map(state.records) : (state.records as Map<string, AuctionRecord>);
      if (logs.length) applyLogs(logs, records);
      const seen = new Map(state.blockSeenAt);
      seen.set(Number(head), Date.now());
      if (seen.size > 600) seen.delete(seen.keys().next().value as number);
      set({ status: "live", error: null, block: Number(head), records, blockSeenAt: seen });
    } catch (e) {
      if (!cancelled) set({ error: readableError(e) });
    } finally {
      busy = false;
      if (!cancelled && pending !== null && pending > (last ?? BigInt(0))) void step(pending);
    }
  };

  // Resume (same contract, recent): keep the records and replay the missed logs.
  const resumable =
    lastAddress === address && state.status === "live" && state.block !== null && (getLatestBlock() ?? BigInt(0)) - BigInt(state.block) < BigInt(MAX_RESUME);
  lastAddress = address;
  if (resumable) {
    last = BigInt(state.block as number);
  } else {
    set({ ...EMPTY, status: "loading" });
    void init();
  }

  const off = subscribeBlocks((b) => {
    if (state.status === "unsupported") return;
    void step(b);
  });
  stop = () => {
    cancelled = true;
    off();
    watching = null;
  };
}

function retain(address: Address) {
  refs++;
  if (watching && watching !== address) {
    stop?.();
    stop = null;
  }
  if (!stop) start(address);
}

function release() {
  refs = Math.max(0, refs - 1);
  if (refs === 0 && stop) {
    stop();
    stop = null;
  }
}

/** Subscribe to the auction feed while `enabled` (chain live). */
export function useAuctionFeed(enabled: boolean): AuctionFeedState {
  const clearinghouse = useParaclr((s) => s.chain.contracts?.clearinghouse ?? null);
  useEffect(() => {
    if (!enabled || !clearinghouse) return;
    retain(clearinghouse);
    return release;
  }, [enabled, clearinghouse]);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => EMPTY,
  );
}

// ---- one account's history (Trade screen outcome) --------------------------------

/**
 * The latest auction event for `account` in [fromBlock, toBlock], or null.
 * Used to explain what happened to the signed-in trader's auction. One
 * eth_getLogs per 100-block range, newest range first: every auction event has
 * `account` as its second indexed topic, so a single topic filter matches all
 * four event types.
 */
export async function readLatestAuctionEvent(
  address: Address,
  account: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<AuctionRecord | null> {
  const pc = publicClient();
  const sigs = AUCTION_EVENTS.map((e) => toEventSelector(e));
  const accountTopic = pad(account.toLowerCase() as Hex, { size: 32 });
  for (let to = toBlock; to >= fromBlock; to -= BigInt(MAX_RANGE)) {
    const from = to - BigInt(MAX_RANGE) + BigInt(1) < fromBlock ? fromBlock : to - BigInt(MAX_RANGE) + BigInt(1);
    const raw = await pc.request({
      method: "eth_getLogs",
      params: [{ address, fromBlock: toHex(from), toBlock: toHex(to), topics: [sigs, null, accountTopic] }],
    });
    if (!raw || raw.length === 0) continue;
    const logs = parseEventLogs({ abi: AUCTION_EVENTS, logs: raw.map((l) => formatLog(l)), strict: false }) as unknown as DecodedLog[];
    if (logs.length === 0) continue;
    const records = new Map<string, AuctionRecord>();
    applyLogs(logs, records);
    return records.get(account.toLowerCase()) ?? null;
  }
  return null;
}
