// Production (Monad mainnet, chain 143) configuration: env file, network gate, confirmation gate,
// hot-key roles. Used by every `--network mainnet` command (keeper, keeper:init, keeper:fund,
// deploy:mainnet, guardian:pause, rehearse:mainnet).
//
// Rules (docs/PRODUCTION_PLAN.md "Keeper / ops"):
//   - `--network mainnet` loads keeper/.env.mainnet (or --env / KEEPER_ENV_FILE) and NOTHING
//     else: keeper/.env (testnet keys) and keeper/.env.anvil are never read in this mode.
//   - The RPC must report chain id 143. An anvil fork of Monad mainnet also reports 143; it is
//     detected by its client version and labelled "anvil fork (NOT mainnet)" everywhere.
//   - Anything that sends a transaction to the real chain prints balances + a cost estimate and
//     then refuses unless `--yes-mainnet` is passed. On an anvil fork no confirmation is needed.
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
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad } from "viem/chains";
import { envStr, loadKeeperEnv, REPO_ROOT, rpcHost } from "../env";

export const MAINNET_CHAIN_ID = 143;
export const MAINNET_RPC_URL = monad.rpcUrls.default.http[0];
export const MAINNET_ENV_FILE = join(REPO_ROOT, "keeper", ".env.mainnet");
export const MAINNET_EXPLORER = monad.blockExplorers.default.url;
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

export type Client = PublicClient<HttpTransport, Chain>;

export type Args = Record<string, string | true>;

export function isMainnet(args: Args): boolean {
  return args.network === "mainnet";
}

/**
 * Load keeper/.env.mainnet (or `--env PATH`, else KEEPER_ENV_FILE). Values already in the shell
 * win (Node's loadEnvFile semantics), which is how hosted deployments pass secrets.
 * `required: false` lets keeper:init run before the file exists.
 */
export function loadMainnetEnv(args: Args, opts: { required?: boolean } = {}): string | null {
  const file = resolveEnvFile(args);
  process.env.KEEPER_ENV_FILE = file;
  if (!existsSync(file)) {
    if (opts.required === false || process.env.KEEPER_SECRETS_FROM_ENV === "1") return null;
    throw new Error(
      `${rel(file)} not found. Create it with \`npm run keeper:init -- --network mainnet\` ` +
        "(or copy keeper/.env.mainnet.example). Hosted keepers set KEEPER_SECRETS_FROM_ENV=1 and pass every variable as a secret.",
    );
  }
  warnIfReadable(file);
  return loadKeeperEnv(file);
}

export function resolveEnvFile(args: Args): string {
  if (typeof args.env === "string") return resolve(process.cwd(), args.env);
  const fromEnv = process.env.KEEPER_ENV_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(REPO_ROOT, fromEnv.trim());
  return MAINNET_ENV_FILE;
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
  return envStr("KEEPER_RPC_URL") ?? MAINNET_RPC_URL;
}

// ---------------------------------------------------------------------------
// Chain
// ---------------------------------------------------------------------------

export interface ProdChain {
  rpcUrl: string;
  chainId: number;
  /** True on ANY local anvil (a fork of Monad mainnet, or a plain anvil in the rehearsal's
   *  MockPyth leg): no real value, no confirmation needed, never the canonical deployment file. */
  fork: boolean;
  clientVersion: string;
  /** "Monad mainnet" or "anvil fork of Monad mainnet (NOT mainnet)" / "anvil (NOT mainnet)". */
  label: string;
  /** "monad-mainnet" | "anvil-fork" | "anvil" — goes into every report. */
  network: "monad-mainnet" | "anvil-fork" | "anvil";
  chain: Chain;
  client: Client;
}

export function makeProdClient(rpcUrl: string, chain: Chain): Client {
  return createPublicClient({
    chain,
    cacheTime: 0,
    pollingInterval: 400,
    transport: http(rpcUrl, {
      batch: envStr("KEEPER_RPC_BATCH") === "0" ? false : { wait: 0, batchSize: 50 },
      retryCount: 3,
      retryDelay: 250,
      timeout: 20_000,
    }),
  }) as Client;
}

/**
 * Connect and enforce chain id 143. `allowLocal` additionally accepts a plain (non-fork) anvil
 * with any chain id — only the rehearsal's MockPyth leg uses it.
 */
export async function connectMainnet(rpcUrl: string, opts: { allowLocal?: boolean } = {}): Promise<ProdChain> {
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
  if (chainId !== MAINNET_CHAIN_ID && !(opts.allowLocal && anvil)) {
    throw new Error(
      `--network mainnet expects chain id ${MAINNET_CHAIN_ID}; ${rpcHost(rpcUrl)} reports ${chainId} (${clientVersion}). ` +
        "Check KEEPER_RPC_URL / CHAIN_ID in keeper/.env.mainnet.",
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
  const network = !anvil ? "monad-mainnet" : forked ? "anvil-fork" : "anvil";
  const label =
    network === "monad-mainnet"
      ? "Monad mainnet"
      : network === "anvil-fork"
        ? "anvil fork of Monad mainnet (NOT mainnet)"
        : `plain anvil, chain ${chainId} (NOT mainnet, no fork)`;
  const chain: Chain = {
    ...monad,
    id: chainId,
    name: network === "monad-mainnet" ? monad.name : label,
    rpcUrls: { default: { http: [rpcUrl] } },
  };
  return { rpcUrl, chainId, fork: anvil, clientVersion, label, network, chain, client: makeProdClient(rpcUrl, chain) };
}

/**
 * The confirmation gate. On the real chain: refuse unless `--yes-mainnet` was passed (the caller
 * has already printed balances and the cost estimate). On an anvil fork it is a no-op.
 */
export function confirmMainnet(chain: ProdChain, args: Args, what: string): void {
  if (chain.fork) {
    console.log(`[mainnet] ${chain.label}: "${what}" needs no confirmation (no real value).`);
    return;
  }
  if (args["yes-mainnet"] === true) {
    console.log(`[mainnet] --yes-mainnet given: ${what} on Monad MAINNET (real MON).`);
    return;
  }
  console.error(
    `\n[mainnet] REFUSING: ${what} sends real transactions on Monad mainnet.\n` +
      "          Review the balances and the cost estimate above, then re-run with --yes-mainnet.\n",
  );
  process.exit(2);
}

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
      `missing in the mainnet env: ${missing
        .map((r) => (r === "keepers" ? `KEEPER_PRIVATE_KEYS (exactly ${LANES}, got ${keepers.length})` : ROLE_ENV[r]))
        .join(", ")}. Generate them locally with \`npm run keeper:init -- --network mainnet\`.`,
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
