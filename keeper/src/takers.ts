// Demo external takers: keeper-operated accounts that bid in the liquidation auctions, so the
// Dutch auction has real price discovery instead of the lane pool being the only bidder.
//
// THESE ARE DEMO BOTS RUN BY THE KEEPER. Every report that includes their takes says so
// (`RunReport.auctions.externalTakers.demo = true`).
//
//   - `perLane` accounts per lane, each with a key derived from keccak(operator key, seed, lane, i,
//     attempt) and searched until `uint160(address) % 8 == lane` (take() requires a same-lane taker).
//     Derived from the operator key, so they are as secret as the operator key itself.
//   - Each has a reservation discount drawn uniformly from [minBps, maxBps] (seeded RNG): it takes
//     an auction once the discount it would actually be paid — min(d × notional, max(equity, 0)) /
//     notional, the contract's external-take cap — reaches its reservation, and an eth_call of the
//     take succeeds (same-lane, initial margin after inheriting, …).
//   - Collateral comes from the demo-only `seedAccounts` (owner-funded, no positions); native gas
//     from anvil_setBalance on anvil, or an operator transfer on Monad (DEMO_TAKERS is off there
//     unless set).
//   - After a take the taker closes every inherited leg at mark (closePosition) on the next block,
//     so it never accumulates risk.

