"use client";

// Chain-mode trading actions. Each step is a real transaction tracked in
// txs.ts; failures surface as ChainActionError with a readable reason.

import { encodeFunctionData, maxUint256, parseEventLogs, type Address, type Hex } from "viem";
import type { MarketSymbol, Side } from "../types";
import { applyChainAccount, getState, setChainAccountError, setFaucet } from "../store";
import { mockAUSDAbi, paraclrClearinghouseAbi } from "./abi";
import { readAccountSnapshot, type ChainAccountSnapshot } from "./account";
import { ChainActionError, readableError } from "./errors";
import { keeperApi } from "./keeper";
import type { LiveContracts } from "./runtime";
import { getSigner, type ChainSigner } from "./signer";
import { sendTx, serialized, trackExternalTx } from "./txs";
import { ausdToNumber, ausdToUnits, priceToNumber, sizeToNumber } from "./units";

function requireLive(): { signer: ChainSigner; c: LiveContracts } {
  const s = getState();
  if (s.chain.status !== "ready" || !s.chain.contracts) throw new ChainActionError("Chain not connected.");
  const signer = getSigner();
  if (!signer || !s.chain.wallet.ready) throw new ChainActionError("Wallet not ready yet — try again in a moment.");
  return { signer, c: s.chain.contracts };
}

/** Re-read the signed-in account and push it into the store. */
export async function refreshAccount(): Promise<ChainAccountSnapshot | null> {
  const s = getState();
  const address = s.session?.address as Address | undefined;
  if (!address || s.chain.status !== "ready" || !s.chain.contracts) return null;
  try {
    const snap = await readAccountSnapshot(address, s.chain.contracts);
    applyChainAccount(snap);
    return snap;
  } catch (e) {
    setChainAccountError(readableError(e));
    return null;
  }
}

export interface OpenResult {
  symbol: MarketSymbol;
  side: Side;
  entryPrice: number;
  size: number;
  margin: number;
  leverage: number;
  txHash: Hex;
  block: number;
}

/**
 * Swipe → (approve + deposit if needed) → openPosition. Free collateral is
 * topped up from the wallet only by the shortfall (+1% buffer when other legs
 * are open, since their PnL moves between blocks).
 */
export function openPositionOnChain(args: {
  symbol: MarketSymbol;
  side: Side;
  margin: number;
  leverage: number;
}): Promise<OpenResult> {
  return serialized(async () => {
    const { signer, c } = requireLive();
    const snap = await readAccountSnapshot(signer.address, c);
    applyChainAccount(snap);
    if (snap.positions.some((p) => p.symbol === args.symbol)) {
      throw new ChainActionError(
        `You already have a ${args.symbol.split("/")[0]} position. The clearinghouse allows one position per market — close it first.`,
      );
    }
    const marginUnits = ausdToUnits(args.margin);
    if (marginUnits === BigInt(0)) throw new ChainActionError("Enter an AUSD margin.");

    const free = snap.freeCollateralUnits;
    let need = marginUnits > free ? marginUnits - free : BigInt(0);
    if (need > BigInt(0) && snap.positions.length > 0) need += marginUnits / BigInt(100);
    if (need > snap.walletAusdUnits) {
      const shortfall = marginUnits > free ? marginUnits - free : BigInt(0);
      if (shortfall > snap.walletAusdUnits) {
        throw new ChainActionError(
          `Not enough AUSD: need ${ausdToNumber(shortfall).toFixed(2)} more than your ${ausdToNumber(free).toFixed(2)} free collateral, wallet has ${snap.walletAusd.toFixed(2)}. Request test funds on the Wallet tab.`,
        );
      }
      need = snap.walletAusdUnits; // buffer doesn't fit; deposit what we have
    }

    if (need > BigInt(0)) {
      if (snap.allowanceUnits < need) {
        await sendTx(signer, {
          label: "Approve AUSD for the clearinghouse",
          to: c.ausd,
          data: encodeFunctionData({ abi: mockAUSDAbi, functionName: "approve", args: [c.clearinghouse, maxUint256] }),
        });
      }
      await sendTx(signer, {
        label: `Deposit ${ausdToNumber(need).toFixed(2)} AUSD`,
        to: c.clearinghouse,
        data: encodeFunctionData({ abi: paraclrClearinghouseAbi, functionName: "deposit", args: [need] }),
      });
    }

    const base = args.symbol.split("/")[0];
    const receipt = await sendTx(signer, {
      label: `Open ${args.side === "long" ? "long" : "short"} ${args.leverage}x ${base}`,
      to: c.clearinghouse,
      data: encodeFunctionData({
        abi: paraclrClearinghouseAbi,
        functionName: "openPosition",
        args: [c.markets[args.symbol], args.side === "long", marginUnits, BigInt(args.leverage)],
      }),
    });
    const [opened] = parseEventLogs({ abi: paraclrClearinghouseAbi, logs: receipt.logs, eventName: "PositionOpened" });
    void refreshAccount();
    return {
      symbol: args.symbol,
      side: args.side,
      entryPrice: opened ? priceToNumber(opened.args.entryPrice) : 0,
      size: opened ? sizeToNumber(opened.args.size) : 0,
      margin: args.margin,
      leverage: args.leverage,
      txHash: receipt.transactionHash,
      block: Number(receipt.blockNumber),
    };
  });
}

