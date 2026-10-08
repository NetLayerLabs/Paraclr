"use client";

// Delayed orders (production): commit → wait for the next Pyth price → filled
// at X (or failed: e.g. the price moved past the limit), or nobody executed it
// inside the window → cancel. Tracked per wallet in a tiny store persisted to
// localStorage (a reload keeps the list), and reconciled against the chain:
// `pendingOrderOf` finds pending orders (also ones placed elsewhere),
// `getOrder(id)` gives the status, and the OrderExecuted / OrderFailed /
// OrderCancelled log gives the outcome.

import { useSyncExternalStore } from "react";
import { encodeFunctionData, parseEventLogs, type Address, type Hex } from "viem";
import type { MarketSymbol, Side } from "../../types";
import { MARKETS } from "../../types";
import { getState } from "../../store";
import { publicClient } from "../clients";
import { NETWORK } from "../config";
import { ChainActionError, decodeRevert, readableError } from "../errors";
import type { LiveContracts } from "../runtime";
import { getSigner } from "../signer";
import { sendTx, serialized } from "../txs";
import { ausdToNumber, priceToNumber } from "../units";
import { ORDER_STATUS, orderNonce, prodAbi } from "./abi";
import { chainNow, readLoose, signedNumber } from "./state";

export type OrderKind = "increase" | "reduce" | "close";

/**
 * signing    commit tx being signed / mined
 * waiting    committed; the first Pyth price it may fill at isn't due yet
 * executing  inside the execution window; a keeper fills it with that price
 * filled     executed (fill price + trading fee from the event)
 * failed     executed with a valid price but the fill was impossible
 *            (slippage, margin, caps…): escrow released, nothing traded
 * expired    window passed, nobody executed it: cancel to get the fee back
 * cancelled  cancelled; escrow released, execution fee refunded
 * settled    no longer pending but the outcome log wasn't found (see positions)
 * rejected   the commit never made it on chain
 */
export type OrderPhase =
  | "signing"
  | "waiting"
  | "executing"
  | "filled"
  | "failed"
  | "expired"
  | "cancelled"
  | "settled"
  | "rejected";

export interface TrackedOrder {
  key: string;
  orderId: bigint | null;
  account: Address;
  symbol: MarketSymbol;
  kind: OrderKind;
  /** Side of the position this order opens / adds to / reduces. */
  side: Side;
  leverage: number | null;
  /** Reduce / close: the position when the order was committed (for the PnL card on close). */
  position?: { entryPrice: number; margin: number } | null;
  /** Signed, 1e18 (> 0 buys). */
  sizeDelta: bigint;
  /** AUSD 6 dp escrowed with the order. */
  marginDelta: bigint;
  /** 1e18 worst fill price. */
  acceptablePrice: bigint;
  /** Native wei. */
  executionFee: bigint;
  /** Earliest / latest execution time (s, chain time). */
  execAfter: number | null;
  deadline: number | null;
  commitBlock: number | null;
  commitTx: Hex | null;
  phase: OrderPhase;
  fillPrice: number | null;
  tradingFee: number | null;
  realizedPnl: number | null;
  publishTime: number | null;
  fillTx: Hex | null;
  fillBlock: number | null;
  cancelTx: Hex | null;
  executor: Address | null;
  /** Why it failed / was rejected (readable). */
  error: string | null;
  label: string;
  createdAt: number;
  /** Outcome-log lookups that found nothing yet (retried a few times). */
  lookups?: number;
}

const FINAL: OrderPhase[] = ["filled", "failed", "cancelled", "settled", "rejected"];
export const isFinal = (o: TrackedOrder) => FINAL.includes(o.phase);
/** Still holds escrow / blocks a new order in its market. */
export const isOpen = (o: TrackedOrder) => o.phase === "waiting" || o.phase === "executing" || o.phase === "expired";

export function orderLabelId(o: TrackedOrder): string {
  return o.orderId === null ? "" : `#${orderNonce(o.orderId).toString()}`;
}

// ---- store ---------------------------------------------------------------------

let orders: TrackedOrder[] = [];
let owner: string | null = null;
const EMPTY: TrackedOrder[] = [];
const listeners = new Set<() => void>();
let seq = 0;

