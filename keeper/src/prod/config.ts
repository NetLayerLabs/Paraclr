// Production configuration: network profile, env file, network gate, confirmation gate, hot-key
// roles. Used by every `--network mainnet|testnet` command (keeper, keeper:init, keeper:fund,
// deploy:mainnet / deploy:testnet, guardian:pause, timelock, pyth:push, rehearsals, sandbox).
//
// Two profiles run the SAME production contract (ParaclrClearinghouseProd v5) and the same keeper:
//   mainnet  chain 143,   keeper/.env.mainnet, real Agora AUSD, MON/SOL/BTC, 24 h timelock, --yes-mainnet
//   testnet  chain 10143, keeper/.env.testnet, Agora TESTNET AUSD, SOL/BTC (PROD_MARKETS), 600 s
//            timelock, --yes-testnet (docs/TESTNET_PLAN.md). Test funds, no real value.
// The profile is chosen once per process from `--network` (selectProdNetwork / loadMainnetEnv);
// the default is mainnet, so every mainnet code path behaves exactly as before.
//
// Rules (docs/PRODUCTION_PLAN.md "Keeper / ops"):
//   - `--network <n>` loads keeper/.env.<n> (or --env / KEEPER_ENV_FILE) and NOTHING else:
//     keeper/.env (demo-stack keys) and keeper/.env.anvil are never read in this mode.
//   - The RPC must report the profile's chain id. An anvil fork also reports it; it is detected by
//     its client version and labelled "anvil fork (NOT <network>)" everywhere.
//   - Anything that sends a transaction to the real chain prints balances + a cost estimate and
//     then refuses unless `--yes-mainnet` / `--yes-testnet` is passed. On an anvil fork no
//     confirmation is needed.
//   - Keys are never printed or logged, only addresses.

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createPublicClient,
  formatEther,
  http,
  type Address,
  type Chain,
  type Hex,
  type HttpTransport,
  type LocalAccount,
  type PublicClient,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad, monadTestnet } from "viem/chains";
import { envStr, loadKeeperEnv, REPO_ROOT, rpcHost } from "../env";

export const MAINNET_CHAIN_ID = 143;
export const MAINNET_RPC_URL = monad.rpcUrls.default.http[0];
export const MAINNET_ENV_FILE = join(REPO_ROOT, "keeper", ".env.mainnet");
export const MAINNET_EXPLORER = monad.blockExplorers.default.url;
export const TESTNET_CHAIN_ID = 10143;
export const TESTNET_RPC_URL = monadTestnet.rpcUrls.default.http[0];
export const TESTNET_ENV_FILE = join(REPO_ROOT, "keeper", ".env.testnet");
export const TESTNET_EXPLORER = monadTestnet.blockExplorers.default.url;
export const LANES = 8;

/** Fixed external facts (docs/PRODUCTION_PLAN.md), re-verified on chain by deploy:mainnet and the keeper. */
export const KNOWN = {
  ausd: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a" as Address,
  ausdDecimals: 6,
  pyth: "0x2880aB155794e7179c9eE2e38200202908C17B43" as Address,
  /** Pyth price feed ids (Hermes /v2/price_feeds, verified 2026-10-07: Crypto.MON/USD, Crypto.SOL/USD, Crypto.BTC/USD). */
  feeds: {
    "MON/AUSD": "0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1",
    "SOL/AUSD": "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    "BTC/AUSD": "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  } as Record<string, Hex>,
  /** Monad: max contract code size 128 KB, init code 256 KB (docs.monad.xyz, "Differences from Ethereum"). */
  codeSizeLimit: 131_072,
  /** Monad documented per-tx gas limit (docs.monad.xyz gas-pricing). */
  txGasLimit: 30_000_000,
  /** Minimum base fee 100 MON-gwei; eth_maxPriorityFeePerGas answered 2 gwei on 2026-10-07. */
  minGasPriceWei: BigInt(102) * BigInt(1e9),
} as const;

