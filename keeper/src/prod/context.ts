// Everything a production loop needs: chain, deployment, hot keys, senders, Hermes, alerts,
// config and the on-chain parameters (read at startup, refreshed by the monitor).

import { type Address, type Hex } from "viem";
import { envStr } from "../env";
import { SenderRegistry } from "../sender";
import { clearinghouseAbi, pythAbi } from "./abi";
import { Alerter } from "./alerts";
import { envFlag, envNum, KNOWN, LANES, type ProdChain, type ProdRoles } from "./config";
import { loadProdDeployment, resolveOracle, type ProdDeployment } from "./deployment";
import { HermesClient, hermesOptionsFromEnv, type PriceUpdate } from "./hermes";
import { ReserveGuard } from "./reserve";
import { loadPriceSigner, SignedPriceSource } from "./signed";

/**
 * Where signed price updates come from: Pyth's Hermes, or (testnet, after the Pyth trial) the
 * keeper's own signer for the KeeperSignedPyth fallback oracle. Every loop and the /hermes proxy
 * use `ctx.hermes`, which is whichever source matches the clearinghouse's live `pyth()`.
 */
export interface PriceSource {
  latest(ids: readonly Hex[]): Promise<PriceUpdate>;
  firstAtOrAfter(publishTime: number, ids: readonly Hex[]): Promise<PriceUpdate | null>;
  status(): { endpoints: string[]; apiKey: boolean; healthy: boolean } & Record<string, unknown>;
}

export interface ProdConfig {
  port: number;
  corsOrigins: string[];
  headPollMs: number;
  receiptPollMs: number;
  receiptTimeoutMs: number;
  gasMarginBps: number;
  maxTxGas: bigint;
  /** eth_getLogs window (Monad public RPC: 100 blocks). */
  logRange: number;
  /** Alert when an order lands more than this many seconds after it became executable. */
  execLateAlertS: number;
  /** Minimum time between auction sweeps (RPC budget). */
  sweeperMinIntervalMs: number;
  monitorIntervalMs: number;
  /** Hot-key low-balance alert thresholds (wei). */
  minKeeperWei: bigint;
  minOpsWei: bigint;
  minGuardianWei: bigint;
  /** Hermes price age (s) that warns / is critical. */
  priceAgeWarnS: number;
  priceAgeCriticalS: number;
  /** Cap utilisation (%) that warns. */
  capAlertPct: number;
  /** If set and GUARDIAN_PRIVATE_KEY is present: pause automatically when solvency() is false. */
  autoPauseOnInsolvency: boolean;
  /** Proxy Hermes for the app (/hermes/v2/...) so the API key stays server-side. */
  hermesProxy: boolean;
  hermesProxyCacheMs: number;
  /** Pyth AUSD/USD depeg alert (mainnet default on; testnet off: test AUSD has no value, and the trial key may not cover the feed). */
  ausdDepegCheck: boolean;
  /** Skip max-age funding updates while a market's rate and target are both 0 (testnet default on). */
  fundingSkipIdle: boolean;
  /** Sandbox only (an anvil fork): POST /faucet gives fork MON + testnet AUSD. Never on a real chain. */
  sandboxFaucet: boolean;
}

export interface MarketInfo {
  symbol: string;
  id: Hex;
  feed: Hex;
}

/** On-chain parameters (null = this deployment has no such getter). */
export interface ChainParams {
  minExecDelay: number | null;
  maxExecDelay: number | null;
  fundingInterval: number | null;
  maxConfBps: number | null;
  maxPriceAge: number | null;
  /** v2: Pyth-stored and lane prices expire after this (s). */
  maxStoredPriceAge: number | null;
  auctionStepBps: number | null;
  auctionMaxDiscountBps: number | null;
  readAt: number;
}

export interface ProdContext {
  chain: ProdChain;
  dep: ProdDeployment;
  roles: ProdRoles;
  senders: SenderRegistry;
  reserve: ReserveGuard;
  alerter: Alerter;
  /** The LIVE price source (Hermes, or the keeper signer when the clearinghouse runs on the fallback oracle). */
  hermes: PriceSource;
  sources: { hermes: HermesClient; signed: SignedPriceSource | null };
  config: ProdConfig;
  markets: MarketInfo[];
  params: ChainParams;
  startedAt: number;
}

