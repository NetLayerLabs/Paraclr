// Everything a keeper-side component needs: clients, deployment, role keys, senders, config.

import { formatEther, parseEther, toFunctionSelector, type Address, type Chain, type Hex } from "viem";
import { mockAUSDAbi, mockOracleAbi, paraclrClearinghouseDemoAbi } from "../../src/lib/chain/abi";
import { envBigInt, envInt, envStr, REPO_ROOT, rpcHost } from "./env";
import { join, resolve } from "node:path";
import {
  chainFor,
  defaultRpcUrl,
  detectChain,
  loadDeployment,
  loadRoles,
  makeClient,
  roleAddresses,
  type ChainInfo,
  type Client,
  type Deployment,
  type Roles,
} from "./network";
import { SenderRegistry } from "./sender";

export interface KeeperConfig {
  port: number;
  corsOrigins: string[];
  /** Receipt poll interval. Every confirmedAt carries up to this much observation lag. */
  receiptPollMs: number;
  receiptTimeoutMs: number;
  /** estimateGas margin in bps (1000 = +10%). Monad bills the limit — keep it small. */
  gasMarginBps: number;
  /** Split a lane's liquidation batch into several txs above this gas limit. */
  maxTxGas: bigint;
  priceIntervalMs: number;
  /** Pause price pushes after this long without HTTP traffic (0 = never). Saves testnet MON. */
  priceIdleMs: number;
  priceLoopEnabled: boolean;
  faucetGasWei: bigint;
  faucetAusd: bigint;
  faucetCooldownMs: number;
  /** Per-block auction sweeper (start / backstop take / cancel cured / expire at MAX). */
  sweeperEnabled: boolean;
  /** How often the sweeper polls eth_blockNumber for a new head. */
  sweeperPollMs: number;
  /** Sweep the naive design (X-ray baseline): only during crash runs (default), always, or never. */
  sweepNaive: "crash" | "always" | "off";
  /** Minimum time between sweeps outside crash runs (RPC budget on public Monad endpoints). */
  sweeperMinIntervalMs: number;
  /** Fallbacks if the contract exposes no getter (plan defaults: 25 / 500 / 150 bps). */
  auctionStepBps: number;
  auctionMaxDiscountBps: number;
  backstopMinDiscountBps: number;
  /** Give up waiting for a crash run's auctions to resolve after this long. */
  crashResolveTimeoutMs: number;
  /** Keeper-run demo external takers (takers.ts). Default on for anvil, off on Monad. */
  demoTakers: boolean;
  demoTakerSeed: number;
  demoTakersPerLane: number;
  demoTakerMinBps: number;
  demoTakerMaxBps: number;
  /** AUSD (6dp) of collateral per demo taker per design. */
  demoTakerCollateral: bigint;
  /** Conflict X-ray after a crash: auto (debug trace, else fork replay) | debug | fork | off. */
  xray: "auto" | "debug" | "fork" | "off";
  /** Where X-ray JSONs are written (bench/xray by default). */
  xrayDir: string;
}

export type DesignName = "paraclr-lanes" | "naive-shared";

/** A clearinghouse the keeper operates: the lane-sharded product, or the naive shared-state baseline. */
export interface DesignRef {
  design: DesignName;
  address: Address;
  /** Short name for logs. */
  label: "paraclr" | "naive";
}

export interface Features {
  /** The deployed clearinghouse has the auction API (startAuctions …). */
  auctions: boolean;
  /** backstopNav / solvency views exist. */
  backstop: boolean;
  solvency: boolean;
}

export interface MarketRef {
  symbol: string;
  id: Hex;
}

export interface KeeperContext {
  rpcUrl: string;
  info: ChainInfo;
  chain: Chain;
  client: Client;
  dep: Deployment;
  roles: Roles;
  senders: SenderRegistry;
  markets: MarketRef[];
  config: KeeperConfig;
  /** [paraclr, naive?] — index 0 is always the lane-sharded design. */
  designs: DesignRef[];
  features: Features;
}

/** Same order as the app's MARKETS (src/lib/types.ts); anything else listed comes after. */
const MARKET_ORDER = ["MON/AUSD", "SOL/AUSD", "BTC/AUSD"];

/** Monad's documented per-transaction gas limit (docs.monad.xyz gas-pricing: "Transaction gas limit | 30M gas"). */
export const MONAD_TX_GAS_LIMIT = BigInt(30_000_000);

