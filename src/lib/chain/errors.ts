// Turn viem / RPC / contract failures into one readable sentence.
// Custom errors are decoded against the clearinghouse + AUSD + oracle ABIs.

import {
  BaseError,
  ChainMismatchError,
  HttpRequestError,
  InsufficientFundsError,
  TimeoutError,
  UserRejectedRequestError,
  WaitForTransactionReceiptTimeoutError,
  decodeErrorResult,
  type Abi,
  type Hex,
} from "viem";
import { mockAUSDAbi, mockOracleAbi, paraclrClearinghouseAbi } from "./abi";
import { NETWORK } from "./config";
import { agoraFaucetAbi, prodAbi, pythAbi } from "./prod/abi";
import { ausdToNumber, priceToNumber } from "./units";
import { fmtAusd as ausdText } from "@/lib/format";

// Dedupe by signature: the same error can appear in several ABIs.
const ERROR_ABI = Object.values(
  Object.fromEntries(
    [...paraclrClearinghouseAbi, ...mockAUSDAbi, ...mockOracleAbi, ...prodAbi, ...pythAbi, ...agoraFaucetAbi]
      .filter((x) => x.type === "error")
      .map((x) => [`${(x as { name: string }).name}(${JSON.stringify((x as { inputs?: unknown }).inputs ?? [])})`, x]),
  ),
) as unknown as Abi;

const fmtPx = (v: unknown) => (typeof v === "bigint" ? priceToNumber(v).toLocaleString("en-US", { maximumSignificantDigits: 6 }) : "?");

/** Thrown by chain actions with a message that's safe to show as-is. */
export class ChainActionError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ChainActionError";
  }
}

const fmtAusd = (v: unknown) =>
  typeof v === "bigint" ? `${ausdText(ausdToNumber(v < BigInt(0) ? -v : v))} AUSD` : "?";