/**
 * Monad TESTNET facts, verified read-only on chain 2026-10-07 (docs/RUNBOOK.md "Testnet"):
 * Agora AUSD (proxy, 6 decimals, symbol AUSD, not paused), Agora's faucet (requestFunds(address):
 * 10,000 AUSD per call), Pyth 1.4.6 at the same address as mainnet (same Wormhole guardian set and
 * Pythnet data source, so mainnet-signed updates verify; fee 1 wei per update message).
 */
export const KNOWN_TESTNET = {
  ausd: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC" as Address,
  ausdFaucet: "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C" as Address,
  pyth: "0x2880aB155794e7179c9eE2e38200202908C17B43" as Address,
} as const;

// ---------------------------------------------------------------------------
// Network profiles
// ---------------------------------------------------------------------------

export type ProdNetworkName = "mainnet" | "testnet";

export interface NetworkProfile {
  name: ProdNetworkName;
  chainId: number;
  /** Goes into reports, /health and deployments/<id>.json ("network"). */
  slug: "monad-mainnet" | "monad-testnet";
  label: string;
  rpcUrl: string;
  envFile: string;
  envExample: string;
  explorer: string;
  viemChain: Chain;
  /** The confirmation flag for real-chain transactions. */
  yesFlag: "yes-mainnet" | "yes-testnet";
  /** Real money at stake (mainnet) or test funds (testnet). */
  realValue: boolean;
  ausd: Address;
  pyth: Address;
  /** Default market list: symbol → Pyth feed id (PROD_MARKETS overrides). */
  markets: Record<string, Hex>;
  /** Preflight floor for TIMELOCK_MIN_DELAY_SECONDS, and the default. */
  minTimelockDelayS: number;
  defaultTimelockDelayS: number;
  /** Pyth AUSD/USD depeg alert on by default (mainnet only: testnet AUSD has no value). */
  ausdDepegCheck: boolean;
  /** The deploy command for messages. */
  deployCmd: string;
}

export const PROFILES: Record<ProdNetworkName, NetworkProfile> = {
  mainnet: {
    name: "mainnet",
    chainId: MAINNET_CHAIN_ID,
    slug: "monad-mainnet",
    label: "Monad mainnet",
    rpcUrl: MAINNET_RPC_URL,
    envFile: MAINNET_ENV_FILE,
    envExample: join(REPO_ROOT, "keeper", ".env.mainnet.example"),
    explorer: MAINNET_EXPLORER,
    viemChain: monad,
    yesFlag: "yes-mainnet",
    realValue: true,
    ausd: KNOWN.ausd,
    pyth: KNOWN.pyth,
    markets: { ...KNOWN.feeds },
    minTimelockDelayS: 3_600,
    defaultTimelockDelayS: 86_400,
    ausdDepegCheck: true,
    deployCmd: "npm run deploy:mainnet",
  },
  testnet: {
    name: "testnet",
    chainId: TESTNET_CHAIN_ID,
    slug: "monad-testnet",
    label: "Monad testnet",
    rpcUrl: TESTNET_RPC_URL,
    envFile: TESTNET_ENV_FILE,
    envExample: join(REPO_ROOT, "keeper", ".env.testnet.example"),
    explorer: TESTNET_EXPLORER,
    viemChain: monadTestnet,
    yesFlag: "yes-testnet",
    realValue: false,
    ausd: KNOWN_TESTNET.ausd,
    pyth: KNOWN_TESTNET.pyth,
    // MON is NOT listed on testnet: the Pyth trial key is not entitled to MON/USD (TESTNET_PLAN.md).
    markets: { "SOL/AUSD": KNOWN.feeds["SOL/AUSD"], "BTC/AUSD": KNOWN.feeds["BTC/AUSD"] },
    minTimelockDelayS: 600,
    defaultTimelockDelayS: 600,
    ausdDepegCheck: false,
    deployCmd: "npm run deploy:testnet",
  },
};

