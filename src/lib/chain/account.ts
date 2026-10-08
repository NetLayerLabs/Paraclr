// One consistent read of the signed-in account from chain: collateral,
// health, free collateral, positions, wallet balances and the oracle marks
// they were valued at - all in one multicall (Monad) / parallel batch (anvil).

import type { Address } from "viem";
import { MARKETS, type MarketSymbol, type Position } from "../types";
import { mockAUSDAbi, mockOracleAbi, paraclrClearinghouseAbi } from "./abi";
import type { AuctionState } from "./fair";
import { fairAbi } from "./fairAbi";
import { getLatestBlock, publicClient, readMany } from "./clients";
import { readableError } from "./errors";
import type { LiveContracts } from "./runtime";
import { readProdAccountSnapshot } from "./prod/account";
import { ausdToNumber, nativeToNumber, priceToNumber, sizeToNumber } from "./units";

/** Must match ParaclrClearinghouse.MAINTENANCE_MARGIN_BPS (250). */
export const CHAIN_MAINTENANCE_MARGIN = 0.025;

export interface ChainAccountSnapshot {
  address: Address;
  /** Block the read was anchored to (latest seen by the block watcher). */
  block: number | null;
  lane: number;
  registered: boolean;
  /** Deposited AUSD (can dip below 0 transiently under cross margin). */
  collateral: number;
  /** collateral + Σ uPnL. Null when `accountHealth` reverted (e.g. stale oracle). */
  equity: number | null;
  maintenanceMargin: number | null;
  initialMargin: number | null;
  notional: number | null;
  freeCollateral: number | null;
  freeCollateralUnits: bigint;
  walletAusd: number;
  walletAusdUnits: bigint;
  allowanceUnits: bigint;
  native: number;
  nativeUnits: bigint;
  positions: Position[];
  /** Oracle marks at read time (only markets with a price). */
  marks: Partial<Record<MarketSymbol, number>>;
  liquidatable: boolean;
  /**
   * Liquidation auction state (`auctionOf`). Null when the deployment has no
   * auctions (pre-auction contracts) or the read failed.
   */
  auction: AuctionState | null;
  healthError: string | null;
  readAt: number;
  /** Production only: exact collateral, margin escrowed by pending orders, Σ position margins (6 dp). */
  collateralUnits?: bigint;
  reservedMarginUnits?: bigint;
  marginSumUnits?: bigint;
  /** Production only: equity / free collateral estimated at the Pyth (Hermes) price, not read on chain. */
  estimated?: boolean;
}

interface Leg {
  symbol: MarketSymbol;
  dir: 1 | -1;
  size: number;
  entry: number;
  mark: number;
}

/**
 * Cross-margin liquidation price of one leg, holding the other legs at their
 * current marks: solve  C + Σpnl = MM · Σ|size·mark|  for this leg's mark.
 */
export function crossLiquidationPrice(collateral: number, legs: Leg[], index: number, mm = CHAIN_MAINTENANCE_MARGIN): number {
  const leg = legs[index];
  let otherPnl = 0;
  let otherNotional = 0;
  legs.forEach((l, i) => {
    if (i === index) return;
    otherPnl += l.dir * (l.mark - l.entry) * l.size;
    otherNotional += l.size * l.mark;
  });
  const s = leg.size;
  if (!(s > 0)) return 0;
  const p =
    leg.dir === 1
      ? (s * leg.entry - collateral - otherPnl + mm * otherNotional) / (s * (1 - mm))
      : (collateral + otherPnl + s * leg.entry - mm * otherNotional) / (s * (1 + mm));
  return Math.max(0, p);
}