import { encodeAbiParameters, formatEther, keccak256, parseEther, type Address, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { abis, type DesignRef, type KeeperContext } from "./context";
import { LANE_COUNT } from "./network";
import { rng, seedBook } from "./seed";
import { waitForReceipt } from "./sender";

export interface DemoTaker {
  lane: number;
  index: number;
  account: LocalAccount;
  address: Address;
  reservationBps: number;
}

export interface DemoTakerConfig {
  seed: number;
  perLane: number;
  minBps: number;
  maxBps: number;
  /** AUSD (6dp) of collateral per taker per design. */
  collateral: bigint;
}

export interface DemoTakerSet {
  config: DemoTakerConfig;
  takers: DemoTaker[];
}

/** Deterministic takers for `cfg.seed` (keys salted with the operator key; never printed). */
export function deriveTakers(ctx: KeeperContext, cfg: DemoTakerConfig): DemoTaker[] {
  if (cfg.minBps < 0 || cfg.maxBps < cfg.minBps) throw new Error("demo taker reservation range must satisfy 0 <= min <= max");
  const rand = rng(cfg.seed);
  const out: DemoTaker[] = [];
  for (let lane = 0; lane < LANE_COUNT; lane++) {
    for (let i = 0; i < cfg.perLane; i++) {
      let account: LocalAccount | null = null;
      for (let attempt = 0; attempt < 1_000 && !account; attempt++) {
        const pk = keccak256(
          encodeAbiParameters(
            [{ type: "bytes32" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
            [ctx.roles.secret, "paraclr-demo-taker", BigInt(cfg.seed), BigInt(lane), BigInt(i), BigInt(attempt)],
          ),
        );
        const a = privateKeyToAccount(pk);
        if (Number(BigInt(a.address) % BigInt(LANE_COUNT)) === lane) account = a;
      }
      if (!account) throw new Error(`could not derive a lane-${lane} demo taker`);
      const reservationBps = Math.round(cfg.minBps + rand() * (cfg.maxBps - cfg.minBps));
      out.push({ lane, index: i, account, address: account.address, reservationBps });
    }
  }
  return out;
}

/**
 * Fund `takers` on every design: native gas for their own txs, and `cfg.collateral` AUSD of
 * collateral per design (topped up via seedAccounts; no positions). Idempotent.
 */
export async function setupTakers(
  ctx: KeeperContext,
  set: DemoTakerSet,
  designs: DesignRef[],
  log: (m: string) => void = console.log,
): Promise<void> {
  const { client } = ctx;
  const { takers, config } = set;

  // 1. Gas.
  if (ctx.info.network === "anvil") {
    const min = parseEther("100");
    await Promise.all(
      takers.map(async (t) => {
        if ((await client.getBalance({ address: t.address })) >= min) return;
        await client.request({
          method: "anvil_setBalance" as never,
          params: [t.address, `0x${parseEther("1000").toString(16)}`] as never,
        });
      }),
    );
  } else {
    const target = parseEther(process.env.DEMO_TAKER_GAS_MON?.trim() || "0.5");
    const op = ctx.senders.for(ctx.roles.operator);
    // Monad reserve-balance rule: below 10 MON a value transfer must be the sender's first tx in 3
    // blocks, and the operator has usually just sent the seeding txs. Wait 3 blocks before the first.
    const start = await client.getBlockNumber();
    while ((await client.getBlockNumber()) < start + BigInt(3)) await new Promise((r) => setTimeout(r, 300));
    for (const t of takers) {
      const bal = await client.getBalance({ address: t.address });
      if (bal >= target / BigInt(2)) continue;
      const sub = await op.send({ to: t.address, value: target - bal, gas: BigInt(21_000) });
      const { receipt } = await waitForReceipt(client, sub.hash, { pollMs: 250, timeoutMs: 60_000 });
      if (receipt.status !== "success") throw new Error(`gas transfer to demo taker ${t.address} reverted (reserve balance?)`);
      log(`  demo taker ${t.address}: +${formatEther(target - bal)} MON`);
      // Monad reserve-balance rule: the operator's next value transfer must be its first in 3 blocks.
      while ((await client.getBlockNumber()) < receipt.blockNumber + BigInt(3)) await new Promise((r) => setTimeout(r, 300));
    }
  }

  // 2. Collateral per design (seedAccounts tops up an existing account without re-registering it).
  for (const d of designs) {
    const cols = await Promise.all(
      takers.map((t) =>
        client.readContract({ address: d.address, abi: abis.clearinghouse, functionName: "getAccount", args: [t.address] }),
      ),
    );
    const book = takers
      .map((t, i) => ({ account: t.address, collateral: config.collateral - cols[i][0], positions: [] }))
      .filter((b) => b.collateral > BigInt(0));
    if (book.length === 0) continue;
    await seedBook(ctx, book, () => undefined, d.address);
    log(`  demo takers: ${book.length} account(s) funded with collateral on ${d.label}`);
  }
}

/** The demo taker config from keeper config, with optional overrides (POST /demo-takers, bench). */
export function takerConfig(ctx: KeeperContext, o: Partial<DemoTakerConfig> = {}): DemoTakerConfig {
  return {
    seed: o.seed ?? ctx.config.demoTakerSeed,
    perLane: o.perLane ?? ctx.config.demoTakersPerLane,
    minBps: o.minBps ?? ctx.config.demoTakerMinBps,
    maxBps: o.maxBps ?? ctx.config.demoTakerMaxBps,
    collateral: o.collateral ?? ctx.config.demoTakerCollateral,
  };
}

/** Derive + fund the takers for `cfg` on `designs`. */
export async function createTakers(
  ctx: KeeperContext,
  cfg: DemoTakerConfig,
  designs: DesignRef[],
  log: (m: string) => void = console.log,
): Promise<DemoTakerSet> {
  const set = { config: cfg, takers: deriveTakers(ctx, cfg) };
  await setupTakers(ctx, set, designs, log);
  return set;
}

export function describeTakers(set: DemoTakerSet | null) {
  if (!set) return { demo: false, seed: null, perLane: 0, reservationBps: null, takers: [] };
  return {
    demo: true,
    seed: set.config.seed,
    perLane: set.config.perLane,
    reservationBps: [set.config.minBps, set.config.maxBps] as [number, number],
    collateral: set.config.collateral.toString(),
    takers: set.takers.map((t) => ({ address: t.address, lane: t.lane, reservationBps: t.reservationBps })),
  };
}