const MON = BigInt(10) ** BigInt(18);
const monWei = (name: string, fallback: number) => (BigInt(Math.round(envNum(name, fallback) * 1e6)) * MON) / BigInt(1_000_000);

export function loadProdConfig(chain: ProdChain): ProdConfig {
  const cors = envStr("KEEPER_CORS_ORIGIN") ?? "";
  const corsOrigins = cors
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const p = chain.profile;
  if (!chain.fork) {
    if (corsOrigins.length === 0) throw new Error(`KEEPER_CORS_ORIGIN must list your app origin(s) on ${p.name} (never *)`);
    if (corsOrigins.includes("*")) throw new Error(`KEEPER_CORS_ORIGIN=* is not allowed on ${p.name}: list the app origin(s)`);
  }
  const sandboxFaucet = envFlag("SANDBOX_FAUCET", false);
  if (sandboxFaucet && !chain.fork) throw new Error("SANDBOX_FAUCET=1 is for the local sandbox (an anvil fork) only");
  return {
    port: Math.floor(envNum("KEEPER_PORT", envNum("PORT", 8787))),
    corsOrigins: corsOrigins.length ? corsOrigins : ["*"],
    headPollMs: Math.max(100, envNum("KEEPER_HEAD_POLL_MS", chain.fork ? 250 : 200)),
    receiptPollMs: envNum("KEEPER_RECEIPT_POLL_MS", 150),
    receiptTimeoutMs: envNum("KEEPER_RECEIPT_TIMEOUT_MS", 60_000),
    gasMarginBps: envNum("KEEPER_GAS_MARGIN_BPS", 1_000),
    maxTxGas: BigInt(Math.floor(envNum("KEEPER_MAX_TX_GAS", KNOWN.txGasLimit))),
    logRange: Math.max(1, Math.floor(envNum("KEEPER_LOG_RANGE", 100))),
    execLateAlertS: envNum("EXEC_LATE_ALERT_S", 10),
    sweeperMinIntervalMs: envNum("SWEEPER_MIN_INTERVAL_MS", 1_000),
    monitorIntervalMs: envNum("MONITOR_INTERVAL_MS", 10_000),
    minKeeperWei: monWei("ALERT_MIN_KEEPER_MON", 2),
    minOpsWei: monWei("ALERT_MIN_OPS_MON", 1),
    minGuardianWei: monWei("ALERT_MIN_GUARDIAN_MON", 0.2),
    priceAgeWarnS: envNum("ALERT_PRICE_AGE_WARN_S", 15),
    priceAgeCriticalS: envNum("ALERT_PRICE_AGE_CRITICAL_S", 60),
    capAlertPct: envNum("ALERT_CAP_PCT", 80),
    autoPauseOnInsolvency: envFlag("AUTO_PAUSE_ON_INSOLVENCY", false),
    hermesProxy: envFlag("HERMES_PROXY", true),
    hermesProxyCacheMs: envNum("HERMES_PROXY_CACHE_MS", 1_000),
    ausdDepegCheck: envFlag("AUSD_DEPEG_CHECK", p.ausdDepegCheck),
    fundingSkipIdle: envFlag("FUNDING_SKIP_IDLE", !p.realValue),
    sandboxFaucet,
  };
}

export async function readParams(chain: ProdChain, dep: ProdDeployment): Promise<ChainParams> {
  const num = (functionName: string) =>
    chain.client
      .readContract({ address: dep.clearinghouse, abi: clearinghouseAbi as never, functionName: functionName as never })
      .then((v) => Number(v as bigint), () => null);
  const [minExecDelay, maxExecDelay, fundingInterval, maxConfBps, maxPriceAge, maxStoredPriceAge, auctionStepBps, auctionMaxDiscountBps] = await Promise.all([
    num("minExecDelay"),
    num("maxExecDelay"),
    num("fundingUpdateInterval"),
    num("maxConfBps"),
    num("maxPriceAge"),
    num("maxStoredPriceAge"),
    num("auctionStepBps"),
    num("auctionMaxDiscountBps"),
  ]);
  return { minExecDelay, maxExecDelay, fundingInterval, maxConfBps, maxPriceAge, maxStoredPriceAge, auctionStepBps, auctionMaxDiscountBps, readAt: Date.now() };
}

