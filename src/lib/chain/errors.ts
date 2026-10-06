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
import { ausdToNumber } from "./units";

const ERROR_ABI = [...paraclrClearinghouseAbi, ...mockAUSDAbi, ...mockOracleAbi].filter(
  (x) => x.type === "error",
) as unknown as Abi;

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
  typeof v === "bigint" ? `${ausdToNumber(v < BigInt(0) ? -v : v).toFixed(2)} AUSD` : "?";

function customErrorMessage(name: string, args: readonly unknown[] | undefined): string {
  const a = args ?? [];
  switch (name) {
    case "PositionExists":
      return "You already have a position in this market. The clearinghouse allows one position per market — close it first.";
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
      return "The oracle price is stale — is the keeper's price pusher running?";
    case "InvalidPrice":
      return "The oracle has no price for this market yet.";
    case "ZeroAmount":
      return "Amount is too small.";
    case "TransferFailed":
      return "AUSD transfer failed — check your AUSD balance and allowance.";
    case "InsufficientBalance":
      return "Not enough AUSD in your wallet.";
    case "InsufficientAllowance":
      return "AUSD allowance too low — approve the clearinghouse first.";
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
      return "That account is healthy again, so it can't be taken — its auction can only be cancelled.";
    case "NotRegistered":
      return "Deposit collateral first: only registered accounts can take an auction.";
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
      return `Not enough ${NETWORK?.nativeSymbol ?? "native token"} for gas — request test funds on the Wallet tab.`;
    }
    if (err.walk((e) => e instanceof ChainMismatchError)) {
      return `Wallet is on the wrong network — expected ${NETWORK?.label ?? "the configured chain"}.`;
    }
    if (err.walk((e) => e instanceof WaitForTransactionReceiptTimeoutError)) {
      return "Timed out waiting for the transaction receipt — it may still confirm.";
    }
    if (err.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError)) {
      return `RPC unreachable (${NETWORK?.rpcUrl ?? "no RPC"}).`;
    }
    const short = err.shortMessage || err.message;
    if (/execution reverted/i.test(short)) return "Transaction would revert (no reason given).";
    if (/insufficient funds/i.test(err.message)) {
      return `Not enough ${NETWORK?.nativeSymbol ?? "native token"} for gas — request test funds on the Wallet tab.`;
    }
    return short.split("\n")[0];
  }
  if (err instanceof Error) {
    if (/user rejected|denied/i.test(err.message)) return "Request rejected in the wallet.";
    return err.message.split("\n")[0];
  }
  return "Unknown error";
}
