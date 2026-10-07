"use client";

// Chain writes for the fair-liquidation features. Each step is a real
// transaction tracked by txs.ts (simulate → sign → pending → confirmed).

import { encodeFunctionData, maxUint256, parseEventLogs, type Address, type Hex } from "viem";
import { getState } from "../store";
import { mockAUSDAbi, paraclrClearinghouseAbi } from "./abi";
import { readAccountSnapshot } from "./account";
import { ChainActionError } from "./errors";
import { fairAbi } from "./fairAbi";
import { refreshAccount } from "./trading";
import type { LiveContracts } from "./runtime";
import { getSigner, type ChainSigner } from "./signer";
import { sendTx, serialized } from "./txs";
import { ausdToNumber, ausdToUnits } from "./units";
import { publicClient } from "./clients";
import { requireRiskAck } from "./prod/riskAck";
import { prodAbi } from "./prod/abi";
import { priceUpdateFor } from "./prod/priceUpdate";

function requireLive(): { signer: ChainSigner; c: LiveContracts } {
  const s = getState();
  if (s.chain.status !== "ready" || !s.chain.contracts) throw new ChainActionError("Chain not connected.");
  const signer = getSigner();
  if (!signer || !s.chain.wallet.ready) throw new ChainActionError("Wallet not ready yet — try again in a moment.");
  return { signer, c: s.chain.contracts };
}

const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Approve so the clearinghouse can pull `units` AUSD from the wallet. Demo
 * chains approve once (unlimited); the production contracts get an
 * exact-amount approve every time (real money) after the risk acknowledgement,
 * and nothing is deposited while the guardian has paused deposits.
 */
async function ensureAllowance(
  signer: ChainSigner,
  c: LiveContracts,
  units: bigint,
  walletUnits: bigint,
  allowance: bigint,
  opts: { topUp?: boolean } = {},
) {
  if (c.production) {
    await requireRiskAck(signer.address);
    if (getState().chain.prod?.paused && !opts.topUp) {
      throw new ChainActionError("Deposits are paused by the guardian. Withdrawals and closing still work.");
    }
  }
  if (units > walletUnits) {
    throw new ChainActionError(
      `Not enough AUSD in your wallet: need ${fmt(ausdToNumber(units))}, have ${fmt(ausdToNumber(walletUnits))}.` +
        (c.production ? "" : " Get test AUSD on the Wallet tab."),
    );
  }
  if (allowance < units) {
    await sendTx(signer, {
      label: c.production
        ? `Approve ${fmt(ausdToNumber(units))} ${c.token.symbol} (exact amount)`
        : "Approve AUSD for the clearinghouse",
      to: c.ausd,
      data: encodeFunctionData({
        abi: mockAUSDAbi,
        functionName: "approve",
        args: [c.clearinghouse, c.production ? units : maxUint256],
      }),
    });
  }
}

export interface FairTxResult {
  txHash: Hex;
  block: number;
}

/**
 * Production calls take a `priceUpdate`: the stored Pyth prices when fresh,
 * else a signed update via the keeper's /hermes proxy (prod/priceUpdate.ts).
 * Backstop calls only price anything when the pool holds positions.
 */
async function poolHasPositions(c: LiveContracts, lane: number): Promise<boolean> {
  const [ids] = await publicClient()
    .readContract({ address: c.clearinghouse, abi: fairAbi, functionName: "backstopPositions", args: [lane] })
    .catch(() => [[1]] as unknown as readonly [readonly Hex[]]);
  return ids.length > 0;
}

/** Deposit wallet AUSD into a lane's backstop pool for shares. */
export function backstopDepositOnChain(lane: number, amount: number): Promise<FairTxResult & { shares: bigint | null }> {
  return serialized(async () => {
    const { signer, c } = requireLive();
    const units = ausdToUnits(amount);
    if (units === BigInt(0)) throw new ChainActionError("Enter an AUSD amount.");
    const snap = await readAccountSnapshot(signer.address, c);
    await ensureAllowance(signer, c, units, snap.walletAusdUnits, snap.allowanceUnits);
    const q = c.production ? await priceUpdateFor(c, await poolHasPositions(c, lane), lane) : null;
    const receipt = await sendTx(signer, {
      label: `Deposit ${fmt(amount)} ${c.token.symbol} into the lane ${lane + 1} backstop`,
      to: c.clearinghouse,
      data: q
        ? encodeFunctionData({ abi: prodAbi, functionName: "backstopDeposit", args: [lane, units, q.updateData] })
        : encodeFunctionData({ abi: fairAbi, functionName: "backstopDeposit", args: [lane, units] }),
      value: q && q.fee > BigInt(0) ? q.fee : undefined,
    });
    const [ev] = parseEventLogs({ abi: fairAbi, logs: receipt.logs, eventName: "BackstopDeposit" });
    void refreshAccount();
    return { txHash: receipt.transactionHash, block: Number(receipt.blockNumber), shares: ev ? ev.args.shares : null };
  });
}

/**
 * Production LP exit, step 1: request `shares` (0 cancels). The withdrawal can
 * then be made once, after `backstopWithdrawDelay`, within the 1 h window.
 * Works while paused.
 */
export function backstopRequestWithdrawOnChain(lane: number, shares: bigint): Promise<FairTxResult> {
  return serialized(async () => {
    const { signer, c } = requireLive();
    const receipt = await sendTx(signer, {
      label:
        shares > BigInt(0)
          ? `Request a lane ${lane + 1} backstop withdrawal`
          : `Cancel your lane ${lane + 1} backstop withdrawal request`,
      to: c.clearinghouse,
      data: encodeFunctionData({ abi: prodAbi, functionName: "backstopRequestWithdraw", args: [lane, shares] }),
    });
    return { txHash: receipt.transactionHash, block: Number(receipt.blockNumber) };
  });
}

