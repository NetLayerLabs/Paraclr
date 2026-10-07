"use client";

// Production collateral + order actions (ParaclrClearinghouseProd). Every
// deposit path goes through the risk acknowledgement, the pause flag and the
// caps first; approvals are for the exact amount (never unlimited) because
// this is real money.

import { encodeFunctionData, erc20Abi, parseUnits, type Address } from "viem";
import type { MarketSymbol, Position, Side } from "../../types";
import { MARKETS } from "../../types";
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
import { EMPTY_PROD, readProdDynamic, readProdParams } from "./state";

const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function requireLive(): { signer: ChainSigner; c: LiveContracts } {
  const s = getState();
  if (s.chain.status !== "ready" || !s.chain.contracts) throw new ChainActionError("Chain not connected.");
  const signer = getSigner();
  if (!signer || !s.chain.wallet.ready) throw new ChainActionError("Wallet not ready yet — try again in a moment.");
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
    setProd({ ...dyn, chainTimeAt: Date.now(), status: "ready", error: null });
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
}

/** How much more this account may deposit: collateral after ≤ account cap, lane TVL after ≤ lane cap. */
export function depositRoom(acct: ChainAccountSnapshot | null): DepositRoom {
  const p = getState().chain.prod;
  if (!p || !acct) return { room: null, accountRoom: null, laneRoom: null };
  const accountRoom =
    p.params.maxDepositPerAccount === null ? null : Math.max(0, p.params.maxDepositPerAccount - acct.collateral);
  const laneRoom =
    p.params.maxTvlPerLane === null || p.lane?.tvl == null ? null : Math.max(0, p.params.maxTvlPerLane - p.lane.tvl);
  const rooms = [accountRoom, laneRoom].filter((x): x is number => x !== null);
  return { room: rooms.length ? Math.min(...rooms) : null, accountRoom, laneRoom };
}

/** While paused, only accounts holding positions may deposit (margin top-ups). */
export function depositBlockedByPause(acct: ChainAccountSnapshot | null): boolean {
  return getState().chain.prod?.paused === true && (acct?.positions.length ?? 0) === 0;
}

function checkDeposit(units: bigint, snap: ChainAccountSnapshot) {
  if (depositBlockedByPause(snap)) {
    throw new ChainActionError("Deposits are paused by the guardian (top-ups to open positions still work). Withdrawals and closing still work.");
  }
  if (units > snap.walletAusdUnits) {
    throw new ChainActionError(`Not enough AUSD in your wallet: need ${fmt(ausdToNumber(units))}, have ${fmt(snap.walletAusd)}.`);
  }
  const { room, accountRoom, laneRoom } = depositRoom(snap);
  const amount = ausdToNumber(units);
  if (room !== null && amount > room + 1e-6) {
    const which =
      accountRoom !== null && (laneRoom === null || accountRoom <= laneRoom)
        ? `the per-account deposit cap (${fmt(accountRoom)} AUSD left)`
        : `your lane's TVL cap (${fmt(laneRoom ?? 0)} AUSD left)`;
    throw new ChainActionError(`That deposit exceeds ${which}. This is a capped beta.`);
  }
}

/** approve(exact) if needed, then deposit. Caller holds the serialized queue. */
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
  maxPriceAge: number | null;
  /** Stored prices are too old to use directly: a fresh update will be fetched. */
  needsFresh: boolean;
}

export function storedPriceStatus(acct: ChainAccountSnapshot | null): StoredPriceStatus {
  const p = getState().chain.prod;
  const needed = (acct?.positions.length ?? 0) > 0;
  if (!p || p.chainTime === null) return { needed, oldestAge: null, maxPriceAge: null, needsFresh: false };
  const times = MARKETS.map((m) => p.markets[m].onchainPublishTime).filter((t): t is number => t !== null);
  const oldestAge = times.length ? Math.max(0, p.chainTime - Math.min(...times)) : null;
  return {
    needed,
    oldestAge,
    maxPriceAge: p.params.maxPriceAge,
    needsFresh:
      needed && (oldestAge === null || oldestAge >= storedFreshThreshold(p.params.maxPriceAge ?? undefined)),
  };
}

/** What a withdrawal would attach right now (for the wallet to show source + fee). */
export function quoteWithdrawUpdate(): Promise<PriceUpdate> {
  const { c } = requireLive();
  return priceUpdateFor(c, (getState().chain.account?.positions.length ?? 0) > 0);
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
    const u = await priceUpdateFor(c, snap.positions.length > 0);
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
 * orders + Σ position margins + this order's margin), and at the fill it takes
 * the trading fee from collateral and requires equity ≥ Σ margins. So the
 * deposit also covers the fee (×2 for rounding and a little price movement)
 * and any unrealized loss on the account's other legs. Rounded up to a cent.
 */
export function orderDepositNeeded(acct: ChainAccountSnapshot | null, marginUnits: bigint, tradingFeeUnits: bigint): bigint {
  const zero = BigInt(0);
  const feeBuffer = tradingFeeUnits * BigInt(2);
  let need: bigint;
  if (!acct) {
    need = marginUnits + feeBuffer;
  } else {
    const collateral = acct.collateralUnits ?? ausdToUnits(Math.max(0, acct.collateral));
    const losses =
      acct.equity !== null && acct.equity < acct.collateral ? ausdToUnits(acct.collateral - acct.equity) : zero;
    const required =
      (acct.reservedMarginUnits ?? zero) + (acct.marginSumUnits ?? zero) + marginUnits + feeBuffer + losses;
    const have = collateral > zero ? collateral : zero;
    need = required > have ? required - have : zero;
  }
  const cent = BigInt(10_000);
  return ((need + cent - BigInt(1)) / cent) * cent;
}

/** Trading fee (AUSD 6 dp) the contract will charge on `notional` AUSD. */
export function tradingFeeUnits(notional: number): bigint {
  const bps = getState().chain.prod?.params.tradingFeeBps ?? 0;
  return ausdToUnits((notional * bps) / 10_000);
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
  const size = (args.margin * args.leverage) / args.mark;
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
      const need = orderDepositNeeded(snap, marginUnits, tradingFeeUnits(args.margin * args.leverage));
      if (need > BigInt(0)) await depositUnits(signer, c, need, snap);
    },
  });
}

/** Reduce (fraction < 1) or close (fraction = 1) a position with a delayed order. */
export function submitReduceOrder(args: { position: Position; fraction: number; mark: number; slippagePct: number }) {
  const p = args.position;
  if (!p.sizeUnits || p.sizeUnits === BigInt(0)) {
    return Promise.reject(new ChainActionError("Position size unknown — wait for the next on-chain read."));
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
    sizeDelta: buy ? abs : -abs,
    marginDelta: BigInt(0),
    acceptablePrice: acceptablePrice(args.mark, buy, args.slippagePct),
    label: full ? `Close ${base} ${p.side}` : `Reduce ${base} ${p.side} by ${Math.round(args.fraction * 100)}%`,
  });
}