function emit() {
  listeners.forEach((l) => l());
}

const storageKey = (address: string) => `paraclr.orders.v2.${NETWORK?.chainId ?? 0}.${address.toLowerCase()}`;

function persist() {
  if (!owner) return;
  try {
    const keep = orders.filter((o) => o.orderId !== null).slice(-25);
    window.localStorage.setItem(
      storageKey(owner),
      JSON.stringify(keep, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)),
    );
  } catch {
    /* storage blocked */
  }
}

function restore(address: string): TrackedOrder[] {
  try {
    const raw = window.localStorage.getItem(storageKey(address));
    if (!raw) return [];
    const list = JSON.parse(raw, (_k, v) => (typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));
    return Array.isArray(list) ? (list as TrackedOrder[]) : [];
  } catch {
    return [];
  }
}

/** Switch the tracker to `address` (sign-in / sign-out). */
export function loadOrders(address: string | null) {
  const next = address?.toLowerCase() ?? null;
  if (next === owner) return;
  owner = next;
  orders = next ? restore(next) : [];
  emit();
}

function put(o: TrackedOrder) {
  // One entry per order id (a pending order can be discovered on chain before
  // this browser's own commit receipt is processed).
  if (o.orderId !== null) orders = orders.filter((x) => x.key === o.key || x.orderId !== o.orderId);
  const i = orders.findIndex((x) => x.key === o.key);
  orders = i >= 0 ? orders.map((x, j) => (j === i ? o : x)) : [...orders, o];
  persist();
  emit();
}

function patch(key: string, p: Partial<TrackedOrder>) {
  const o = orders.find((x) => x.key === key);
  if (o) put({ ...o, ...p });
}

export function dismissOrder(key: string) {
  orders = orders.filter((o) => o.key !== key);
  persist();
  emit();
}

export function useOrders(): TrackedOrder[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => orders,
    () => EMPTY,
  );
}

export function getOrders(): TrackedOrder[] {
  return orders;
}

// ---- helpers ------------------------------------------------------------------

function requireLive(): { c: LiveContracts } {
  const s = getState();
  if (s.chain.status !== "ready" || !s.chain.contracts) throw new ChainActionError("Chain not connected.");
  if (!s.chain.contracts.production) throw new ChainActionError("Delayed orders exist only on the production contracts.");
  return { c: s.chain.contracts };
}

function signerOrThrow() {
  const signer = getSigner();
  if (!signer || !getState().chain.wallet.ready) throw new ChainActionError("Wallet not ready yet - try again in a moment.");
  return signer;
}

function symbolOf(c: LiveContracts, market: Hex): MarketSymbol | null {
  return MARKETS.find((m) => c.markets[m].toLowerCase() === market.toLowerCase()) ?? null;
}

/** Phase of a still-pending order from chain time and its execution window. */
export function pendingPhase(execAfter: number | null, deadline: number | null): "waiting" | "executing" | "expired" {
  const s = getState().chain.prod;
  const now = s ? chainNow(s) : null;
  if (now === null || execAfter === null) return "waiting";
  if (now < execAfter) return "waiting";
  // Cancellable only once a mined block is past the deadline (the contract
  // checks block.timestamp), so "expired" follows the latest block, not the
  // extrapolated clock.
  if (deadline !== null && s?.chainTime != null && s.chainTime > deadline) return "expired";
  return "executing";
}

// ---- commit / cancel / execute ----------------------------------------------------

export interface CommitArgs {
  symbol: MarketSymbol;
  kind: OrderKind;
  side: Side;
  leverage: number | null;
  position?: { entryPrice: number; margin: number };
  sizeDelta: bigint;
  marginDelta: bigint;
  acceptablePrice: bigint;
  label: string;
  /** Runs inside the serialized queue before the commit (e.g. approve + deposit). */
  before?: () => Promise<void>;
}

