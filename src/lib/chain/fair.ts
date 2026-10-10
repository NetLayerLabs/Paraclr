// Read side of the fair-liquidation clearinghouse (docs/FAIR_LIQUIDATION_PLAN.md):
// auction state + discount clock, backstop pools, and the solvency ledger.
// Every number here is read from the clearinghouse contract.

import { BaseError, ContractFunctionRevertedError, type Address, type Hex } from "viem";
import { LANE_COUNT, MARKETS, type MarketSymbol } from "../types";
import { AUCTION_DEFAULTS, fairAbi } from "./fairAbi";
import { readMany } from "./clients";
import { ausdToNumber, priceToNumber, sizeToNumber } from "./units";

export const LANE_IDS = Array.from({ length: LANE_COUNT }, (_, i) => i);

// ---- discount clock -----------------------------------------------------------

export interface AuctionParams {
  stepBps: number;
  maxDiscountBps: number;
}

export const DEFAULT_AUCTION_PARAMS: AuctionParams = {
  stepBps: AUCTION_DEFAULTS.stepBps,
  maxDiscountBps: AUCTION_DEFAULTS.maxDiscountBps,
};

/** The contract's clock: discount = min(MAX, STEP × (block − startBlock)). */
export function discountBpsAt(startBlock: number, block: number, p: AuctionParams = DEFAULT_AUCTION_PARAMS): number {
  return Math.max(0, Math.min(p.maxDiscountBps, p.stepBps * Math.max(0, block - startBlock)));
}

/** Blocks from `startBlock` until the discount reaches `bps` (0 if already there). */
export function blocksUntil(bps: number, startBlock: number, block: number, p: AuctionParams = DEFAULT_AUCTION_PARAMS): number {
  if (p.stepBps <= 0) return 0;
  const at = startBlock + Math.ceil(bps / p.stepBps);
  return Math.max(0, at - block);
}

export const fmtBps = (bps: number) => `${(bps / 100).toFixed(2)}%`;

export interface ChainAuctionParams extends AuctionParams {
  /** Per-lane backstop pool minimum discount (bps). */
  minDiscountBps: number[];
}

export const DEFAULT_CHAIN_PARAMS: ChainAuctionParams = {
  ...DEFAULT_AUCTION_PARAMS,
  minDiscountBps: Array.from({ length: LANE_COUNT }, () => AUCTION_DEFAULTS.backstopMinDiscountBps),
};

/** `auctionStepBps()`, `auctionMaxDiscountBps()`, `backstopMinDiscountBps(0..7)`. */
export async function readAuctionParams(clearinghouse: Address): Promise<ChainAuctionParams> {
  const [[step, max], mins] = await Promise.all([
    readMany({
      contracts: [
        { address: clearinghouse, abi: fairAbi, functionName: "auctionStepBps" as const },
        { address: clearinghouse, abi: fairAbi, functionName: "auctionMaxDiscountBps" as const },
      ],
    }),
    readMany({
      contracts: LANE_IDS.map((l) => ({
        address: clearinghouse,
        abi: fairAbi,
        functionName: "backstopMinDiscountBps" as const,
        args: [l] as const,
      })),
    }),
  ]);
  if (step.status !== "success") throw step.error;
  return {
    stepBps: Number(step.result),
    maxDiscountBps: max.status === "success" ? Number(max.result) : AUCTION_DEFAULTS.maxDiscountBps,
    minDiscountBps: mins.map((m) => (m.status === "success" ? Number(m.result) : AUCTION_DEFAULTS.backstopMinDiscountBps)),
  };
}

/**
 * True when a read failed because the deployed contract doesn't have the
 * function (a pre-auction deployment): a revert with no data / no reason.
 */
