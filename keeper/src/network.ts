// Chain connection, network detection, deployment file and operator role keys.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  isHex,
  keccak256,
  type Address,
  type Chain,
  type Hex,
  type HttpTransport,
  type LocalAccount,
  type PublicClient,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { anvil as anvilChain, monadTestnet } from "viem/chains";
import { DEPLOYMENTS_DIR, envStr, REPO_ROOT } from "./env";

export type Network = "anvil" | "monad-testnet";
/** Matches NEXT_PUBLIC_CHAIN_MODE in the app. */
export type Mode = "anvil" | "monad";

export const ANVIL_RPC_URL = "http://127.0.0.1:8545";
export const MONAD_RPC_URL = monadTestnet.rpcUrls.default.http[0];
export const MONAD_CHAIN_ID = 10143;
export const ANVIL_CHAIN_ID = 31337;
/** Anvil's well-known dev mnemonic. Public; only ever valid on a local anvil. */
export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
export const LANE_COUNT = 8;

export type Client = PublicClient<HttpTransport, Chain>;

export interface Deployment {
  chainId: number;
  /** ParaclrClearinghouseDemo — the lane-sharded design (the product). */
  clearinghouse: Address;
  ausd: Address;
  oracle: Address;
  /** NaiveClearinghouseDemo — same code with every per-lane aggregate on one shared key (X-ray baseline). */
  naive: Address | null;
  deployBlock: number;
  markets: Record<string, Hex>;
}

export interface Roles {
  /** Owner of oracle / clearinghouse / AUSD. Sends shock, recover, seeding. */
  operator: LocalAccount;
  /** Oracle updater that pushes the GBM price feed. */
  pricePusher: LocalAccount;
  /** Sends native gas + AUSD faucet mints to new users. */
  faucet: LocalAccount;
  /** One per lane: keepers[lane] sends liquidateBatch(lane, …). */
  keepers: LocalAccount[];
  /** Where the keys came from (never the keys themselves). */
  source: "anvil-dev-mnemonic" | "env";
  /** keccak256(operator private key): a secret salt for keys the keeper derives (demo takers). Never logged. */
  secret: Hex;
}

export interface ChainInfo {
  chainId: number;
  network: Network;
  mode: Mode;
  clientVersion: string;
}

export function makeClient(rpcUrl: string, chain?: Chain): Client {
  return createPublicClient({
    chain: chain ?? anvilChain,
    cacheTime: 0, // getBlockNumber must be live (viem caches it for 4s by default)
    pollingInterval: 250,
    // batch: concurrent calls made in the same tick (8 receipt polls, the 8 lane batches'
    // eth_sendRawTransaction) go out as ONE JSON-RPC batch request. KEEPER_RPC_BATCH=0 disables
    // it for RPCs that reject batches.
    transport: http(rpcUrl, {
      batch: envStr("KEEPER_RPC_BATCH") === "0" ? false : { wait: 0 },
      retryCount: 2,
      timeout: 20_000,
    }),
  }) as Client;
}

/**
 * Identify the chain behind `rpcUrl`. Anvil is detected by its client version, NOT by chain
 * id, so an anvil fork of Monad testnet (chain id 10143) is still labelled "anvil" — anvil
 * numbers must never be reported as Monad numbers.
 */
export async function detectChain(rpcUrl: string): Promise<ChainInfo> {
  const probe = makeClient(rpcUrl);
  const [chainId, clientVersion] = await Promise.all([
    probe.getChainId(),
    probe.request({ method: "web3_clientVersion" }).catch(() => "unknown") as Promise<string>,
  ]);
  if (/anvil/i.test(clientVersion)) return { chainId, network: "anvil", mode: "anvil", clientVersion };
  if (chainId === MONAD_CHAIN_ID) return { chainId, network: "monad-testnet", mode: "monad", clientVersion };
  throw new Error(
    `Unsupported chain at ${rpcUrl}: chainId ${chainId}, client "${clientVersion}". ` +
      `Expected a local anvil or Monad testnet (${MONAD_CHAIN_ID}).`,
  );
}

