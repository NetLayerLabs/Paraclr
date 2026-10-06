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

function requireLive(): { signer: ChainSigner; c: LiveContracts } {
  const s = getState();
  if (s.chain.status !== "ready" || !s.chain.contracts) throw new ChainActionError("Chain not connected.");
  const signer = getSigner();
  if (!signer || !s.chain.wallet.ready) throw new ChainActionError("Wallet not ready yet — try again in a moment.");
  return { signer, c: s.chain.contracts };
}

const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Approve (once) so the clearinghouse can pull `units` AUSD from the wallet. */
async function ensureAllowance(signer: ChainSigner, c: LiveContracts, units: bigint, walletUnits: bigint, allowance: bigint) {
  if (units > walletUnits) {
    throw new ChainActionError(
      `Not enough AUSD in your wallet: need ${fmt(ausdToNumber(units))}, have ${fmt(ausdToNumber(walletUnits))}. Get test AUSD on the Wallet tab.`,
    );
  }
  if (allowance < units) {
    await sendTx(signer, {
      label: "Approve AUSD for the clearinghouse",
      to: c.ausd,
      data: encodeFunctionData({ abi: mockAUSDAbi, functionName: "approve", args: [c.clearinghouse, maxUint256] }),
    });
  }
}

export interface FairTxResult {
  txHash: Hex;
  block: number;
}

/** Deposit wallet AUSD into a lane's backstop pool for shares. */
export function backstopDepositOnChain(lane: number, amount: number): Promise<FairTxResult & { shares: bigint | null }> {
  return serialized(async () => {
    const { signer, c } = requireLive();
    const units = ausdToUnits(amount);
    if (units === BigInt(0)) throw new ChainActionError("Enter an AUSD amount.");
    const snap = await readAccountSnapshot(signer.address, c);
    await ensureAllowance(signer, c, units, snap.walletAusdUnits, snap.allowanceUnits);
    const receipt = await sendTx(signer, {
      label: `Deposit ${fmt(amount)} AUSD into the lane ${lane + 1} backstop`,
      to: c.clearinghouse,
      data: encodeFunctionData({ abi: fairAbi, functionName: "backstopDeposit", args: [lane, units] }),
    });
    const [ev] = parseEventLogs({ abi: fairAbi, logs: receipt.logs, eventName: "BackstopDeposit" });
    void refreshAccount();
    return { txHash: receipt.transactionHash, block: Number(receipt.blockNumber), shares: ev ? ev.args.shares : null };
  });
}

/** Redeem backstop shares for AUSD (blocked by the contract if it would leave the pool under-margined). */
export function backstopWithdrawOnChain(lane: number, shares: bigint, approxAusd: number): Promise<FairTxResult & { amount: number | null }> {
  return serialized(async () => {
    const { signer, c } = requireLive();
    if (shares <= BigInt(0)) throw new ChainActionError("No shares to withdraw.");
    const receipt = await sendTx(signer, {
      label: `Withdraw ≈${fmt(approxAusd)} AUSD from the lane ${lane + 1} backstop`,
      to: c.clearinghouse,
      data: encodeFunctionData({ abi: fairAbi, functionName: "backstopWithdraw", args: [lane, shares] }),
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
      await ensureAllowance(signer, c, units, snap.walletAusdUnits, snap.allowanceUnits);
      await sendTx(signer, {
        label: `Deposit ${fmt(amount)} AUSD to cure the auction`,
        to: c.clearinghouse,
        data: encodeFunctionData({ abi: paraclrClearinghouseAbi, functionName: "deposit", args: [units] }),
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
    await sendTx(signer, {
      label: "Cancel your auction (account healthy again)",
      to: c.clearinghouse,
      data: encodeFunctionData({ abi: fairAbi, functionName: "cancelAuction", args: [signer.address] }),
    });
    void refreshAccount();
    return { cancelled: true, stillUnderwater: false };
  });
}

/** External take: inherit `account`'s positions at the mark for the current discount (same lane only). */
export function takeOnChain(account: Address): Promise<FairTxResult & { payment: number | null }> {
  return serialized(async () => {
    const { signer, c } = requireLive();
    const receipt = await sendTx(signer, {
      label: `Take auction ${account.slice(0, 6)}…${account.slice(-4)}`,
      to: c.clearinghouse,
      data: encodeFunctionData({ abi: fairAbi, functionName: "take", args: [account] }),
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
