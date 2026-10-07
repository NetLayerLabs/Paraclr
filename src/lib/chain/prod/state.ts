// Production state read from ParaclrClearinghouseProd: pause flag, fees,
// order timing, caps and their utilisation, per-market funding, and the
// signed-in account's pending order ids / claimable execution fees. Every
// read is allowFailure: a view the deployment doesn't expose renders as "—",
// never as a guessed number.
//
// Units: AUSD 6 dp · prices 1e18 · funding rate 1e18 = 100% of entry notional
// per second (> 0: longs pay) · times in seconds · leverage whole x.

import type { Abi, Address } from "viem";
import { MARKETS, type MarketSymbol } from "../../types";
import { readMany, publicClient } from "../clients";
import type { LiveContracts } from "../runtime";
import { ausdToNumber, priceToNumber } from "../units";
import { prodAbi } from "./abi";

export interface ProdParams {
  /** Native wei the order must carry for the executing keeper. */
  minExecutionFee: bigint | null;
  minExecDelay: number | null;
  maxExecDelay: number | null;
  tradingFeeBps: number | null;
  maxLeverage: number | null;
  /** AUSD. */
  maxDepositPerAccount: number | null;
  maxTvlPerLane: number | null;
  minPositionNotional: number | null;
  /** Seconds between `updateFunding` calls. */
  fundingInterval: number | null;
  /** Oldest Pyth price (s) the contract accepts for a "fresh" use. */
  maxPriceAge: number | null;
  /** Max Pyth confidence / price (bps). */
  maxConfBps: number | null;
}

export interface ProdMarket {
  /** Fraction of entry notional per second (+ = longs pay shorts). */
  fundingRatePerSec: number | null;
  lastFundingUpdate: number | null;
  nextFundingUpdate: number | null;
  /** Pyth price stored on chain (what views value positions at) and its publish time. */
  onchainPrice: number | null;
  onchainPublishTime: number | null;
  /** Global open interest (Σ lanes), AUSD notional. */
  globalOi: { long: number; short: number } | null;
}

export interface ProdLane {
  lane: number;
  /** AUSD counted against the lane TVL cap (trader collateral + pool cash). */
  tvl: number | null;
  /** AUSD notional per market (entry notional). */
  oi: Record<MarketSymbol, { long: number; short: number } | null>;
  /** Per-side OI cap per market: min(market cap, (insurance + pool cash) × multiplier). */
  oiCap: Record<MarketSymbol, number | null>;
}

export interface ProdMine {
  /** Claimable native MON (execution fees earned as an executor, refunds that couldn't be pushed). */
  feesOwed: bigint | null;
  /** Pending order id per market (the contract allows one per market). */
  pending: Partial<Record<MarketSymbol, bigint>>;
}

export interface ProdState {
  status: "loading" | "ready" | "error";
  paused: boolean | null;
  params: ProdParams;
  markets: Record<MarketSymbol, ProdMarket>;
  /** The lane of the signed-in account (null when signed out). */
  lane: ProdLane | null;
  mine: ProdMine | null;
  /** Latest block timestamp (s) and when it was read (ms, local clock). */
  chainTime: number | null;
  chainTimeAt: number;
  block: number | null;
  error: string | null;
}

const byMarket = <T>(v: T) => Object.fromEntries(MARKETS.map((m) => [m, v])) as Record<MarketSymbol, T>;

export const EMPTY_PARAMS: ProdParams = {
  minExecutionFee: null,
  minExecDelay: null,
  maxExecDelay: null,
  tradingFeeBps: null,
  maxLeverage: null,
  maxDepositPerAccount: null,
  maxTvlPerLane: null,
  minPositionNotional: null,
  fundingInterval: null,
  maxPriceAge: null,
  maxConfBps: null,
};

export const EMPTY_PROD: ProdState = {
  status: "loading",
  paused: null,
  params: EMPTY_PARAMS,
  markets: byMarket<ProdMarket>({
    fundingRatePerSec: null,
    lastFundingUpdate: null,
    nextFundingUpdate: null,
    onchainPrice: null,
    onchainPublishTime: null,
    globalOi: null,
  }),
  lane: null,
  mine: null,
  chainTime: null,
  chainTimeAt: 0,
  block: null,
  error: null,
};

export type R = { status: "success"; result: unknown } | { status: "failure"; error: Error };

/** Untyped batch read: every entry may fail independently. */
export interface LooseCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}
export async function readLoose(calls: LooseCall[]): Promise<R[]> {
  if (calls.length === 0) return [];
  return (await readMany({ contracts: calls as never })) as unknown as R[];
}

export const big = (r: R | undefined): bigint | null =>
  r && r.status === "success" && typeof r.result === "bigint" ? r.result : null;
const num = (r: R | undefined): number | null => {
  const b = big(r);
  return b === null ? null : Number(b);
};
const ausd = (r: R | undefined): number | null => {
  const b = big(r);
  return b === null ? null : ausdToNumber(b);
};
export const tuple = (r: R | undefined): readonly unknown[] | null =>
  r && r.status === "success" && Array.isArray(r.result) ? (r.result as readonly unknown[]) : null;

export function signedNumber(v: bigint): number {
  return v < BigInt(0) ? -Number(-v) : Number(v);
}