let active: NetworkProfile = PROFILES.mainnet;

/** The profile of this process (mainnet unless `--network testnet` selected testnet). */
export function net(): NetworkProfile {
  return active;
}

/** Pick the profile from `--network` ("mainnet" default, "testnet"); returns it. */
export function selectProdNetwork(name: string | true | undefined): NetworkProfile {
  if (name === undefined || name === "mainnet") active = PROFILES.mainnet;
  else if (name === "testnet") active = PROFILES.testnet;
  else throw new Error(`--network must be mainnet or testnet for the production tools, got "${String(name)}"`);
  return active;
}

/** `--network mainnet` or `--network testnet` (the production flows). */
export function isProdNetwork(v: string | true | undefined): v is ProdNetworkName {
  return v === "mainnet" || v === "testnet";
}

/**
 * The markets a deployment lists: PROD_MARKETS ("SOL/AUSD,BTC/AUSD" or "SYM=0xfeed,…"), else the
 * profile's default. Known symbols take the verified feed id (PYTH_FEED_<BASE>_USD overrides it),
 * exactly like contracts/script/DeployProd.s.sol.
 */
export function prodMarkets(): Record<string, Hex> {
  const raw = envStr("PROD_MARKETS");
  const out: Record<string, Hex> = {};
  const entries = raw ? raw.split(",").map((x) => x.trim()).filter(Boolean) : Object.keys(active.markets);
  for (const e of entries) {
    const [sym, feedRaw] = e.split("=").map((x) => x.trim());
    const base = sym.split("/")[0];
    const feed = feedRaw ?? envStr(`PYTH_FEED_${base}_USD`) ?? KNOWN.feeds[sym];
    if (!feed || !/^0x[0-9a-fA-F]{64}$/.test(feed)) throw new Error(`PROD_MARKETS: no Pyth feed id for ${sym} (write ${sym}=0x<feed id>)`);
    out[sym] = feed.toLowerCase() as Hex;
  }
  if (Object.keys(out).length === 0) throw new Error("PROD_MARKETS lists no market");
  return out;
}

export type Client = PublicClient<HttpTransport, Chain>;

export type Args = Record<string, string | true>;

export function isMainnet(args: Args): boolean {
  return args.network === "mainnet";
}

/**
 * Select the profile from `--network`, then load keeper/.env.<network> (or `--env PATH`, else
 * KEEPER_ENV_FILE). Values already in the shell win (Node's loadEnvFile semantics), which is how
 * hosted deployments pass secrets. `required: false` lets keeper:init run before the file exists.
 * (Named for its first user; it serves both production networks.)
 */
export function loadMainnetEnv(args: Args, opts: { required?: boolean } = {}): string | null {
  if (args.network !== undefined) selectProdNetwork(args.network);
  const file = resolveEnvFile(args);
  process.env.KEEPER_ENV_FILE = file;
  if (!existsSync(file)) {
    if (opts.required === false || process.env.KEEPER_SECRETS_FROM_ENV === "1") return null;
    throw new Error(
      `${rel(file)} not found. Create it with \`npm run keeper:init -- --network ${active.name}\` ` +
        `(or copy ${rel(active.envExample)}). Hosted keepers set KEEPER_SECRETS_FROM_ENV=1 and pass every variable as a secret.`,
    );
  }
  warnIfReadable(file);
  return loadKeeperEnv(file);
}

/** Alias with the network-neutral name. */
export const loadProdEnv = loadMainnetEnv;

export function resolveEnvFile(args: Args): string {
  if (typeof args.env === "string") return resolve(process.cwd(), args.env);
  const fromEnv = process.env.KEEPER_ENV_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(REPO_ROOT, fromEnv.trim());
  return active.envFile;
}

function warnIfReadable(file: string): void {
  try {
    const mode = statSync(file).mode & 0o777;
    if (mode & 0o077) {
      console.warn(`[mainnet] WARNING ${rel(file)} is mode ${mode.toString(8)}; run \`chmod 600 ${rel(file)}\` (it holds hot keys).`);
    }
  } catch {
    /* best effort */
  }
}