export function chainFor(info: ChainInfo, rpcUrl: string): Chain {
  if (info.network === "monad-testnet") {
    return { ...monadTestnet, rpcUrls: { default: { http: [rpcUrl] } } };
  }
  return {
    ...anvilChain,
    id: info.chainId,
    name: info.chainId === ANVIL_CHAIN_ID ? "Anvil (local)" : `Anvil fork (chain ${info.chainId})`,
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

export function defaultRpcUrl(): string {
  return envStr("KEEPER_RPC_URL") ?? ANVIL_RPC_URL;
}

/** The canonical local stack: anvil :8545 + keeper :8787 + deployments/31337.json. */
export const CANONICAL_ANVIL_PORT = 8545;
export const CANONICAL_KEEPER_PORT = 8787;

/** Port of a local (127.0.0.1 / localhost) RPC URL, else null. */
export function localRpcPort(rpcUrl: string): number | null {
  try {
    const u = new URL(rpcUrl);
    if (!["127.0.0.1", "localhost", "0.0.0.0", "[::1]"].includes(u.hostname)) return null;
    return Number(u.port || (u.protocol === "https:" ? 443 : 80));
  } catch {
    return null;
  }
}

/** Where a private local stack on `port` keeps its deployment file (never deployments/). */
export function privateDeploymentsFile(port: number): string {
  return join(REPO_ROOT, "contracts", "cache", "dev-chain", String(port), "deployments.json");
}

/**
 * Private local stacks (anvil on any port but 8545) get their own deployment file, keeper port and
 * X-ray dir unless set explicitly: DEPLOYMENTS_OUT = contracts/cache/dev-chain/<port>/deployments.json,
 * KEEPER_PORT = 8787 + (port − 8545) — 8645 → 8887, 8745 → 8987 — and
 * XRAY_DIR = contracts/cache/dev-chain/<port>/xray. Same rule as `dev:chain --port`,
 * so a keeper or bench pointed at a private anvil can never read the canonical deployments/31337.json
 * or talk to the canonical keeper.
 */
export function applyPrivateStackDefaults(rpcUrl: string): void {
  const port = localRpcPort(rpcUrl);
  if (port === null || port === CANONICAL_ANVIL_PORT) return;
  if (!envStr("DEPLOYMENTS_OUT")) process.env.DEPLOYMENTS_OUT = privateDeploymentsFile(port);
  if (!envStr("KEEPER_PORT")) process.env.KEEPER_PORT = String(CANONICAL_KEEPER_PORT + port - CANONICAL_ANVIL_PORT);
  // X-rays of ad-hoc crashes on a private stack stay out of bench/xray (the bench copies its own).
  if (!envStr("XRAY_DIR")) process.env.XRAY_DIR = join(REPO_ROOT, "contracts", "cache", "dev-chain", String(port), "xray");
}

// ---------------------------------------------------------------------------
// Deployment file
// ---------------------------------------------------------------------------

/**
 * `deployments/<chainId>.json`, or `DEPLOYMENTS_OUT` when set. Private stacks (a second anvil on
 * another port) set DEPLOYMENTS_OUT so they never overwrite the canonical deployments/31337.json
 * that the app reads; the deploy wrapper writes there and the keeper/bench read from there.
 */
export function deploymentPath(chainId: number): string {
  const override = envStr("DEPLOYMENTS_OUT");
  if (override) return resolve(REPO_ROOT, override);
  return join(DEPLOYMENTS_DIR, `${chainId}.json`);
}

/** Short form for messages: repo-relative when inside the repo. */
export function deploymentLabel(chainId: number): string {
  const p = deploymentPath(chainId);
  return p.startsWith(REPO_ROOT + "/") ? p.slice(REPO_ROOT.length + 1) : p;
}

export function readDeployment(chainId: number): Deployment | null {
  const file = deploymentPath(chainId);
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  if (raw.production === true) {
    // deployments/10143.json is the PRODUCTION testnet set since docs/TESTNET_PLAN.md: not the demo stack.
    throw new Error(
      `${file} is a PRODUCTION deployment ("production": true). Run the production keeper: \`npm run keeper -- --network ${raw.chainId === 143 || raw.chainId === "143" ? "mainnet" : "testnet"}\`. ` +
        "The demo stack (MockAUSD / MockOracle) needs its own deployment file (DEPLOYMENTS_OUT).",
    );
  }
  const addr = (k: string): Address => {
    const v = raw[k];
    if (typeof v !== "string" || !isAddress(v)) throw new Error(`${file}: "${k}" is not an address`);
    return getAddress(v);
  };
  const markets: Record<string, Hex> = {};
  for (const [sym, id] of Object.entries((raw.markets ?? {}) as Record<string, unknown>)) {
    if (typeof id !== "string" || !isHex(id) || id.length !== 66) throw new Error(`${file}: bad market id for ${sym}`);
    markets[sym] = id;
  }
  if (Object.keys(markets).length === 0) throw new Error(`${file}: no markets`);
  return {
    chainId: Number(raw.chainId),
    clearinghouse: addr("clearinghouse"),
    ausd: addr("ausd"),
    oracle: addr("oracle"),
    naive: raw.naive === undefined || raw.naive === null ? null : addr("naive"),
    deployBlock: Number(raw.deployBlock ?? 0),
    markets,
  };
}

/** Deployment for the connected chain, verified to have code at every address. */
export async function loadDeployment(client: Client, info: ChainInfo): Promise<Deployment> {
  const dep = readDeployment(info.chainId);
  const hint =
    info.network === "anvil" ? "Run `npm run dev:chain` (starts anvil + deploys)." : "Run `npm run deploy:monad`.";
  if (!dep) throw new Error(`No deployment file ${deploymentLabel(info.chainId)}. ${hint}`);
  if (dep.chainId !== info.chainId) throw new Error(`${deploymentLabel(info.chainId)} has chainId ${dep.chainId}`);
  const addrs = [dep.clearinghouse, dep.ausd, dep.oracle, ...(dep.naive ? [dep.naive] : [])];
  const codes = await Promise.all(addrs.map((address) => client.getCode({ address })));
  if (codes.some((c) => !c || c === "0x")) {
    throw new Error(
      `${deploymentLabel(info.chainId)} points at addresses with no code (chain restarted?). ${hint}`,
    );
  }
  return dep;
}

// ---------------------------------------------------------------------------
// Role keys
// ---------------------------------------------------------------------------

function parseKey(name: string, value: string): LocalAccount {
  const v = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${name} is not a 32-byte hex private key`);
  return privateKeyToAccount(v as Hex);
}

/** Anvil dev account `i` of the well-known mnemonic (anvil funds 0..N-1; we top up the rest). */
export function anvilAccount(i: number): LocalAccount {
  return mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i });
}

/** Anvil dev private key `i` (only for handing to forge on a local anvil). */
export function anvilPrivateKey(i: number): Hex {
  const hd = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i }).getHdKey();
  if (!hd.privateKey) throw new Error("hd derivation failed");
  return `0x${Buffer.from(hd.privateKey).toString("hex")}` as Hex;
}

/** Default anvil role layout: operator 0, pusher 1, faucet 2, keepers 3..10. */
export const ANVIL_ROLE_INDEX = { operator: 0, pricePusher: 1, faucet: 2, firstKeeper: 3 } as const;

/**
 * Role keys from env (keeper/.env). On anvil, any unset role falls back to the dev mnemonic so
 * `npm run dev:chain` needs zero config. On Monad every role must be set explicitly.
 */
export function loadRoles(network: Network): Roles {
  const op = envStr("OPERATOR_PRIVATE_KEY");
  const pusher = envStr("PRICE_PUSHER_PRIVATE_KEY");
  const faucet = envStr("FAUCET_PRIVATE_KEY");
  const keepersRaw = envStr("KEEPER_PRIVATE_KEYS");
  const anyEnv = Boolean(op || pusher || faucet || keepersRaw);

  if (network === "monad-testnet") {
    const missing = [
      ["OPERATOR_PRIVATE_KEY", op],
      ["PRICE_PUSHER_PRIVATE_KEY", pusher],
      ["FAUCET_PRIVATE_KEY", faucet],
      ["KEEPER_PRIVATE_KEYS", keepersRaw],
    ]
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length) {
      throw new Error(
        `Monad testnet needs ${missing.join(", ")} in keeper/.env. ` +
          "Generate a fresh set locally with `npm run keeper:init` (never paste keys into chat or commit them).",
      );
    }
  }

  const keepers = keepersRaw
    ? keepersRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((k, i) => parseKey(`KEEPER_PRIVATE_KEYS[${i}]`, k))
    : Array.from({ length: LANE_COUNT }, (_, i) => anvilAccount(ANVIL_ROLE_INDEX.firstKeeper + i));
  if (keepers.length === 0) throw new Error("KEEPER_PRIVATE_KEYS is empty");

  const opKey = op ? (op.startsWith("0x") ? op : `0x${op}`) : anvilPrivateKey(ANVIL_ROLE_INDEX.operator);
  return {
    secret: keccak256(opKey as Hex),
    operator: op ? parseKey("OPERATOR_PRIVATE_KEY", op) : anvilAccount(ANVIL_ROLE_INDEX.operator),
    pricePusher: pusher ? parseKey("PRICE_PUSHER_PRIVATE_KEY", pusher) : anvilAccount(ANVIL_ROLE_INDEX.pricePusher),
    faucet: faucet ? parseKey("FAUCET_PRIVATE_KEY", faucet) : anvilAccount(ANVIL_ROLE_INDEX.faucet),
    keepers,
    source: anyEnv ? "env" : "anvil-dev-mnemonic",
  };
}

/** Keeper EOA responsible for `lane` (8 keys → one per lane; fewer keys are reused round-robin). */
export function keeperForLane(roles: Roles, lane: number): LocalAccount {
  return roles.keepers[lane % roles.keepers.length];
}

export function roleAddresses(roles: Roles) {
  return {
    operator: roles.operator.address,
    pricePusher: roles.pricePusher.address,
    faucet: roles.faucet.address,
    keepers: roles.keepers.map((k) => k.address),
  };
}