export async function createProdContext(chain: ProdChain, roles: ProdRoles): Promise<ProdContext> {
  const dep = await loadProdDeployment(chain);
  const config = loadProdConfig(chain);
  const alerter = new Alerter(chain.fork ? `${chain.label}` : chain.profile.label);
  const hermes = new HermesClient(hermesOptionsFromEnv(alerter));
  const markets = Object.entries(dep.markets).map(([symbol, id]) => ({ symbol, id, feed: dep.feeds[symbol] }));
  const params = await readParams(chain, dep);
  // Testnet trial-end fallback: the signer runs whenever a fallback oracle is recorded and the key
  // is here, so a timelocked setPyth switches over without a restart (monitor → switchOracle).
  let signed: SignedPriceSource | null = null;
  const signer = loadPriceSigner();
  if (dep.fallbackOracle && signer) {
    const hot = [roles.deployer, roles.guardian, roles.ops, ...roles.keepers].filter(Boolean).map((a) => a!.address.toLowerCase());
    if (hot.includes(signer.address.toLowerCase())) throw new Error("PRICE_SIGNER_PRIVATE_KEY must be its own key (not a keeper / ops / guardian key)");
    signed = new SignedPriceSource({ signer, oracle: dep.fallbackOracle, chainId: chain.chainId, client: chain.client, feeds: markets.map((m) => ({ symbol: m.symbol, feed: m.feed })) });
    await signed.start();
  }
  if (dep.oracle === "keeper-signed" && !signed) {
    throw new Error(
      `the clearinghouse runs on the keeper-signed fallback oracle ${dep.pyth}: set PRICE_SIGNER_PRIVATE_KEY (an allowed signer of it) in the env`,
    );
  }
  return {
    chain,
    dep,
    roles,
    senders: new SenderRegistry(chain.client, chain.chainId),
    reserve: new ReserveGuard(chain.client, chain.fork),
    alerter,
    hermes: dep.oracle === "keeper-signed" ? signed! : hermes,
    sources: { hermes, signed },
    config,
    markets,
    params,
    startedAt: Date.now(),
  };
}

/**
 * Re-read the clearinghouse's live oracle and point `ctx.hermes` / `ctx.dep.pyth` at the matching
 * source. Called by the monitor on PythUpdated (a timelocked setPyth) and every monitor tick.
 * Returns the new mode when it changed, else null.
 */
export async function switchOracle(ctx: ProdContext): Promise<"pyth" | "keeper-signed" | null> {
  const before = ctx.dep.oracle;
  let mode: "pyth" | "keeper-signed";
  try {
    mode = await resolveOracle(ctx.chain, ctx.dep);
  } catch (err) {
    ctx.alerter.fire("gov:oracle:unknown", "critical", `${short(err)} — the keeper cannot price anything on this oracle (governance anomaly?)`);
    throw err;
  }
  ctx.alerter.resolve("gov:oracle:unknown");
  if (mode === "keeper-signed" && !ctx.sources.signed) {
    ctx.alerter.fire("gov:oracle:nosigner", "critical", `the clearinghouse switched to the keeper-signed oracle ${ctx.dep.pyth} but this keeper has no PRICE_SIGNER_PRIVATE_KEY: nothing can execute. Add the key and restart.`);
    return null;
  }
  ctx.alerter.resolve("gov:oracle:nosigner");
  ctx.hermes = mode === "keeper-signed" ? ctx.sources.signed! : ctx.sources.hermes;
  if (mode === before) return null;
  ctx.alerter.event("gov:oracle", "critical", `the clearinghouse oracle is now ${mode === "keeper-signed" ? `the KEEPER-SIGNED fallback ${ctx.dep.pyth} (testnet, after the Pyth trial)` : `Pyth ${ctx.dep.pyth}`}; the keeper switched its price source live`);
  return mode;
}

export function laneOf(account: Address): number {
  return Number(BigInt(account) % BigInt(LANES));
}

/** Pyth update fee for `data` (0 on Monad as of 2026-10-07, but always asked). */
export async function updateFee(ctx: ProdContext, data: Hex[]): Promise<bigint> {
  return ctx.chain.client.readContract({ address: ctx.dep.pyth, abi: pythAbi, functionName: "getUpdateFee", args: [data] });
}

export function short(err: unknown): string {
  return ((err as Error)?.message ?? String(err)).split("\n")[0].slice(0, 300);
}