export interface CloseResult {
  realizedPnl: number;
  exitPrice: number;
  txHash: Hex;
  block: number;
}

export function closePositionOnChain(symbol: MarketSymbol): Promise<CloseResult> {
  return serialized(async () => {
    const { signer, c } = requireLive();
    const receipt = await sendTx(signer, {
      label: `Close ${symbol.split("/")[0]} position`,
      to: c.clearinghouse,
      data: encodeFunctionData({ abi: paraclrClearinghouseAbi, functionName: "closePosition", args: [c.markets[symbol]] }),
    });
    const [closed] = parseEventLogs({ abi: paraclrClearinghouseAbi, logs: receipt.logs, eventName: "PositionClosed" });
    void refreshAccount();
    return {
      realizedPnl: closed ? ausdToNumber(closed.args.realizedPnl) : 0,
      exitPrice: closed ? priceToNumber(closed.args.exitPrice) : 0,
      txHash: receipt.transactionHash,
      block: Number(receipt.blockNumber),
    };
  });
}

/** Withdraw all free collateral back to the wallet. */
export function withdrawFreeCollateral(): Promise<number> {
  return serialized(async () => {
    const { signer, c } = requireLive();
    const snap = await readAccountSnapshot(signer.address, c);
    if (snap.freeCollateralUnits === BigInt(0)) throw new ChainActionError("No free collateral to withdraw.");
    await sendTx(signer, {
      label: `Withdraw ${ausdToNumber(snap.freeCollateralUnits).toFixed(2)} AUSD`,
      to: c.clearinghouse,
      data: encodeFunctionData({ abi: paraclrClearinghouseAbi, functionName: "withdraw", args: [snap.freeCollateralUnits] }),
    });
    void refreshAccount();
    return ausdToNumber(snap.freeCollateralUnits);
  });
}

/** Fallback when the keeper faucet is down: MockAUSD.mint is public (needs gas). */
export function mintTestAusd(amount = 1_000): Promise<void> {
  return serialized(async () => {
    const { signer, c } = requireLive();
    await sendTx(signer, {
      label: `Mint ${amount.toLocaleString("en-US")} test AUSD`,
      to: c.ausd,
      data: encodeFunctionData({ abi: mockAUSDAbi, functionName: "mint", args: [signer.address, ausdToUnits(amount)] }),
    });
    void refreshAccount();
  });
}

// ---- faucet --------------------------------------------------------------------

/** Below these the wallet is considered unfunded and the keeper faucet is called. */
const MIN_NATIVE = 0.005;
const MIN_AUSD = 100;

/**
 * Ask the keeper faucet for gas + 10,000 AUSD. With `onlyIfLow`, skip when the
 * account already has enough of both (so re-signing in doesn't spam it).
 */
export async function requestFaucet(address: Address, { onlyIfLow }: { onlyIfLow: boolean }): Promise<void> {
  const s = getState();
  if (s.chain.status !== "ready" || !s.chain.contracts) return;
  if (onlyIfLow) {
    setFaucet({ status: "checking", message: null });
    const snap = await refreshAccount();
    if (snap && snap.native >= MIN_NATIVE && snap.walletAusd + snap.collateral >= MIN_AUSD) {
      setFaucet({ status: "skipped", message: "Wallet already funded." });
      return;
    }
  }
  setFaucet({ status: "requesting", message: "Requesting test gas + AUSD from the keeper faucet…" });
  try {
    const r = await keeperApi.faucet(address);
    setFaucet({
      status: "requesting",
      message: "Faucet transactions sent — waiting for confirmation…",
      gasTxHash: r.gasTxHash ?? null,
      ausdTxHash: r.ausdTxHash ?? null,
    });
    await Promise.all([
      r.gasTxHash ? trackExternalTx("Faucet: test gas", r.gasTxHash) : null,
      r.ausdTxHash ? trackExternalTx("Faucet: 10,000 test AUSD", r.ausdTxHash) : null,
    ]);
    await refreshAccount();
    setFaucet({ status: "funded", message: "Funded by the keeper faucet." });
  } catch (e) {
    setFaucet({ status: "failed", message: readableError(e) });
  }
}