export function rel(p: string): string {
  return p.startsWith(REPO_ROOT + "/") ? p.slice(REPO_ROOT.length + 1) : p;
}

export function mainnetRpcUrl(args: Args): string {
  if (typeof args.rpc === "string") return args.rpc;
  return envStr("KEEPER_RPC_URL") ?? active.rpcUrl;
}

/** Alias with the network-neutral name. */
export const prodRpcUrl = mainnetRpcUrl;

// ---------------------------------------------------------------------------
// Chain
// ---------------------------------------------------------------------------

export interface ProdChain {
  rpcUrl: string;
  chainId: number;
  /** True on ANY local anvil (a fork of Monad mainnet/testnet, or a plain anvil in a rehearsal's
   *  MockPyth leg): no real value, no confirmation needed, never the canonical deployment file. */
  fork: boolean;
  clientVersion: string;
  /** "Monad mainnet" / "Monad testnet", or "anvil fork of Monad … (NOT …)" / "plain anvil …". */
  label: string;
  /** "monad-mainnet" | "monad-testnet" | "anvil-fork" | "anvil" — goes into every report. */
  network: "monad-mainnet" | "monad-testnet" | "anvil-fork" | "anvil";
  /** The production profile this process runs (also on a fork of that network). */
  profile: NetworkProfile;
  chain: Chain;
  client: Client;
}

/**
 * True for a provider's per-second request cap. Monad's public testnet RPC (QuickNode) answers
 * -32007 "50/second request limit reached" or "requests limited to 15/sec", per call, also inside
 * a batch; viem's built-in retry doesn't cover that code. The call was refused, not processed,
 * so retrying it (even eth_sendRawTransaction) is safe.
 */
export function isRateLimited(err: unknown): boolean {
  for (let e = err as { code?: unknown; status?: unknown; message?: unknown; details?: unknown; cause?: unknown } | undefined, depth = 0; e && depth < 8; e = e.cause as typeof e, depth++) {
    if (e.code === -32007 || e.status === 429) return true;
    if (/request limit|requests? limited to|rate.?limit|too many requests/i.test(`${String(e.message ?? "")} ${String(e.details ?? "")}`)) return true;
  }
  return false;
}

/** Retries rate-limited calls with jittered exponential backoff (≈ 0.25 s … 4 s, 6 tries). */
function withRateLimitRetry(base: Transport): Transport {
  return (opts) => {
    const t = base(opts);
    const request = (async (args: Parameters<typeof t.request>[0], options?: Parameters<typeof t.request>[1]) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await t.request(args, options);
        } catch (err) {
          if (attempt >= 6 || !isRateLimited(err)) throw err;
          await new Promise((r) => setTimeout(r, Math.min(4_000, 250 * 2 ** attempt) * (0.75 + Math.random() / 2)));
        }
      }
    }) as typeof t.request;
    return { ...t, request };
  };
}

export function makeProdClient(rpcUrl: string, chain: Chain): Client {
  // Every call in a batch counts toward a provider's per-second cap: keep batches small on a
  // public RPC (KEEPER_RPC_BATCH_SIZE, e.g. 10 on testnet-rpc.monad.xyz).
  const batchSize = Math.max(1, Number(envStr("KEEPER_RPC_BATCH_SIZE") || 50) || 50);
  return createPublicClient({
    chain,
    cacheTime: 0,
    pollingInterval: 400,
    transport: withRateLimitRetry(
      http(rpcUrl, {
        batch: envStr("KEEPER_RPC_BATCH") === "0" ? false : { wait: 0, batchSize },
        retryCount: 3,
        retryDelay: 250,
        timeout: 20_000,
      }),
    ),
  }) as Client;
}

/**
 * Connect and enforce the profile's chain id (143 / 10143). `allowLocal` additionally accepts a
 * plain (non-fork) anvil with any chain id — only the rehearsals' MockPyth legs use it.
 */