/** Slow-changing parameters (fees, delays, caps). Changed only through the timelock. */
export async function readProdParams(c: LiveContracts): Promise<ProdParams> {
  const ch = c.clearinghouse;
  const fn = (functionName: string): LooseCall => ({ address: ch, abi: prodAbi, functionName });
  const [fee, minD, maxD, tfee, maxLev, depCap, tvlCap, minN, fInt, age, conf] = await readLoose([
    fn("minExecutionFee"),
    fn("minExecDelay"),
    fn("maxExecDelay"),
    fn("tradingFeeBps"),
    fn("maxLeverage"),
    fn("maxDepositPerAccount"),
    fn("maxTvlPerLane"),
    fn("minPositionNotional"),
    fn("fundingUpdateInterval"),
    fn("maxPriceAge"),
    fn("maxConfBps"),
  ]);
  return {
    minExecutionFee: big(fee),
    minExecDelay: num(minD),
    maxExecDelay: num(maxD),
    tradingFeeBps: num(tfee),
    maxLeverage: num(maxLev),
    maxDepositPerAccount: ausd(depCap),
    maxTvlPerLane: ausd(tvlCap),
    minPositionNotional: ausd(minN),
    fundingInterval: num(fInt),
    maxPriceAge: num(age),
    maxConfBps: num(conf),
  };
}

/** Per-block state: pause, funding, on-chain Pyth prices, the account's lane and own orders/fees. */
export async function readProdDynamic(
  c: LiveContracts,
  lane: number | null,
  account: Address | null,
): Promise<Pick<ProdState, "paused" | "markets" | "lane" | "mine" | "chainTime" | "block">> {
  const ch = c.clearinghouse;
  const ids = MARKETS.map((s) => c.markets[s]);
  const call = (functionName: string, args?: readonly unknown[]): LooseCall => ({
    address: ch,
    abi: prodAbi,
    functionName,
    args,
  });
  const calls: LooseCall[] = [
    call("paused"),
    ...ids.map((id) => call("fundingState", [id])),
    ...ids.map((id) => call("latestPrice", [id])),
    ...ids.map((id) => call("openInterest", [id])),
  ];
  if (lane !== null) {
    calls.push(call("laneTvl", [lane]));
    ids.forEach((id) => calls.push(call("laneOpenInterest", [lane, id])));
    ids.forEach((id) => calls.push(call("laneOiCap", [lane, id])));
  }
  if (account) {
    calls.push(call("executionFeesOwed", [account]));
    ids.forEach((id) => calls.push(call("pendingOrderOf", [account, id])));
  }
  const [res, head] = await Promise.all([
    readLoose(calls),
    publicClient()
      .getBlock({ blockTag: "latest" })
      .catch(() => null),
  ]);

  let i = 0;
  const pausedR = res[i++];
  const funding = MARKETS.map(() => tuple(res[i++]));
  const latest = MARKETS.map(() => tuple(res[i++]));
  const global = MARKETS.map(() => tuple(res[i++]));

  let laneState: ProdLane | null = null;
  if (lane !== null) {
    const tvl = res[i++];
    const ois = MARKETS.map(() => tuple(res[i++]));
    const caps = MARKETS.map(() => res[i++]);
    laneState = {
      lane,
      tvl: ausd(tvl),
      oi: Object.fromEntries(
        MARKETS.map((m, k) => {
          const t = ois[k];
          return [m, t ? { long: ausdToNumber(t[0] as bigint), short: ausdToNumber(t[1] as bigint) } : null];
        }),
      ) as ProdLane["oi"],
      oiCap: Object.fromEntries(MARKETS.map((m, k) => [m, ausd(caps[k])])) as ProdLane["oiCap"],
    };
  }

  let mine: ProdMine | null = null;
  if (account) {
    const owed = big(res[i++]);
    const pending: Partial<Record<MarketSymbol, bigint>> = {};
    MARKETS.forEach((m) => {
      const id = big(res[i++]);
      if (id !== null && id !== BigInt(0)) pending[m] = id;
    });
    mine = { feesOwed: owed, pending };
  }

  const markets = Object.fromEntries(
    MARKETS.map((m, k) => {
      const f = funding[k];
      const p = latest[k];
      const g = global[k];
      const market: ProdMarket = {
        fundingRatePerSec: f ? signedNumber(f[1] as bigint) / 1e18 : null,
        lastFundingUpdate: f ? Number(f[2] as bigint) : null,
        nextFundingUpdate: f ? Number(f[4] as bigint) : null,
        onchainPrice: p ? priceToNumber(p[0] as bigint) : null,
        onchainPublishTime: p ? Number(p[2] as bigint) : null,
        globalOi: g ? { long: ausdToNumber(g[0] as bigint), short: ausdToNumber(g[1] as bigint) } : null,
      };
      return [m, market];
    }),
  ) as Record<MarketSymbol, ProdMarket>;

  return {
    paused: pausedR.status === "success" ? Boolean(pausedR.result) : null,
    markets,
    lane: laneState,
    mine,
    chainTime: head ? Number(head.timestamp) : null,
    block: head ? Number(head.number) : null,
  };
}

/** Chain "now" in seconds, extrapolated from the last block timestamp. */
export function chainNow(s: Pick<ProdState, "chainTime" | "chainTimeAt">, now = Date.now()): number | null {
  if (s.chainTime === null) return null;
  return s.chainTime + Math.max(0, now - s.chainTimeAt) / 1000;
}

/** Funding as % per hour of entry notional (+ = longs pay shorts). */
export function fundingPctPerHour(ratePerSec: number | null): number | null {
  return ratePerSec === null ? null : ratePerSec * 3600 * 100;
}

/** Known Pyth price feed ids (Pyth's official list), used only if neither the deployment nor the contract names one. */
export const PYTH_MAINNET_FEEDS: Record<MarketSymbol, `0x${string}`> = {
  "MON/AUSD": "0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1",
  "SOL/AUSD": "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  "BTC/AUSD": "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
};