export function isMissingFunction(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  if (reverted) {
    // A missing selector on a contract without a fallback reverts with empty
    // data; viem then reports the generic "execution reverted" reason.
    const empty = !reverted.raw || reverted.raw === "0x";
    const generic = !reverted.reason || /^execution reverted\.?$/i.test(reverted.reason);
    return empty && generic && !reverted.data && !reverted.signature;
  }
  return /returned no data/i.test(err.shortMessage ?? "");
}

// ---- auctions -----------------------------------------------------------------

export interface AuctionState {
  active: boolean;
  startBlock: number;
  discountBps: number;
}

export async function readActiveAuctions(
  clearinghouse: Address,
  cap = 500,
): Promise<{ lane: number; accounts: string[] }[]> {
  const res = await readMany({
    contracts: LANE_IDS.map((l) => ({
      address: clearinghouse,
      abi: fairAbi,
      functionName: "getAuctionAccounts" as const,
      args: [l, BigInt(0), BigInt(cap)] as const,
    })),
  });
  return res.map((r, lane) => {
    if (r.status !== "success") throw r.error;
    return { lane, accounts: (r.result as readonly string[]).map((a) => a.toLowerCase()) };
  });
}

export async function readAuctionStates(clearinghouse: Address, accounts: string[]): Promise<Map<string, AuctionState>> {
  const out = new Map<string, AuctionState>();
  if (accounts.length === 0) return out;
  const res = await readMany({
    contracts: accounts.map((a) => ({
      address: clearinghouse,
      abi: fairAbi,
      functionName: "auctionOf" as const,
      args: [a as Address] as const,
    })),
  });
  res.forEach((r, i) => {
    if (r.status !== "success") return;
    const [active, startBlock, discountBps] = r.result as readonly [boolean, bigint, number];
    out.set(accounts[i], { active, startBlock: Number(startBlock), discountBps: Number(discountBps) });
  });
  return out;
}

// ---- solvency -----------------------------------------------------------------

export interface LaneLedger {
  lane: number;
  collateral: number;
  insurance: number;
  backstopCash: number;
  keeperRewards: number;
  badDebt: number;
  /** collateral + insurance + backstop cash + keeper rewards − bad debt. */
  net: number;
}

export interface SolvencySnapshot {
  ausdHeld: number;
  liabilities: number;
  surplus: number;
  solvent: boolean;
  lanes: LaneLedger[] | null;
  block: number | null;
}

export async function readSolvency(clearinghouse: Address, block: number | null): Promise<SolvencySnapshot> {
  // One batch: `solvency()` plus the eight lane ledgers (mixed views: decoded loosely below).
  type Loose = { status: "success"; result: unknown } | { status: "failure"; error: Error };
  const [s, ...ledgers] = (await readMany({
    contracts: [
      { address: clearinghouse, abi: fairAbi, functionName: "solvency" },
      ...LANE_IDS.map((l) => ({ address: clearinghouse, abi: fairAbi, functionName: "laneLedger", args: [l] })),
    ] as never,
  })) as unknown as Loose[];
  if (s.status !== "success") throw s.error;
  const [ausdHeld, liabilities, surplus, solvent] = s.result as readonly [bigint, bigint, bigint, boolean];
  let lanes: LaneLedger[] | null = ledgers.map((r, lane) => {
    if (r.status !== "success") return null;
    const [collateral, insurance, backstopCash, keeperRewards, badDebt] = (r.result as readonly bigint[]).map(ausdToNumber);
    return {
      lane,
      collateral,
      insurance,
      backstopCash,
      keeperRewards,
      badDebt,
      net: collateral + insurance + backstopCash + keeperRewards - badDebt,
    };
  }) as LaneLedger[];
  if (lanes.some((l) => l === null)) lanes = null;
  return {
    ausdHeld: ausdToNumber(ausdHeld),
    liabilities: ausdToNumber(liabilities),
    surplus: ausdToNumber(surplus),
    solvent,
    lanes,
    block,
  };
}

// ---- backstop pools ------------------------------------------------------------