export async function connectMainnet(rpcUrl: string, opts: { allowLocal?: boolean } = {}): Promise<ProdChain> {
  const p = active;
  const probe = createPublicClient({ transport: http(rpcUrl, { retryCount: 2, timeout: 15_000 }) });
  let chainId: number;
  let clientVersion = "unknown";
  try {
    [chainId, clientVersion] = await Promise.all([
      probe.getChainId(),
      probe.request({ method: "web3_clientVersion" }).then(String, () => "unknown"),
    ]);
  } catch (err) {
    throw new Error(`cannot reach RPC ${rpcHost(rpcUrl)}: ${(err as Error)?.message?.split("\n")[0] ?? err}`);
  }
  const anvil = /anvil/i.test(clientVersion);
  if (chainId !== p.chainId && !(opts.allowLocal && anvil)) {
    throw new Error(
      `--network ${p.name} expects chain id ${p.chainId}; ${rpcHost(rpcUrl)} reports ${chainId} (${clientVersion}). ` +
        `Check KEEPER_RPC_URL / CHAIN_ID in ${rel(p.envFile)}.`,
    );
  }
  const declared = envStr("CHAIN_ID");
  if (declared && Number(declared) !== chainId && !anvil) {
    throw new Error(`CHAIN_ID=${declared} in the env file but the RPC reports ${chainId}`);
  }
  let forked = false;
  if (anvil) {
    const info = (await probe.request({ method: "anvil_nodeInfo" as never }).catch(() => null)) as { forkConfig?: { forkUrl?: string | null } } | null;
    forked = Boolean(info?.forkConfig?.forkUrl);
  }
  const network = !anvil ? p.slug : forked ? "anvil-fork" : "anvil";
  const label =
    network === p.slug
      ? p.label
      : network === "anvil-fork"
        ? `anvil fork of ${p.label} (NOT ${p.name})`
        : `plain anvil, chain ${chainId} (NOT ${p.name}, no fork)`;
  const chain: Chain = {
    ...p.viemChain,
    id: chainId,
    name: network === p.slug ? p.viemChain.name : label,
    rpcUrls: { default: { http: [rpcUrl] } },
  };
  return { rpcUrl, chainId, fork: anvil, clientVersion, label, network, profile: p, chain, client: makeProdClient(rpcUrl, chain) };
}

/** Alias with the network-neutral name. */
export const connectProd = connectMainnet;

/**
 * The confirmation gate. On the real chain: refuse unless `--yes-mainnet` (mainnet) or
 * `--yes-testnet` (testnet) was passed (the caller has already printed balances and the cost
 * estimate). On an anvil fork it is a no-op. The flags are NOT interchangeable.
 */
export function confirmMainnet(chain: ProdChain, args: Args, what: string): void {
  const p = chain.profile;
  const tag = `[${p.name}]`;
  if (chain.fork) {
    console.log(`${tag} ${chain.label}: "${what}" needs no confirmation (no real chain).`);
    return;
  }
  if (args[p.yesFlag] === true) {
    console.log(
      p.realValue
        ? `${tag} --${p.yesFlag} given: ${what} on Monad MAINNET (real MON).`
        : `${tag} --${p.yesFlag} given: ${what} on Monad TESTNET (testnet MON, no real value).`,
    );
    return;
  }
  console.error(
    `\n${tag} REFUSING: ${what} sends real transactions on ${p.label}${p.realValue ? "" : " (testnet MON)"}.\n` +
      `          Review the balances and the cost estimate above, then re-run with --${p.yesFlag}.\n`,
  );
  process.exit(2);
}

/** Alias with the network-neutral name. */
export const confirmProd = confirmMainnet;

// ---------------------------------------------------------------------------
// Roles (hot keys)
// ---------------------------------------------------------------------------

export type RoleName = "deployer" | "guardian" | "ops" | "keepers";