/** Commit a delayed order (paying the execution fee in native MON). */
export function commitOrder(args: CommitArgs): Promise<TrackedOrder> {
  return serialized(async () => {
    const { c } = requireLive();
    const signer = signerOrThrow();
    const prod = getState().chain.prod;
    const fee = prod?.params.minExecutionFee ?? null;
    if (fee === null) throw new ChainActionError("Couldn't read the order execution fee from the contract.");
    if (args.kind === "increase" && prod?.paused) {
      throw new ChainActionError("Trading is paused: new and increased positions are disabled. Reduce and close still work.");
    }
    if (orders.some((o) => o.symbol === args.symbol && isOpen(o)) || prod?.mine?.pending[args.symbol]) {
      throw new ChainActionError(
        `You already have a pending ${args.symbol.split("/")[0]} order - the contract allows one per market. Wait for it to fill, or cancel it after its window.`,
      );
    }
    if (args.before) await args.before();

    const key = `o${Date.now().toString(36)}${seq++}`;
    const base: TrackedOrder = {
      key,
      orderId: null,
      account: signer.address,
      symbol: args.symbol,
      kind: args.kind,
      side: args.side,
      leverage: args.leverage,
      position: args.position ?? null,
      sizeDelta: args.sizeDelta,
      marginDelta: args.marginDelta,
      acceptablePrice: args.acceptablePrice,
      executionFee: fee,
      execAfter: null,
      deadline: null,
      commitBlock: null,
      commitTx: null,
      phase: "signing",
      fillPrice: null,
      tradingFee: null,
      realizedPnl: null,
      publishTime: null,
      fillTx: null,
      fillBlock: null,
      cancelTx: null,
      executor: null,
      error: null,
      label: args.label,
      createdAt: Date.now(),
    };
    orders = [...orders, base];
    emit();
    try {
      const receipt = await sendTx(signer, {
        label: `Submit order: ${args.label}`,
        to: c.clearinghouse,
        data: encodeFunctionData({
          abi: prodAbi,
          functionName: "commitOrder",
          args: [c.markets[args.symbol], args.sizeDelta, args.marginDelta, args.acceptablePrice],
        }),
        value: fee,
      });
      const [ev] = parseEventLogs({ abi: prodAbi, logs: receipt.logs, eventName: "OrderCommitted" });
      const execAfter = ev ? Number(ev.args.execAfter) : null;
      const deadline = ev ? Number(ev.args.deadline) : null;
      const committed: TrackedOrder = {
        ...base,
        orderId: ev ? ev.args.orderId : null,
        executionFee: ev ? ev.args.executionFee : fee,
        execAfter,
        deadline,
        commitBlock: Number(receipt.blockNumber),
        commitTx: receipt.transactionHash,
        phase: pendingPhase(execAfter, deadline),
      };
      if (committed.orderId === null) {
        committed.phase = "settled";
        committed.error = "Committed, but the order id wasn't in the receipt - check your positions.";
      }
      put(committed);
      return committed;
    } catch (e) {
      patch(key, { phase: "rejected", error: readableError(e) });
      throw e;
    }
  });
}

export function cancelOrder(o: TrackedOrder): Promise<void> {
  return serialized(async () => {
    const { c } = requireLive();
    const signer = signerOrThrow();
    if (o.orderId === null) throw new ChainActionError("Unknown order id.");
    const receipt = await sendTx(signer, {
      label: `Cancel order ${orderLabelId(o)}: ${o.label}`,
      to: c.clearinghouse,
      data: encodeFunctionData({ abi: prodAbi, functionName: "cancelOrder", args: [o.orderId] }),
    });
    patch(o.key, { phase: "cancelled", cancelTx: receipt.transactionHash });
  });
}

// ---- reconciliation ------------------------------------------------------------------

interface ExecutedArgs {
  orderId?: bigint;
  executor?: Address;
  fillPrice?: bigint;
  publishTime?: bigint;
  tradingFee?: bigint;
  realizedPnl?: bigint;
}

function applyExecuted(o: TrackedOrder, a: ExecutedArgs, tx: Hex | null, block: number | null) {
  patch(o.key, {
    phase: "filled",
    fillPrice: a.fillPrice !== undefined ? priceToNumber(a.fillPrice) : null,
    tradingFee: a.tradingFee !== undefined ? ausdToNumber(a.tradingFee) : null,
    realizedPnl: a.realizedPnl !== undefined ? signedNumber(a.realizedPnl) / 1e6 : null,
    publishTime: a.publishTime !== undefined ? Number(a.publishTime) : null,
    executor: a.executor ?? null,
    fillTx: tx,
    fillBlock: block,
    error: null,
  });
}