function loadConfig(info: ChainInfo): KeeperConfig {
  const monad = info.network === "monad-testnet";
  const cors = envStr("KEEPER_CORS_ORIGIN") ?? "*";
  return {
    port: envInt("KEEPER_PORT", 8787),
    corsOrigins: cors.split(",").map((s) => s.trim()).filter(Boolean),
    receiptPollMs: envInt("KEEPER_RECEIPT_POLL_MS", monad ? 100 : 25),
    receiptTimeoutMs: envInt("KEEPER_RECEIPT_TIMEOUT_MS", 60_000),
    gasMarginBps: envInt("KEEPER_GAS_MARGIN_BPS", 1_000),
    maxTxGas: envBigInt("KEEPER_MAX_TX_GAS", MONAD_TX_GAS_LIMIT),
    priceIntervalMs: Math.max(200, envInt("PRICE_PUSH_MS", 1_000)),
    priceIdleMs: envInt("PRICE_PUSH_IDLE_MS", monad ? 10 * 60_000 : 0),
    priceLoopEnabled: (envStr("PRICE_LOOP") ?? "on").toLowerCase() !== "off",
    faucetGasWei: envBigInt("FAUCET_GAS_WEI", monad ? parseEther("0.2") : parseEther("10")),
    faucetAusd: envBigInt("FAUCET_AUSD", BigInt(10_000_000_000)), // 10,000 AUSD = MockAUSD.MAX_MINT_PER_CALL
    faucetCooldownMs: envInt("FAUCET_COOLDOWN_MS", monad ? 60 * 60_000 : 5_000),
    sweeperEnabled: (envStr("SWEEPER") ?? "1") !== "0" && (envStr("SWEEPER") ?? "").toLowerCase() !== "off",
    sweeperPollMs: Math.max(20, envInt("SWEEPER_POLL_MS", monad ? 100 : 50)),
    sweepNaive: parseSweepNaive(envStr("SWEEP_NAIVE")),
    sweeperMinIntervalMs: envInt("SWEEPER_MIN_INTERVAL_MS", monad ? 1_000 : 0),
    auctionStepBps: envInt("AUCTION_STEP_BPS", 25),
    auctionMaxDiscountBps: envInt("AUCTION_MAX_DISCOUNT_BPS", 500),
    backstopMinDiscountBps: envInt("BACKSTOP_MIN_DISCOUNT_BPS", 75),
    crashResolveTimeoutMs: envInt("CRASH_RESOLVE_TIMEOUT_MS", 180_000),
    demoTakers: envStr("DEMO_TAKERS") !== undefined ? !["0", "off", "false"].includes((envStr("DEMO_TAKERS") as string).toLowerCase()) : !monad,
    demoTakerSeed: envInt("DEMO_TAKER_SEED", 1),
    demoTakersPerLane: Math.max(1, envInt("DEMO_TAKERS_PER_LANE", 3)),
    demoTakerMinBps: envInt("DEMO_TAKER_MIN_BPS", 25),
    demoTakerMaxBps: envInt("DEMO_TAKER_MAX_BPS", 70),
    demoTakerCollateral: envBigInt("DEMO_TAKER_COLLATERAL", BigInt(250_000_000_000)), // 250k AUSD
    xray: parseXrayMode(envStr("XRAY")),
    xrayDir: envStr("XRAY_DIR") ? resolve(REPO_ROOT, envStr("XRAY_DIR") as string) : join(REPO_ROOT, "bench", "xray"),
  };
}

function parseSweepNaive(v: string | undefined): KeeperConfig["sweepNaive"] {
  const m = (v ?? "crash").toLowerCase();
  if (m === "0" || m === "off") return "off";
  if (m === "1" || m === "always") return "always";
  if (m === "crash") return "crash";
  throw new Error(`SWEEP_NAIVE must be crash | always | off, got "${v}"`);
}

function parseXrayMode(v: string | undefined): KeeperConfig["xray"] {
  const m = (v ?? "auto").toLowerCase();
  if (m === "0" || m === "off") return "off";
  if (m === "debug" || m === "fork" || m === "auto") return m;
  throw new Error(`XRAY must be auto | debug | fork | off, got "${v}"`);
}

/** True when `selector`'s 4 bytes appear in the runtime code (solc's dispatcher PUSH4s every selector). */
function codeHas(code: Hex | undefined, signature: string): boolean {
  if (!code) return false;
  return code.toLowerCase().includes(toFunctionSelector(signature).slice(2).toLowerCase());
}