export interface ProdRoles {
  deployer: LocalAccount | null;
  guardian: LocalAccount | null;
  ops: LocalAccount | null;
  /** keepers[lane] executes lane `lane`'s orders and runs its auctions. */
  keepers: LocalAccount[];
}

export const ROLE_ENV: Record<RoleName, string> = {
  deployer: "DEPLOYER_PRIVATE_KEY",
  guardian: "GUARDIAN_PRIVATE_KEY",
  ops: "OPS_PRIVATE_KEY",
  keepers: "KEEPER_PRIVATE_KEYS",
};

export function normaliseKey(name: string, value: string): Hex {
  const v = value.trim().startsWith("0x") ? value.trim() : `0x${value.trim()}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${name} is not a 32-byte hex private key`);
  return v as Hex;
}

/** Load the hot keys; every role in `required` must be present (exactly 8 keepers). */
export function loadProdRoles(required: RoleName[]): ProdRoles {
  const one = (role: Exclude<RoleName, "keepers">) => {
    const v = envStr(ROLE_ENV[role]);
    return v ? privateKeyToAccount(normaliseKey(ROLE_ENV[role], v)) : null;
  };
  const keepersRaw = envStr(ROLE_ENV.keepers);
  const keepers = keepersRaw
    ? keepersRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((k, i) => privateKeyToAccount(normaliseKey(`KEEPER_PRIVATE_KEYS[${i}]`, k)))
    : [];
  const roles: ProdRoles = { deployer: one("deployer"), guardian: one("guardian"), ops: one("ops"), keepers };
  const missing = required.filter((r) => (r === "keepers" ? keepers.length !== LANES : roles[r] === null));
  if (missing.length) {
    throw new Error(
      `missing in the ${active.name} env: ${missing
        .map((r) => (r === "keepers" ? `KEEPER_PRIVATE_KEYS (exactly ${LANES}, got ${keepers.length})` : ROLE_ENV[r]))
        .join(", ")}. Generate them locally with \`npm run keeper:init -- --network ${active.name}\`.`,
    );
  }
  const seen = new Map<string, string>();
  const names = ["deployer", "guardian", "ops", ...keepers.map((_, i) => `keeper[${i}]`)];
  [roles.deployer, roles.guardian, roles.ops, ...keepers].forEach((a, i) => {
    if (!a) return;
    const k = a.address.toLowerCase();
    if (seen.has(k)) throw new Error(`${names[i]} and ${seen.get(k)} use the same key: every role needs its own key`);
    seen.set(k, names[i]);
  });
  return roles;
}

export function roleList(roles: ProdRoles): Array<{ role: string; address: Address }> {
  const out: Array<{ role: string; address: Address }> = [];
  if (roles.deployer) out.push({ role: "deployer", address: roles.deployer.address });
  if (roles.guardian) out.push({ role: "guardian", address: roles.guardian.address });
  if (roles.ops) out.push({ role: "ops", address: roles.ops.address });
  roles.keepers.forEach((k, i) => out.push({ role: `keeper[${i}]`, address: k.address }));
  return out;
}

export async function printBalances(
  client: Client,
  rows: Array<{ role: string; address: Address }>,
  unit = "MON",
): Promise<Map<string, bigint>> {
  const bals = await Promise.all(rows.map((r) => client.getBalance({ address: r.address })));
  const out = new Map<string, bigint>();
  rows.forEach((r, i) => {
    out.set(r.role, bals[i]);
    console.log(`  ${r.role.padEnd(11)} ${r.address}  ${Number(formatEther(bals[i])).toFixed(4).padStart(12)} ${unit}`);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Numeric env helpers
// ---------------------------------------------------------------------------

export function envNum(name: string, fallback: number): number {
  const v = envStr(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
}

export function envFlag(name: string, fallback = false): boolean {
  const v = envStr(name);
  if (v === undefined) return fallback;
  return !["0", "off", "false", "no"].includes(v.toLowerCase());
}
