"use client";

// Production collateral + order actions (ParaclrClearinghouseProd). Every
// deposit path goes through the risk acknowledgement, the pause flag and the
// caps first; approvals are for the exact amount (never unlimited) because
// this is real money.

import { encodeFunctionData, erc20Abi, parseUnits, type Address } from "viem";
import type { MarketSymbol, Position, Side } from "../../types";
import { getState, initProd, setProd } from "../../store";
import { readAccountSnapshot, type ChainAccountSnapshot } from "../account";
import { ChainActionError } from "../errors";
import type { LiveContracts } from "../runtime";
import { getSigner, type ChainSigner } from "../signer";
import { refreshAccount } from "../trading";
import { sendTx, serialized } from "../txs";
import { ausdToNumber, ausdToUnits } from "../units";
import { prodAbi } from "./abi";
import { commitOrder, type TrackedOrder } from "./orders";
import { priceUpdateFor, storedFreshThreshold, type PriceUpdate } from "./priceUpdate";
import { requireRiskAck } from "./riskAck";
import { EMPTY_PROD, readLoose, readProdDynamic, readProdParams } from "./state";

const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function requireLive(): { signer: ChainSigner; c: LiveContracts } {
  const s = getState();
  if (s.chain.status !== "ready" || !s.chain.contracts) throw new ChainActionError("Chain not connected.");
  const signer = getSigner();
  if (!signer || !s.chain.wallet.ready) throw new ChainActionError("Wallet not ready yet - try again in a moment.");
  return { signer, c: s.chain.contracts };
}

// ---- state sync ----------------------------------------------------------------

let paramsAt = 0;
let paramsFor: string | null = null;
const PARAMS_EVERY_MS = 30_000;

/** Re-read the production state (params every 30 s; pause/funding/caps/own orders every call). */
export async function refreshProd(): Promise<void> {
  const s = getState();
  const c = s.chain.contracts;
  if (s.chain.status !== "ready" || !c?.production) return;
  if (!s.chain.prod) initProd({ ...EMPTY_PROD });
  try {
    if (paramsFor !== c.clearinghouse || Date.now() - paramsAt > PARAMS_EVERY_MS) {
      const params = await readProdParams(c);
      paramsAt = Date.now();
      paramsFor = c.clearinghouse;
      setProd({ params });
    }
    const st = getState();
    const lane = st.chain.account?.lane ?? null;
    const account = (st.session?.address as Address | undefined) ?? null;
    const dyn = await readProdDynamic(c, lane, account);
    setProd({ ...dyn, status: "ready", error: null });
  } catch (e) {
    setProd({ status: getState().chain.prod?.status === "ready" ? "ready" : "error", error: (e as Error).message });
  }
}

// ---- caps ----------------------------------------------------------------------

export interface DepositRoom {
  /** AUSD that may still be deposited (min of the caps), null if unknown. */
  room: number | null;
  accountRoom: number | null;
  laneRoom: number | null;
  /**
   * Holders only: AUSD allowed beyond the caps right now (`topUpAllowance`,
   * equity back to initial margin). Read at stored prices; `depositWithPrice`
   * recomputes it at fresh prices on submit.
   */
  topUp: number;
  /** The account holds positions (its deposits go through `depositWithPrice`). */
  holder: boolean;
}

/** How much more this account may deposit under the caps (collateral ≤ account cap, lane TVL ≤ lane cap). */
export function depositRoom(acct: ChainAccountSnapshot | null): DepositRoom {
  const p = getState().chain.prod;
  const holder = (acct?.positions.length ?? 0) > 0;
  const topUp = holder ? (p?.mine?.topUpAllowance ?? 0) : 0;
  if (!p || !acct) return { room: null, accountRoom: null, laneRoom: null, topUp, holder };
  const accountRoom =
    p.params.maxDepositPerAccount === null ? null : Math.max(0, p.params.maxDepositPerAccount - acct.collateral);
  const laneRoom =
    p.params.maxTvlPerLane === null || p.lane?.tvl == null ? null : Math.max(0, p.params.maxTvlPerLane - p.lane.tvl);
  const rooms = [accountRoom, laneRoom].filter((x): x is number => x !== null);
  return { room: rooms.length ? Math.min(...rooms) : null, accountRoom, laneRoom, topUp, holder };
}