export interface PoolExposure {
  symbol: MarketSymbol | null;
  marketId: Hex;
  /** Signed base units (+ long / − short) the pool inherited. */
  size: number;
  entry: number;
}

export interface BackstopPool {
  lane: number;
  /** NAV = cash + unrealized PnL of inherited positions at the oracle mark (AUSD). */
  equity: number;
  cash: number;
  unrealizedPnl: number;
  shareSupply: number;
  /** equity / shareSupply; null with no shares. */
  sharePrice: number | null;
  taken: number;
  /** Auction discounts received since deploy (AUSD), NOT annualised. */
  discountEarned: number;
  notionalAbsorbed: number;
  exposure: PoolExposure[];
  myShares: number;
  mySharesUnits: bigint;
  myValue: number;
}

export async function readBackstopPools(
  clearinghouse: Address,
  markets: Record<MarketSymbol, Hex>,
  lp: Address | null,
): Promise<BackstopPool[]> {
  const bySymbol = new Map<string, MarketSymbol>();
  for (const s of MARKETS) bySymbol.set(markets[s].toLowerCase(), s);

  const calls = LANE_IDS.flatMap((l) => [
    { address: clearinghouse, abi: fairAbi, functionName: "backstopNav" as const, args: [l] as const },
    { address: clearinghouse, abi: fairAbi, functionName: "backstopStats" as const, args: [l] as const },
    { address: clearinghouse, abi: fairAbi, functionName: "backstopPositions" as const, args: [l] as const },
    ...(lp
      ? [{ address: clearinghouse, abi: fairAbi, functionName: "backstopSharesOf" as const, args: [l, lp] as const }]
      : []),
  ]);
  const res = await readMany({ contracts: calls });
  const per = lp ? 4 : 3;

  return LANE_IDS.map((lane) => {
    const [nav, stats, pos, mine] = res.slice(lane * per, lane * per + per);
    if (nav.status !== "success") throw nav.error;
    const [equityU, cashU, upnlU, supplyU] = nav.result as readonly [bigint, bigint, bigint, bigint];
    const st = stats?.status === "success" ? (stats.result as readonly [bigint, bigint, bigint]) : null;
    const exposure: PoolExposure[] = [];
    if (pos?.status === "success") {
      const [ids, sizes, entries] = pos.result as readonly [readonly Hex[], readonly bigint[], readonly bigint[]];
      ids.forEach((id, i) => {
        const raw = sizes[i] ?? BigInt(0);
        if (raw === BigInt(0)) return;
        const neg = raw < BigInt(0);
        exposure.push({
          symbol: bySymbol.get(id.toLowerCase()) ?? null,
          marketId: id,
          size: (neg ? -1 : 1) * sizeToNumber(neg ? -raw : raw),
          entry: priceToNumber(entries[i] ?? BigInt(0)),
        });
      });
    }
    const equity = signedAusd(equityU);
    // Shares are minted against AUSD (6dp) - the ratio is decimal-free as long
    // as both use the same scale.
    const shareSupply = ausdToNumber(supplyU);
    const sharePrice = supplyU > BigInt(0) ? equity / shareSupply : null;
    const mySharesUnits = mine?.status === "success" ? (mine.result as bigint) : BigInt(0);
    const myShares = ausdToNumber(mySharesUnits);
    return {
      lane,
      equity,
      cash: ausdToNumber(cashU),
      unrealizedPnl: signedAusd(upnlU),
      shareSupply,
      sharePrice,
      taken: st ? Number(st[0]) : 0,
      discountEarned: st ? ausdToNumber(st[1]) : 0,
      notionalAbsorbed: st ? ausdToNumber(st[2]) : 0,
      exposure,
      myShares,
      mySharesUnits,
      myValue: sharePrice !== null ? myShares * sharePrice : 0,
    };
  });
}

export function signedAusd(v: bigint): number {
  return v < BigInt(0) ? -ausdToNumber(-v) : ausdToNumber(v);
}