function failReason(reason: Hex | undefined): string {
  if (!reason || reason === "0x") return "The fill reverted without a reason.";
  return decodeRevert(reason) ?? "The fill reverted.";
}

function applyOutcomeLogs(
  o: TrackedOrder,
  logs: Parameters<typeof parseEventLogs>[0]["logs"],
  tx: Hex | null,
  block: number | null,
): boolean {
  if (o.orderId === null) return false;
  const executed = parseEventLogs({ abi: prodAbi, logs, eventName: "OrderExecuted" }).find((l) => l.args.orderId === o.orderId);
  if (executed) {
    applyExecuted(o, executed.args, executed.transactionHash ?? tx, executed.blockNumber !== null ? Number(executed.blockNumber) : block);
    return true;
  }
  const failed = parseEventLogs({ abi: prodAbi, logs, eventName: "OrderFailed" }).find((l) => l.args.orderId === o.orderId);
  if (failed) {
    patch(o.key, { phase: "failed", error: failReason(failed.args.reason), fillTx: failed.transactionHash ?? tx });
    return true;
  }
  const cancelled = parseEventLogs({ abi: prodAbi, logs, eventName: "OrderCancelled" }).find((l) => l.args.orderId === o.orderId);
  if (cancelled) {
    patch(o.key, { phase: "cancelled", cancelTx: cancelled.transactionHash ?? tx });
    return true;
  }
  return false;
}

/** Find the outcome log of an order that is no longer pending (bounded, chunked eth_getLogs). */
async function findOutcome(c: LiveContracts, o: TrackedOrder, status: number): Promise<boolean> {
  if (o.orderId === null) return false;
  const orderId = o.orderId;
  const pc = publicClient();
  // Uncached: the outcome may be in the block that just landed.
  const latest = await pc.getBlockNumber({ cacheTime: 0 });
  const chunk = BigInt(NETWORK?.local ? 5_000 : 100);
  const maxSpan = BigInt(NETWORK?.local ? 50_000 : 3_000);
  const start = o.commitBlock !== null ? BigInt(o.commitBlock) : latest > maxSpan ? latest - maxSpan : BigInt(0);
  const end = latest - start > maxSpan ? start + maxSpan : latest;
  const eventName =
    status === ORDER_STATUS.executed ? "OrderExecuted" : status === ORDER_STATUS.failed ? "OrderFailed" : "OrderCancelled";
  for (let from = start; from <= end; from += chunk) {
    const to = from + chunk - BigInt(1) > end ? end : from + chunk - BigInt(1);
    const logs = await pc
      .getContractEvents({ address: c.clearinghouse, abi: prodAbi, eventName, args: { orderId }, fromBlock: from, toBlock: to })
      .catch(() => []);
    if (logs.length && applyOutcomeLogs(o, logs as never, null, null)) return true;
  }
  return false;
}

/** `getOrder` (v2+): reduceOnly after status, positionId last. */
interface OrderStruct {
  account: Address;
  commitTime: bigint;
  status: number;
  reduceOnly: boolean;
  market: Hex;
  sizeDelta: bigint;
  marginDelta: bigint;
  acceptablePrice: bigint;
  executionFee: bigint;
  execAfter: bigint;
  deadline: bigint;
  positionId: bigint;
}

function fromStruct(c: LiveContracts, id: bigint, s: OrderStruct): TrackedOrder | null {
  const symbol = symbolOf(c, s.market);
  if (!symbol) return null;
  const buy = s.sizeDelta > BigInt(0);
  const pos = getState().chain.account?.positions.find((p) => p.symbol === symbol) ?? null;
  const reduce = Boolean(s.reduceOnly);
  const execAfter = Number(s.execAfter);
  const deadline = Number(s.deadline);
  const base = symbol.split("/")[0];
  return {
    key: `d${id}`,
    orderId: id,
    account: s.account,
    symbol,
    kind: reduce ? "reduce" : "increase",
    side: reduce ? (pos?.side ?? "long") : buy ? "long" : "short",
    leverage: null,
    sizeDelta: s.sizeDelta,
    marginDelta: s.marginDelta,
    acceptablePrice: s.acceptablePrice,
    executionFee: s.executionFee,
    execAfter,
    deadline,
    commitBlock: null,
    commitTx: null,
    phase: pendingPhase(execAfter, deadline),
    fillPrice: null,
    tradingFee: null,
    realizedPnl: null,
    publishTime: null,
    fillTx: null,
    fillBlock: null,
    cancelTx: null,
    executor: null,
    error: null,
    label: `${reduce ? "Reduce" : buy ? "Buy" : "Sell"} ${base} (order #${orderNonce(id)})`,
    createdAt: Date.now(),
  };
}

