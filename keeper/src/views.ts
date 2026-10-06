// Read-only views for GET /solvency and GET /backstop (docs/FAIR_LIQUIDATION_PLAN.md).
// All amounts are base-10 strings: AUSD raw 6dp; sizes and prices 1e18 (contracts/README.md units).

import { getAddress, isAddress, type Address } from "viem";
import { abis, type DesignRef, type KeeperContext } from "./context";
import { LANE_COUNT } from "./network";
import type { Sweeper } from "./sweeper";

export class ViewError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function pickDesign(ctx: KeeperContext, q: string | null): DesignRef {
  if (q === null || q === "" || q === "paraclr" || q === "paraclr-lanes") return ctx.designs[0];
  if (q === "naive" || q === "naive-shared") {
    const d = ctx.designs.find((x) => x.label === "naive");
    if (!d) throw new ViewError(404, "no naive design deployed (deployments file has no \"naive\")");
    return d;
  }
  throw new ViewError(400, "design must be paraclr | naive");
}

function need(ctx: KeeperContext, feature: "solvency" | "backstop"): void {
  if (!ctx.features[feature]) {
    throw new ViewError(
      501,
      `the deployed clearinghouse has no ${feature === "solvency" ? "solvency()" : "backstop"} API — redeploy the current contracts (npm run dev:chain -- --redeploy)`,
    );
  }
}

const s = (v: bigint) => v.toString();

/** GET /solvency[?design=naive] — proxy of solvency() plus every lane's ledger, at one block. */
export async function solvencyView(ctx: KeeperContext, design: DesignRef) {
  need(ctx, "solvency");
  const blockNumber = await ctx.client.getBlockNumber();
  const read = <T>(functionName: string, args: unknown[] = []) =>
    ctx.client.readContract({
      address: design.address,
      abi: abis.clearinghouse as never,
      functionName: functionName as never,
      args: args as never,
      blockNumber,
    }) as Promise<T>;
  const [sol, shared, ledgers] = await Promise.all([
    read<readonly [bigint, bigint, bigint, boolean]>("solvency"),
    read<boolean>("sharedState"),
    Promise.all(
      Array.from({ length: LANE_COUNT }, (_, lane) => read<readonly [bigint, bigint, bigint, bigint, bigint]>("laneLedger", [lane])),
    ),
  ]);
  const lanes = ledgers.map(([collateral, insurance, backstopCash, keeperRewards, badDebt], lane) => ({
    lane,
    collateral: s(collateral),
    insurance: s(insurance),
    backstopCash: s(backstopCash),
    keeperRewards: s(keeperRewards),
    badDebt: s(badDebt),
  }));
  return {
    chainId: ctx.info.chainId,
    network: ctx.info.network,
    block: Number(blockNumber),
    design: design.design,
    contract: design.address,
    /** true (naive baseline): every lane entry below is the SAME shared ledger. */
    sharedState: shared,
    ausdHeld: s(sol[0]),
    liabilities: s(sol[1]),
    surplus: s(sol[2]),
    solvent: sol[3],
    lanes,
  };
}

/** GET /backstop[?design=naive][&lp=0x…] — per-lane pool NAV, stats, inherited exposure. */
export async function backstopView(ctx: KeeperContext, design: DesignRef, sweeper: Sweeper | null, lpRaw: string | null) {
  need(ctx, "backstop");
  let lp: Address | null = null;
  if (lpRaw) {
    if (!isAddress(lpRaw)) throw new ViewError(400, "lp must be an address");
    lp = getAddress(lpRaw);
  }
  const blockNumber = await ctx.client.getBlockNumber();
  const read = <T>(functionName: string, args: unknown[] = []) =>
    ctx.client.readContract({
      address: design.address,
      abi: abis.clearinghouse as never,
      functionName: functionName as never,
      args: args as never,
      blockNumber,
    }) as Promise<T>;
  const symbolOf = new Map(ctx.markets.map((m) => [m.id.toLowerCase(), m.symbol]));
  const params = sweeper?.auctionParams(design.design);
  const shared = await read<boolean>("sharedState");

  const lanes = await Promise.all(
    Array.from({ length: LANE_COUNT }, async (_, lane) => {
      const [nav, stats, pos, shares] = await Promise.all([
        read<readonly [bigint, bigint, bigint, bigint]>("backstopNav", [lane]),
        read<readonly [bigint, bigint, bigint]>("backstopStats", [lane]),
        read<readonly [readonly `0x${string}`[], readonly bigint[], readonly bigint[]]>("backstopPositions", [lane]),
        lp ? read<bigint>("backstopSharesOf", [lane, lp]) : Promise.resolve(null),
      ]);
      return {
        lane,
        nav: { equity: s(nav[0]), cash: s(nav[1]), unrealizedPnl: s(nav[2]), shareSupply: s(nav[3]) },
        stats: { taken: Number(stats[0]), discountEarned: s(stats[1]), notionalAbsorbed: s(stats[2]) },
        positions: pos[0].map((market, i) => ({
          market,
          symbol: symbolOf.get(market.toLowerCase()) ?? null,
          signedSize: s(pos[1][i]),
          entryPrice: s(pos[2][i]),
        })),
        minDiscountBps: params?.minDiscountBps[lane] ?? ctx.config.backstopMinDiscountBps,
        ...(lp ? { lpShares: s(shares as bigint) } : {}),
      };
    }),
  );
  // Naive baseline: one shared pool reported under every lane — count it once.
  const distinct = shared ? lanes.slice(0, 1) : lanes;
  const sum = (f: (l: (typeof lanes)[number]) => string) => s(distinct.reduce((acc, l) => acc + BigInt(f(l)), BigInt(0)));
  return {
    chainId: ctx.info.chainId,
    network: ctx.info.network,
    block: Number(blockNumber),
    design: design.design,
    contract: design.address,
    /** true (naive baseline): one shared pool, repeated under every lane; totals count it once. */
    sharedState: shared,
    auction: {
      stepBps: params?.stepBps ?? ctx.config.auctionStepBps,
      maxDiscountBps: params?.maxBps ?? ctx.config.auctionMaxDiscountBps,
      source: params?.source ?? "config",
    },
    totals: {
      equity: sum((l) => l.nav.equity),
      cash: sum((l) => l.nav.cash),
      unrealizedPnl: sum((l) => l.nav.unrealizedPnl),
      taken: distinct.reduce((n, l) => n + l.stats.taken, 0),
      discountEarned: sum((l) => l.stats.discountEarned),
      notionalAbsorbed: sum((l) => l.stats.notionalAbsorbed),
    },
    lanes,
    ...(lp ? { lp } : {}),
  };
}
