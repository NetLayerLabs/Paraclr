"use client";

// The PnL card for a position that ended in a liquidation auction (taken), with what the trader
// kept vs the fixed-penalty liquidation. Only for a one-leg account: a take closes every leg at
// once and the comparison is per account, so on a multi-leg account the kept number would not
// belong to any one position (the banner tile still shows it).

import { parseEventLogs, parseAbiItem, type Hex } from "viem";
import { publicClient } from "@/lib/chain/clients";
import { priceToNumber } from "@/lib/chain/units";
import type { AuctionRecord } from "@/lib/chain/auctionFeed";
import { keptVsFixed } from "@/lib/kept";
import type { PnlCardData } from "@/lib/pnlCard";
import type { Position } from "@/lib/types";
import { cardNetwork } from "./PnlCard";

const POSITION_UPDATED = parseAbiItem(
  "event PositionUpdated(address indexed account, uint8 indexed lane, bytes32 indexed market, bool isLong, uint256 size, uint256 entryPrice, uint256 entryNotional, uint256 margin, uint256 price, int256 realizedPnl)",
);

/**
 * `start` = equity / notional at AuctionStarted (AUSD). `positions` = the account's legs as last
 * seen during the auction. Null unless every input is known and the account had exactly one leg.
 */
export async function auctionCard(
  r: AuctionRecord,
  start: { equity: number; notional: number } | null,
  positions: readonly Position[],
): Promise<PnlCardData | null> {
  if (r.status !== "backstop" && r.status !== "external") return null;
  if (!start || r.traderResidual === null || !r.txHash || positions.length !== 1) return null;
  const pos = positions[0]!;
  const k = keptVsFixed({ notional: start.notional, equityAtStart: start.equity, traderResidual: r.traderResidual });
  if (!k) return null;
  // The take closes the leg at the oracle mark: its PositionUpdated (size 0) has the exit price and PnL.
  const receipt = await publicClient().getTransactionReceipt({ hash: r.txHash as Hex });
  const logs = parseEventLogs({ abi: [POSITION_UPDATED], logs: receipt.logs, strict: true });
  const leg = logs.find(
    (l) =>
      l.args.account.toLowerCase() === r.account &&
      l.args.size === BigInt(0) &&
      (!pos.marketId || l.args.market.toLowerCase() === pos.marketId.toLowerCase()),
  );
  if (!leg) return null;
  const pnl = Number(leg.args.realizedPnl) / 1e6;
  return {
    symbol: pos.symbol,
    side: pos.side,
    leverage: pos.leverage,
    entry: pos.entryPrice,
    exit: priceToNumber(leg.args.price),
    pnl,
    pnlPct: pos.margin > 0 ? (pnl / pos.margin) * 100 : 0,
    network: cardNetwork(true),
    at: Math.floor(Date.now() / 1000),
    kept: k.kept,
  };
}