/**
 * Redeem backstop shares for AUSD (blocked by the contract if it would leave
 * the pool under-margined). Production: step 2, inside the request's window;
 * the lane haircut applies and the event carries the amount actually paid.
 */
export function backstopWithdrawOnChain(
  lane: number,
  shares: bigint,
  approxAusd: number,
): Promise<FairTxResult & { amount: number | null }> {
  return serialized(async () => {
    const { signer, c } = requireLive();
    if (shares <= BigInt(0)) throw new ChainActionError("No shares to withdraw.");
    const q = c.production ? await priceUpdateFor(c, await poolHasPositions(c, lane), lane) : null;
    const receipt = await sendTx(signer, {
      label: `Withdraw ≈${fmt(approxAusd)} ${c.token.symbol} from the lane ${lane + 1} backstop`,
      to: c.clearinghouse,
      data: q
        ? encodeFunctionData({ abi: prodAbi, functionName: "backstopWithdraw", args: [lane, shares, q.updateData] })
        : encodeFunctionData({ abi: fairAbi, functionName: "backstopWithdraw", args: [lane, shares] }),
      value: q && q.fee > BigInt(0) ? q.fee : undefined,
    });
    const [ev] = parseEventLogs({ abi: fairAbi, logs: receipt.logs, eventName: "BackstopWithdraw" });
    void refreshAccount();
    return {
      txHash: receipt.transactionHash,
      block: Number(receipt.blockNumber),
      amount: ev ? ausdToNumber(ev.args.amount) : null,
    };
  });
}

/**
 * Cure the signed-in account's auction: deposit `amount` AUSD from the wallet
 * (deposits are allowed while frozen), then `cancelAuction(self)` if the
 * account is healthy again. The keeper's sweeper also cancels cured accounts;
 * if it got there first, the cancel step is skipped.
 */
export function cureAuctionOnChain(amount: number): Promise<{ cancelled: boolean; stillUnderwater: boolean }> {
  return serialized(async () => {
    const { signer, c } = requireLive();
    const units = ausdToUnits(amount);
    if (units > BigInt(0)) {
      const snap = await readAccountSnapshot(signer.address, c);
      // A cure top-up is allowed while paused (the account holds positions).
      await ensureAllowance(signer, c, units, snap.walletAusdUnits, snap.allowanceUnits, { topUp: true });
      // Production: `depositWithPrice`, so the margin top-up exemption (beyond the caps)
      // is computed at fresh prices even when Pyth storage is stale.
      const u = c.production ? await priceUpdateFor(c, true, snap.lane).catch(() => null) : null;
      await sendTx(signer, {
        label: `Deposit ${fmt(amount)} ${c.token.symbol} to cure the auction`,
        to: c.clearinghouse,
        data: c.production
          ? encodeFunctionData({ abi: prodAbi, functionName: "depositWithPrice", args: [units, u?.updateData ?? []] })
          : encodeFunctionData({ abi: paraclrClearinghouseAbi, functionName: "deposit", args: [units] }),
        value: u && u.fee > BigInt(0) ? u.fee : undefined,
      });
    }
    const after = await readAccountSnapshot(signer.address, c);
    if (!after.auction?.active) {
      void refreshAccount();
      return { cancelled: true, stillUnderwater: false };
    }
    if (after.equity !== null && after.maintenanceMargin !== null && after.equity < after.maintenanceMargin) {
      void refreshAccount();
      return { cancelled: false, stillUnderwater: true };
    }
    const q = c.production ? await priceUpdateFor(c, true, after.lane) : null;
    await sendTx(signer, {
      label: "Cancel your auction (account healthy again)",
      to: c.clearinghouse,
      data: q
        ? encodeFunctionData({ abi: prodAbi, functionName: "cancelAuction", args: [signer.address, q.updateData] })
        : encodeFunctionData({ abi: fairAbi, functionName: "cancelAuction", args: [signer.address] }),
      value: q && q.fee > BigInt(0) ? q.fee : undefined,
    });
    void refreshAccount();
    return { cancelled: true, stillUnderwater: false };
  });
}

/** External take: inherit `account`'s positions at the mark for the current discount (same lane only). */
export function takeOnChain(account: Address): Promise<FairTxResult & { payment: number | null }> {
  return serialized(async () => {
    const { signer, c } = requireLive();
    const q = c.production ? await priceUpdateFor(c, true, Number(BigInt(account) % BigInt(8))) : null;
    const receipt = await sendTx(signer, {
      label: `Take auction ${account.slice(0, 6)}…${account.slice(-4)}`,
      to: c.clearinghouse,
      data: q
        ? encodeFunctionData({ abi: prodAbi, functionName: "take", args: [account, q.updateData] })
        : encodeFunctionData({ abi: fairAbi, functionName: "take", args: [account] }),
      value: q && q.fee > BigInt(0) ? q.fee : undefined,
    });
    const [ev] = parseEventLogs({ abi: fairAbi, logs: receipt.logs, eventName: "AuctionTaken" });
    void refreshAccount();
    return {
      txHash: receipt.transactionHash,
      block: Number(receipt.blockNumber),
      payment: ev ? ausdToNumber(ev.args.payment) : null,
    };
  });
}

/** Current head (for "blocks until" math in the UI). */
export async function headBlock(): Promise<number> {
  return Number(await publicClient().getBlockNumber());
}