async function detectFeatures(client: Client, address: Address): Promise<Features> {
  const code = await client.getCode({ address });
  return {
    auctions: codeHas(code, "startAuctions(uint8,address[])"),
    backstop: codeHas(code, "backstopNav(uint8)"),
    solvency: codeHas(code, "solvency()"),
  };
}

export async function createContext(opts: { rpcUrl?: string } = {}): Promise<KeeperContext> {
  const rpcUrl = opts.rpcUrl ?? defaultRpcUrl();
  let info: ChainInfo;
  try {
    info = await detectChain(rpcUrl);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (/fetch failed|ECONNREFUSED|HTTP request failed/i.test(msg)) {
      throw new Error(`Cannot reach RPC ${rpcHost(rpcUrl)}. For local dev start the chain with \`npm run dev:chain\`.`);
    }
    throw err;
  }
  const chain = chainFor(info, rpcUrl);
  const client = makeClient(rpcUrl, chain);
  const dep = await loadDeployment(client, info);
  const roles = loadRoles(info.network);
  const markets = Object.entries(dep.markets)
    .map(([symbol, id]) => ({ symbol, id }))
    .sort((a, b) => rank(a.symbol) - rank(b.symbol));
  const designs: DesignRef[] = [{ design: "paraclr-lanes", address: dep.clearinghouse, label: "paraclr" }];
  if (dep.naive) designs.push({ design: "naive-shared", address: dep.naive, label: "naive" });
  const features = await detectFeatures(client, dep.clearinghouse);
  return {
    rpcUrl,
    info,
    chain,
    client,
    dep,
    roles,
    senders: new SenderRegistry(client, info.chainId),
    markets,
    config: loadConfig(info),
    designs,
    features,
  };
}

function rank(symbol: string): number {
  const i = MARKET_ORDER.indexOf(symbol);
  return i === -1 ? MARKET_ORDER.length : i;
}

export const abis = {
  /** Same ABI for both designs: NaiveClearinghouseDemo is the same code with shared storage keys. */
  clearinghouse: paraclrClearinghouseDemoAbi,
  oracle: mockOracleAbi,
  ausd: mockAUSDAbi,
};

/** Current oracle prices (1e18) for every market, read in one batched RPC round trip. */
export async function readOraclePrices(
  ctx: KeeperContext,
  blockNumber?: bigint,
): Promise<Record<string, { price: bigint; updatedAt: number }>> {
  const rows = await Promise.all(
    ctx.markets.map((m) =>
      ctx.client.readContract({
        address: ctx.dep.oracle,
        abi: mockOracleAbi,
        functionName: "getPrice",
        args: [m.id],
        blockNumber,
      }),
    ),
  );
  const out: Record<string, { price: bigint; updatedAt: number }> = {};
  ctx.markets.forEach((m, i) => {
    out[m.symbol] = { price: rows[i][0], updatedAt: Number(rows[i][1]) };
  });
  return out;
}

/**
 * Anvil only: make sure every role key has gas. Dev accounts beyond anvil's default 10 (e.g. the
 * 8th keeper, index 10) start at 0 ETH, so top them up via `anvil_setBalance`.
 */
export async function ensureAnvilBalances(ctx: KeeperContext, min = parseEther("1000")): Promise<Address[]> {
  if (ctx.info.network !== "anvil") return [];
  const a = roleAddresses(ctx.roles);
  const all = [a.operator, a.pricePusher, a.faucet, ...a.keepers];
  const toppedUp: Address[] = [];
  await Promise.all(
    all.map(async (address) => {
      const bal = await ctx.client.getBalance({ address });
      if (bal < min) {
        await ctx.client.request({
          method: "anvil_setBalance" as never,
          params: [address, `0x${(min * BigInt(10)).toString(16)}`] as never,
        });
        toppedUp.push(address);
      }
    }),
  );
  return toppedUp;
}

/** One-line balance summary per role (addresses only — never keys). */
export async function roleBalances(ctx: KeeperContext) {
  const a = roleAddresses(ctx.roles);
  const rows: Array<{ role: string; address: Address }> = [
    { role: "operator", address: a.operator },
    { role: "pricePusher", address: a.pricePusher },
    { role: "faucet", address: a.faucet },
    ...a.keepers.map((address, i) => ({ role: `keeper[${i}]`, address })),
  ];
  const bals = await Promise.all(rows.map((r) => ctx.client.getBalance({ address: r.address })));
  return rows.map((r, i) => ({ ...r, balance: bals[i], formatted: formatEther(bals[i]) }));
}