function customErrorMessage(name: string, args: readonly unknown[] | undefined): string {
  const a = args ?? [];
  switch (name) {
    case "PositionExists":
      return "You already have a position in this market. The clearinghouse allows one position per market: close it first.";
    case "NoPosition":
      return "No open position in this market (it may already be closed or liquidated).";
    case "InsufficientMargin":
      return `Not enough collateral: equity ${a[0] !== undefined && typeof a[0] === "bigint" && a[0] < BigInt(0) ? "−" : ""}${fmtAusd(a[0])} vs ${fmtAusd(a[1])} initial margin required.`;
    case "InsufficientFreeCollateral":
      return `Only ${fmtAusd(a[1])} free collateral available (requested ${fmtAusd(a[0])}).`;
    case "InvalidLeverage":
      return "Leverage must be between 1x and 20x.";
    case "MarketNotListed":
      return "This market isn't listed on the deployed clearinghouse.";
    case "TooManyOpenMarkets":
      return "Too many open markets on this account.";
    case "StalePrice":
      return a.length >= 2
        ? "Prices are refreshing; retry in a few seconds. (The Pyth price stored on chain is older than the contract accepts.)"
        : "The oracle price is stale. Retry in a few seconds.";
    case "InvalidPrice":
      return a.length >= 1 ? "Pyth has no valid price for this market right now." : "The oracle has no price for this market yet.";
    case "ZeroAmount":
      return "Amount is too small.";
    case "TransferFailed":
      return "AUSD transfer failed: check your AUSD balance and allowance.";
    case "InsufficientBalance":
      return "Not enough AUSD in your wallet.";
    case "InsufficientAllowance":
      return "AUSD allowance too low: approve the clearinghouse first.";
    case "MintCapExceeded":
      return "The AUSD faucet mints at most 10,000 per call.";
    case "AccountNotInLane":
      return "Account is not in that lane.";
    case "InvalidLane":
      return "Invalid lane.";
    case "Unauthorized":
      return "Not authorized to call this function.";
    case "Reentrancy":
      return "Reentrancy guard tripped.";
    case "AmountTooLarge":
      return "Amount too large.";
    case "AccountInAuction":
      return "This account is in a liquidation auction: frozen (no open, close or withdraw) until it is cured or taken. Deposits are allowed.";
    case "NotInAuction":
      return "That account isn't in an auction (it may already have been taken, cured or expired).";
    case "NotLiquidatable":
      return "That account is healthy again, so it can't be taken; its auction can only be cancelled.";
    case "NotRegistered":
      return "Deposit collateral first: this account isn't registered with the clearinghouse yet (it registers on its first deposit).";
    case "SelfTake":
      return "You can't take your own auction.";
    case "BackstopInsolvent":
      return "This lane's backstop pool has no positive equity, so deposits and withdrawals are paused.";
    case "BackstopMarginBreached":
      return `That withdrawal would leave the pool with ${fmtAusd(a[0])} equity, below the ${fmtAusd(a[1])} it must keep (10% of its inherited exposure).`;
    case "InsufficientBackstopCash":
      return `The pool only has ${fmtAusd(a[1])} cash (requested ${fmtAusd(a[0])}); the rest of its NAV is inherited positions.`;
    case "InsufficientShares":
      return `You only have ${fmtAusd(a[1]).replace(" AUSD", "")} shares in this pool.`;
    case "InvalidBps":
      return "Invalid basis-point value.";
    case "ZeroAddress":
      return "Zero address.";
    // ---- production contracts (ParaclrClearinghouseProd) ----
    case "IsPaused":
      return "Paused by the guardian: new deposits and new or increased positions are disabled. Withdrawals, reduce and close orders still work.";
    case "NotPaused":
      return "The contract isn't paused.";
    case "OrderAlreadyPending":
      return "You already have a pending order in this market (one per market). Wait for it to fill, or cancel it after its window.";
    case "OrderNotPending":
      return "That order is no longer pending (already executed, failed or cancelled).";
    case "OrderNotReady":
      return "Too early: the order can only be executed with a Pyth price published after its minimum delay.";
    case "OrderExpired":
      return "This order's execution window has passed: cancel it to release the escrow and get the execution fee back.";
    case "OrderNotExpired":
      return "An order can only be cancelled after its execution window has passed (no free option).";
    case "OrderWouldFlip":
      return "One order can't flip a position (or reduce by more than its size): close it first.";
    case "MarginOnReduce":
      return "A reduce or close order can't add margin.";
    case "InvalidAcceptablePrice":
      return "Invalid acceptable price.";
    case "SlippageExceeded":
      return `The Pyth fill price ${fmtPx(a[0])} was worse than your limit ${fmtPx(a[1])} (slippage).`;
    case "ExecutionFeeTooLow":
      return "The order didn't carry enough MON for the execution fee.";
    case "DepositCapExceeded":
      return `Over this beta's per-account deposit cap (${fmtAusd(a[1])}).`;
    case "LaneTvlCapExceeded":
      return `Your lane is at its TVL cap for this beta (${fmtAusd(a[1])}).`;
    case "OiCapExceeded":
      return `Your lane's open-interest cap for this market is reached (${fmtAusd(a[1])} per side).`;
    case "BelowMinPositionSize":
      return `Position below the minimum size (${fmtAusd(a[1])} notional).`;
    case "LeverageTooHigh":
      return "Leverage above this beta's maximum.";
    case "InsufficientCollateral":
      return `Not enough deposited collateral to escrow this order's margin (${fmtAusd(a[0])} committed).`;
    case "InsufficientPythFee":
      return "Not enough MON sent for the Pyth price update fee.";
    case "PriceConfidenceTooWide":
      return "Pyth's confidence interval is too wide right now, and the contract refuses to price with it. Try again shortly.";
    case "InvalidPythResponse":
      return "The Pyth contract returned an unexpected price response.";
    case "InvalidPriceExpo":
      return "Pyth price exponent out of range.";
    case "FundingUpdateTooSoon":
      return "Funding was updated recently; it can be updated again after its interval.";
    case "TransferAmountMismatch":
      return "The token transferred a different amount than requested.";
    case "RefundFailed":
      return "Refund of excess MON failed.";
    case "Paused":
      return "Paused by the guardian.";
    // ---- v2–v4 review fixes ----
    case "PositionChanged":
      return "Not filled: your position changed after you placed the order (it was taken, closed or replaced). Nothing was traded.";
    case "LaneInDeficit": {
      const lane = typeof a[0] === "number" || typeof a[0] === "bigint" ? `L${Number(a[0])}` : "This lane";
      return `${lane} has bad debt, so new deposits into it are refused until it is repaid. Top-ups to open positions still work.`;
    }
    case "LaneInsolvent":
      return "This lane can't pay that out right now (it holds less than requested). Try a smaller amount.";
    case "WithdrawNotReady":
      return `Your pool withdrawal isn't ready yet: it opens at ${typeof a[0] === "bigint" ? new Date(Number(a[0]) * 1000).toLocaleTimeString() : "the end of the waiting period"}.`;
    case "WithdrawRequestExpired":
      return "Your pool withdrawal request expired (its window has passed). Request again.";
    case "NoWithdrawRequest":
      return "Request the withdrawal first: pool exits are two steps (request, wait, then withdraw within the window).";
    case "DepositTooSmall":
      return `Your first deposit must be at least ${fmtAusd(a[1])}.`;
    case "BackstopReceivableOutstanding":
      return `Pool deposits are paused: the lane owes this pool ${fmtAusd(a[1])} (it lent cash to cover losses), so a deposit can't be priced fairly yet.`;
    case "BackstopGainCapBinding":
      return "Pool deposits are paused: the pool's unrealised gain is above the lane's insurance, so its NAV is capped and a deposit can't be priced fairly yet.";
    case "CollateralAboveCap":
      return "Your collateral is above the beta cap. Withdraw down to the cap before adding margin.";
    case "BackstopPositionsOpen":
      return "The pool still holds positions; the keeper unwinds them shortly, so retry your exit.";
    case "MarginAboveNotional":
      return "Margin can't exceed the position's notional (leverage must be at least 1x).";
    case "MarginRequired":
      return "A new position needs margin.";
    case "MarketHasOpenInterest":
      return "This market has open interest, so its feed can't be changed.";
    case "InsufficientFee":
      return "Not enough MON sent for the Pyth price update fee.";
    case "PriceFeedNotFound":
    case "PriceFeedNotFoundWithinRange":
      return "No Pyth price in the required time range for this market.";
    case "InvalidUpdateData":
    case "InvalidUpdateDataSource":
    case "InvalidWormholeVaa":
      return "The Pyth price update was rejected by the Pyth contract (invalid or from the wrong source).";
    case "NoFreshUpdate":
      return "No fresh Pyth update was supplied.";
    // Agora's testnet AUSD faucet.
    case "MaxFrequencyExceeded":
      return "Agora's faucet drips once a minute for everyone, and someone just used it. Try again in a minute.";
    case "MaxAllowedExceeded":
      return "Agora's faucet only tops up wallets holding less than its limit (100,000 AUSD).";
    case "InsufficientFunds":
      return "Agora's testnet AUSD faucet is empty right now.";
    default:
      return `Reverted: ${name}`;
  }
}