export async function readAccountSnapshot(address: Address, c: LiveContracts): Promise<ChainAccountSnapshot> {
  // The production contract has its own account / position layout and Pyth marks.
  if (c.production) return readProdAccountSnapshot(address, c);
  const ch = c.clearinghouse;
  const ids = MARKETS.map((s) => c.markets[s]);
  const pc = publicClient();

  const [res, nativeUnits] = await Promise.all([
    readMany({
      contracts: [
        { address: ch, abi: paraclrClearinghouseAbi, functionName: "getAccount", args: [address] },
        { address: ch, abi: paraclrClearinghouseAbi, functionName: "accountHealth", args: [address] },
        { address: ch, abi: paraclrClearinghouseAbi, functionName: "freeCollateral", args: [address] },
        { address: c.ausd, abi: mockAUSDAbi, functionName: "balanceOf", args: [address] },
        { address: c.ausd, abi: mockAUSDAbi, functionName: "allowance", args: [address, ch] },
        { address: ch, abi: paraclrClearinghouseAbi, functionName: "getPosition", args: [address, ids[0]] },
        { address: ch, abi: paraclrClearinghouseAbi, functionName: "getPosition", args: [address, ids[1]] },
        { address: ch, abi: paraclrClearinghouseAbi, functionName: "getPosition", args: [address, ids[2]] },
        { address: c.oracle, abi: mockOracleAbi, functionName: "getPrice", args: [ids[0]] },
        { address: c.oracle, abi: mockOracleAbi, functionName: "getPrice", args: [ids[1]] },
        { address: c.oracle, abi: mockOracleAbi, functionName: "getPrice", args: [ids[2]] },
        { address: ch, abi: fairAbi, functionName: "auctionOf", args: [address] },
      ],
    }),
    pc.getBalance({ address }),
  ]);

  const [acct, health, free, bal, allowance, p0, p1, p2, o0, o1, o2, auc] = res;
  if (acct.status !== "success") throw acct.error;
  const [collateralUnits, lane, registered] = acct.result;

  const marks: Partial<Record<MarketSymbol, number>> = {};
  [o0, o1, o2].forEach((o, i) => {
    if (o.status === "success" && o.result[0] > BigInt(0)) marks[MARKETS[i]] = priceToNumber(o.result[0]);
  });

  const collateral = ausdToNumber(collateralUnits);
  const legs: Leg[] = [];
  const raw: { symbol: MarketSymbol; marketId: string; pos: { isLong: boolean; leverage: number; size: bigint; entryPrice: bigint; margin: bigint } }[] = [];
  [p0, p1, p2].forEach((p, i) => {
    if (p.status !== "success" || p.result.size === BigInt(0)) return;
    const symbol = MARKETS[i];
    raw.push({ symbol, marketId: ids[i], pos: p.result });
    const entry = priceToNumber(p.result.entryPrice);
    legs.push({
      symbol,
      dir: p.result.isLong ? 1 : -1,
      size: sizeToNumber(p.result.size),
      entry,
      mark: marks[symbol] ?? entry,
    });
  });

  const positions: Position[] = raw.map((r, i) => ({
    id: `chain:${r.symbol}`,
    owner: address,
    symbol: r.symbol,
    side: r.pos.isLong ? "long" : "short",
    size: legs[i].size,
    entryPrice: legs[i].entry,
    margin: ausdToNumber(r.pos.margin),
    leverage: r.pos.leverage,
    openedAt: 0,
    liquidationPrice: crossLiquidationPrice(collateral, legs, i),
    marketId: r.marketId,
    sizeUnits: r.pos.size,
  }));

  let equity: number | null = null;
  let maintenanceMargin: number | null = null;
  let initialMargin: number | null = null;
  let notional: number | null = null;
  let healthError: string | null = null;
  if (health.status === "success") {
    const [eq, mm, im, n] = health.result;
    equity = ausdToNumber(eq);
    maintenanceMargin = ausdToNumber(mm);
    initialMargin = ausdToNumber(im);
    notional = ausdToNumber(n);
  } else {
    healthError = readableError(health.error);
  }

  const freeCollateralUnits = free.status === "success" ? free.result : BigInt(0);
  const walletAusdUnits = bal.status === "success" ? bal.result : BigInt(0);
  const latest = getLatestBlock();

  return {
    address,
    block: latest === null ? null : Number(latest),
    lane: Number(lane),
    registered,
    collateral,
    equity,
    maintenanceMargin,
    initialMargin,
    notional,
    freeCollateral: free.status === "success" ? ausdToNumber(free.result) : null,
    freeCollateralUnits,
    walletAusd: ausdToNumber(walletAusdUnits),
    walletAusdUnits,
    allowanceUnits: allowance.status === "success" ? allowance.result : BigInt(0),
    native: nativeToNumber(nativeUnits),
    nativeUnits,
    positions,
    marks,
    liquidatable:
      positions.length > 0 && equity !== null && maintenanceMargin !== null && equity < maintenanceMargin,
    auction:
      auc.status === "success"
        ? { active: auc.result[0], startBlock: Number(auc.result[1]), discountBps: Number(auc.result[2]) }
        : null,
    healthError,
    readAt: Date.now(),
  };
}