let reconciling = false;

/**
 * Called on new blocks: pick up pending orders this browser doesn't know
 * (`pendingOrderOf`, from the production state read), then settle the status
 * of every open one.
 */
export async function reconcileOrders(): Promise<void> {
  if (reconciling) return;
  const s = getState();
  const c = s.chain.contracts;
  if (s.chain.status !== "ready" || !c?.production) return;
  reconciling = true;
  try {
    const known = new Set(orders.map((o) => (o.orderId === null ? "" : o.orderId.toString())));
    // Skip discovery while this browser is submitting an order: its receipt will add it.
    const submitting = orders.some((o) => o.phase === "signing");
    const unknown = submitting
      ? []
      : Object.values(s.chain.prod?.mine?.pending ?? {}).filter(
          (id): id is bigint => id !== undefined && !known.has(id.toString()),
        );
    // Open orders, plus final ones whose outcome log hasn't been found yet (a few retries).
    const needsOutcome = (o: TrackedOrder) =>
      (o.lookups ?? 0) < 5 &&
      ((o.phase === "filled" && o.fillPrice === null) || (o.phase === "failed" && !o.error) || o.phase === "settled");
    const open = orders.filter((o) => o.orderId !== null && (isOpen(o) || needsOutcome(o)));
    const ids = [...unknown, ...open.map((o) => o.orderId as bigint)];
    if (ids.length === 0) return;
    const res = await readLoose(
      ids.map((id) => ({ address: c.clearinghouse, abi: prodAbi, functionName: "getOrder", args: [id] })),
    );
    for (let i = 0; i < ids.length; i++) {
      const r = res[i];
      const st = r.status === "success" && r.result && typeof r.result === "object" ? (r.result as OrderStruct) : null;
      if (i < unknown.length) {
        if (st && Number(st.status) === ORDER_STATUS.pending) {
          const o = fromStruct(c, ids[i], st);
          if (o) put(o);
        }
        continue;
      }
      const o = open[i - unknown.length];
      if (!st) {
        // getOrder unreadable: fall back to the window clock.
        const phase = pendingPhase(o.execAfter, o.deadline);
        if (phase !== o.phase) patch(o.key, { phase });
        continue;
      }
      const status = Number(st.status);
      if (status === ORDER_STATUS.pending) {
        const execAfter = o.execAfter ?? Number(st.execAfter);
        const deadline = o.deadline ?? Number(st.deadline);
        const phase = pendingPhase(execAfter, deadline);
        if (phase !== o.phase || o.execAfter === null) patch(o.key, { phase, execAfter, deadline });
        continue;
      }
      if (status === ORDER_STATUS.none) continue;
      const found = await findOutcome(c, o, status);
      if (!found) {
        patch(o.key, {
          lookups: (o.lookups ?? 0) + 1,
          phase:
            status === ORDER_STATUS.executed
              ? "filled"
              : status === ORDER_STATUS.failed
                ? "failed"
                : status === ORDER_STATUS.cancelled
                  ? "cancelled"
                  : "settled",
        });
      }
    }
  } catch {
    /* RPC hiccup: next block retries */
  } finally {
    reconciling = false;
  }
}

/** Phase-only refresh between chain reads (countdowns crossing a boundary). */
export function tickOrderPhases() {
  for (const o of orders) {
    if (o.phase !== "waiting" && o.phase !== "executing") continue;
    const phase = pendingPhase(o.execAfter, o.deadline);
    if (phase !== o.phase) patch(o.key, { phase });
  }
}