function extractRevertData(err: BaseError): Hex | null {
  let found: Hex | null = null;
  err.walk((e) => {
    const d = (e as { data?: unknown }).data;
    if (typeof d === "string" && /^0x[0-9a-fA-F]{8,}$/.test(d)) {
      found = d as Hex;
      return true;
    }
    if (d && typeof d === "object" && typeof (d as { data?: unknown }).data === "string") {
      const inner = (d as { data: string }).data;
      if (/^0x[0-9a-fA-F]{8,}$/.test(inner)) {
        found = inner as Hex;
        return true;
      }
    }
    return false;
  });
  return found;
}

/** Decode raw revert bytes (custom error, Error(string) or Panic). */
export function decodeRevert(data: Hex): string | null {
  try {
    const decoded = decodeErrorResult({ abi: ERROR_ABI, data });
    if (decoded.errorName === "Error") return `Reverted: ${String(decoded.args?.[0] ?? "")}`;
    if (decoded.errorName === "Panic") return `Reverted with panic code ${String(decoded.args?.[0] ?? "")}`;
    return customErrorMessage(decoded.errorName, decoded.args as readonly unknown[] | undefined);
  } catch {
    return null;
  }
}

function noGas(): string {
  const sym = NETWORK?.nativeSymbol ?? "native token";
  if (NETWORK?.isTestnetProd) {
    return NETWORK.sandbox
      ? `Not enough ${sym} for gas: use the sandbox faucet on the Wallet tab.`
      : `Not enough testnet ${sym} for gas and the execution fee. Use the test MON drip in the order panel or on the Wallet tab (once per wallet), or faucet.monad.xyz.`;
  }
  return NETWORK?.isMainnet
    ? `Not enough ${sym} in your wallet for gas (and the order execution / Pyth fees). Send some ${sym} to your wallet address.`
    : `Not enough ${sym} for gas: request test funds on the Wallet tab.`;
}

export function readableError(err: unknown): string {
  if (err instanceof ChainActionError) return err.message;
  if (err instanceof BaseError) {
    const data = extractRevertData(err);
    if (data) {
      const msg = decodeRevert(data);
      if (msg) return msg;
    }
    const rejected = err.walk((e) => e instanceof UserRejectedRequestError || (e as { code?: unknown }).code === 4001);
    if (rejected) return "Request rejected in the wallet.";
    if (err.walk((e) => e instanceof InsufficientFundsError)) {
      return noGas();
    }
    if (err.walk((e) => e instanceof ChainMismatchError)) {
      return `Wallet is on the wrong network: expected ${NETWORK?.label ?? "the configured chain"}.`;
    }
    if (err.walk((e) => e instanceof WaitForTransactionReceiptTimeoutError)) {
      return "Timed out waiting for the transaction receipt; it may still confirm.";
    }
    if (err.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError)) {
      return `RPC unreachable (${NETWORK?.rpcUrl ?? "no RPC"}).`;
    }
    const short = err.shortMessage || err.message;
    if (/execution reverted/i.test(short)) return "Transaction would revert (no reason given).";
    if (/insufficient funds/i.test(err.message)) {
      return noGas();
    }
    return short.split("\n")[0];
  }
  if (err instanceof Error) {
    if (/user rejected|denied/i.test(err.message)) return "Request rejected in the wallet.";
    return err.message.split("\n")[0];
  }
  return "Unknown error";
}