/** While paused, only accounts holding positions may deposit (margin top-ups). */
export function depositBlockedByPause(acct: ChainAccountSnapshot | null): boolean {
  return getState().chain.prod?.paused === true && (acct?.positions.length ?? 0) === 0;
}

/**
 * Why a deposit of `amount` would be refused, or null. Fresh deposits (no
 * positions) are checked against the caps, the 1-AUSD first-deposit minimum
 * and the lane's bad debt here. Holders' deposits aren't pre-blocked on the
 * caps: their exemption is recomputed at fresh prices by `depositWithPrice`,
 * and the simulation before signing reports any cap the contract enforces.
 */
export function depositRefusal(acct: ChainAccountSnapshot | null, amount: number): string | null {
  const p = getState().chain.prod;
  if (!acct || !p) return null;
  if (depositBlockedByPause(acct)) return "Deposits paused by the guardian";
  const holder = acct.positions.length > 0;
  if (holder) return null;
  if ((p.lane?.solvency?.badDebt ?? 0) > 0) return `Lane ${acct.lane} is in deficit: new deposits are refused`;
  const min = p.params.minFirstDeposit ?? 1;
  if (!acct.registered && amount > 0 && amount < min) return `First deposit at least ${fmt(min)} AUSD`;
  const { room } = depositRoom(acct);
  if (room !== null && amount > room + 1e-6) return "Over the beta deposit cap";
  return null;
}

function checkDeposit(units: bigint, snap: ChainAccountSnapshot) {
  if (units > snap.walletAusdUnits) {
    throw new ChainActionError(`Not enough AUSD in your wallet: need ${fmt(ausdToNumber(units))}, have ${fmt(snap.walletAusd)}.`);
  }
  const refusal = depositRefusal(snap, ausdToNumber(units));
  if (refusal) throw new ChainActionError(`${refusal}. This is a capped beta.`);
}

/**
 * approve(exact) if needed, then deposit. Accounts holding positions use
 * `depositWithPrice` with a price update when stored prices are stale, so the
 * margin top-up exemption is computed at fresh prices. Caller holds the
 * serialized queue.
 */
async function depositUnits(signer: ChainSigner, c: LiveContracts, units: bigint, snap: ChainAccountSnapshot) {
  await requireRiskAck(signer.address);
  checkDeposit(units, snap);
  if (snap.allowanceUnits < units) {
    await sendTx(signer, {
      label: `Approve ${fmt(ausdToNumber(units))} ${c.token.symbol} (exact amount)`,
      to: c.ausd,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [c.clearinghouse, units] }),
    });
  }
  if (snap.positions.length > 0) {
    // Fresh prices only widen the exemption; without them the capped part still goes through.
    const u = await priceUpdateFor(c, true, snap.lane).catch(() => null);
    await sendTx(signer, {
      label: `Add ${fmt(ausdToNumber(units))} ${c.token.symbol} margin`,
      to: c.clearinghouse,
      data: encodeFunctionData({ abi: prodAbi, functionName: "depositWithPrice", args: [units, u?.updateData ?? []] }),
      value: u && u.fee > BigInt(0) ? u.fee : undefined,
    });
    return;
  }
  await sendTx(signer, {
    label: `Deposit ${fmt(ausdToNumber(units))} ${c.token.symbol}`,
    to: c.clearinghouse,
    data: encodeFunctionData({ abi: prodAbi, functionName: "deposit", args: [units] }),
  });
}

export function depositProd(amount: number): Promise<void> {
  return serialized(async () => {
    const { signer, c } = requireLive();
    const units = ausdToUnits(amount);
    if (units === BigInt(0)) throw new ChainActionError("Enter an amount.");
    const snap = await readAccountSnapshot(signer.address, c);
    await depositUnits(signer, c, units, snap);
    void refreshAccount();
    void refreshProd();
  });
}

// ---- prices for health checks -----------------------------------------------------

/**
 * Age of the Pyth prices stored on chain, for the wallet's health-check line.
 * The actual `priceUpdate` for a call comes from priceUpdateFor() (stored
 * prices when fresh, else a signed update via the keeper's /hermes proxy).
 */
export interface StoredPriceStatus {
  /** Whether a price is needed at all (the account holds positions). */
  needed: boolean;
  /** Oldest stored price among all listed markets, seconds (null if unknown). */
  oldestAge: number | null;
  /** The contract's `maxStoredPriceAge` (s). */
  maxStoredAge: number | null;
  /** Stored prices are too old to use directly: a fresh update will be fetched. */
  needsFresh: boolean;
}

export function storedPriceStatus(acct: ChainAccountSnapshot | null): StoredPriceStatus {
  const p = getState().chain.prod;
  const needed = (acct?.positions.length ?? 0) > 0;
  if (!p || p.chainTime === null) return { needed, oldestAge: null, maxStoredAge: null, needsFresh: false };
  const listed = getState().chain.contracts?.listed ?? [];
  const times = listed.map((m) => p.markets[m].onchainPublishTime).filter((t): t is number => t !== null);
  const oldestAge = times.length ? Math.max(0, p.chainTime - Math.min(...times)) : null;
  return {
    needed,
    oldestAge,
    maxStoredAge: p.params.maxStoredPriceAge,
    needsFresh:
      needed && (oldestAge === null || oldestAge >= storedFreshThreshold(p.params.maxStoredPriceAge ?? undefined)),
  };
}

/** `previewWithdraw(account, amount)`: what a withdrawal would pay now (the lane haircut applies). */
export async function previewWithdrawAmount(account: Address, amount: number): Promise<number | null> {
  const c = getState().chain.contracts;
  if (!c?.production) return null;
  const [r] = await readLoose([
    { address: c.clearinghouse, abi: prodAbi, functionName: "previewWithdraw", args: [account, ausdToUnits(amount)] },
  ]);
  return r.status === "success" && typeof r.result === "bigint" ? ausdToNumber(r.result) : null;
}

/** What a withdrawal would attach right now (for the wallet to show source + fee). */
export function quoteWithdrawUpdate(): Promise<PriceUpdate> {
  const { c } = requireLive();
  const acct = getState().chain.account;
  return priceUpdateFor(c, (acct?.positions.length ?? 0) > 0, acct?.lane ?? null);
}

/**
 * Withdraw `amount` (or all free collateral). The health check is priced with
 * the stored Pyth prices when fresh, else with a signed update fetched through
 * the keeper's proxy (see priceUpdate.ts).
 */
export function withdrawProd(amount: number | "max"): Promise<number> {
  return serialized(async () => {
    const { signer, c } = requireLive();
    const snap = await readAccountSnapshot(signer.address, c);
    const free = snap.freeCollateralUnits;
    const units = amount === "max" ? free : ausdToUnits(amount);
    if (units === BigInt(0)) throw new ChainActionError("Nothing to withdraw.");
    if (units > free && !snap.estimated) {
      throw new ChainActionError(`Only ${fmt(ausdToNumber(free))} AUSD is free to withdraw.`);
    }
    const u = await priceUpdateFor(c, snap.positions.length > 0, snap.lane);
    await sendTx(signer, {
      label: `Withdraw ${fmt(ausdToNumber(units))} ${c.token.symbol}`,
      to: c.clearinghouse,
      data: encodeFunctionData({ abi: prodAbi, functionName: "withdraw", args: [units, u.updateData] }),
      value: u.fee > BigInt(0) ? u.fee : undefined,
    });
    void refreshAccount();
    void refreshProd();
    return ausdToNumber(units);
  });
}

/** Withdraw MON credited to this wallet (execution fees earned, refunds that couldn't be pushed). */
export function claimExecutionFees(): Promise<void> {
  return serialized(async () => {
    const { signer, c } = requireLive();
    await sendTx(signer, {
      label: `Claim ${c.token.symbol === "AUSD" ? "MON" : "native"} execution fees`,
      to: c.clearinghouse,
      data: encodeFunctionData({ abi: prodAbi, functionName: "claimExecutionFees" }),
    });
    void refreshAccount();
    void refreshProd();
  });
}

// ---- orders ----------------------------------------------------------------------

const toE18 = (n: number) => parseUnits(n.toFixed(18).replace(/\.?0+$/, "") || "0", 18);

/** Worst acceptable fill price for a buy (×(1+s)) or sell (×(1−s)). */
export function acceptablePrice(mark: number, buy: boolean, slippagePct: number): bigint {
  const f = buy ? 1 + slippagePct / 100 : 1 - slippagePct / 100;
  return toE18(Math.max(0, mark * f));
}

/**
 * AUSD the account must deposit before committing an increase. The contract
 * escrows margin against deposited collateral (collateral ≥ escrow of pending
 * orders + Σ position margins + this order's margin); the trading fee is paid
 * out of the order's margin at the fill. At the fill it also requires equity ≥
 * Σ margins, so any unrealized loss on the account's other legs is covered
 * too. Rounded up to a cent.
 */
export function orderDepositNeeded(acct: ChainAccountSnapshot | null, marginUnits: bigint): bigint {
  const zero = BigInt(0);
  let need: bigint;
  if (!acct) {
    need = marginUnits;
  } else {
    const collateral = acct.collateralUnits ?? ausdToUnits(Math.max(0, acct.collateral));
    const losses =
      acct.equity !== null && acct.equity < acct.collateral ? ausdToUnits(acct.collateral - acct.equity) : zero;
    const required = (acct.reservedMarginUnits ?? zero) + (acct.marginSumUnits ?? zero) + marginUnits + losses;
    const have = collateral > zero ? collateral : zero;
    need = required > have ? required - have : zero;
  }
  const cent = BigInt(10_000);
  return ((need + cent - BigInt(1)) / cent) * cent;
}

/**
 * Order size (base units) for `margin` × `leverage` at `mark`. The contract
 * checks leverage at the FILL price, so near the maximum the size is computed
 * at the worst price the slippage setting allows (mark × (1 + slippage)):
 * otherwise any move up between submit and fill would breach the cap and the
 * fill would fail (`LeverageTooHigh`).
 */
export function orderSize(margin: number, leverage: number, mark: number, slippagePct: number): number {
  const maxLev = getState().chain.prod?.params.maxLeverage ?? Number.POSITIVE_INFINITY;
  const worst = mark * (1 + slippagePct / 100);
  const notionalCap = margin * maxLev;
  const atMark = margin * leverage;
  // Close to the cap: size so that notional at the worst acceptable price stays within it.
  const notional = atMark * (worst / mark) > notionalCap ? notionalCap * (mark / worst) : atMark;
  return notional / mark;
}

/** Open or add to a position: deposit the escrow shortfall (if any), then commit. */
export function submitIncreaseOrder(args: {
  symbol: MarketSymbol;
  side: Side;
  margin: number;
  leverage: number;
  mark: number;
  slippagePct: number;
}): Promise<TrackedOrder> {
  const { signer, c } = requireLive();
  const marginUnits = ausdToUnits(args.margin);
  if (marginUnits === BigInt(0)) return Promise.reject(new ChainActionError("Enter a margin amount."));
  const size = orderSize(args.margin, args.leverage, args.mark, args.slippagePct);
  const sizeAbs = toE18(size);
  const buy = args.side === "long";
  const base = args.symbol.split("/")[0];
  return commitOrder({
    symbol: args.symbol,
    kind: "increase",
    side: args.side,
    leverage: args.leverage,
    sizeDelta: buy ? sizeAbs : -sizeAbs,
    marginDelta: marginUnits,
    acceptablePrice: acceptablePrice(args.mark, buy, args.slippagePct),
    label: `${buy ? "Long" : "Short"} ${args.leverage}x ${base} · ${fmt(args.margin)} margin`,
    before: async () => {
      const snap = await readAccountSnapshot(signer.address, c);
      const need = orderDepositNeeded(snap, marginUnits);
      if (need > BigInt(0)) await depositUnits(signer, c, need, snap);
    },
  });
}

/** Reduce (fraction < 1) or close (fraction = 1) a position with a delayed order. */
export function submitReduceOrder(args: { position: Position; fraction: number; mark: number; slippagePct: number }) {
  const p = args.position;
  if (!p.sizeUnits || p.sizeUnits === BigInt(0)) {
    return Promise.reject(new ChainActionError("Position size unknown - wait for the next on-chain read."));
  }
  const full = args.fraction >= 0.9999;
  const abs = full ? p.sizeUnits : (p.sizeUnits * BigInt(Math.round(args.fraction * 10_000))) / BigInt(10_000);
  // Closing a long sells; closing a short buys.
  const buy = p.side === "short";
  const base = p.symbol.split("/")[0];
  return commitOrder({
    symbol: p.symbol,
    kind: full ? "close" : "reduce",
    side: p.side,
    leverage: p.leverage,
    position: { entryPrice: p.entryPrice, margin: p.margin },
    sizeDelta: buy ? abs : -abs,
    marginDelta: BigInt(0),
    acceptablePrice: acceptablePrice(args.mark, buy, args.slippagePct),
    label: full ? `Close ${base} ${p.side}` : `Reduce ${base} ${p.side} by ${Math.round(args.fraction * 100)}%`,
  });
}
