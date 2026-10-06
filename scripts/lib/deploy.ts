// Shared deploy flow for `npm run deploy:anvil`, `npm run deploy:monad` and `npm run dev:chain`.
//
// Runs contracts/script/Deploy.s.sol with forge, passing the operator key to forge through the
// child-process environment only (never argv, never printed), then replaces the script's
// approximate `deployBlock` with the exact block of the first deploy receipt.
//
// DEPLOYMENTS_OUT=<path> (private stacks): forge runs from a shadow foundry root
// (keeper/src/foundry.ts) so Deploy.s.sol's own write lands under contracts/cache/shadow/…, and the
// result is written to <path>. The canonical deployments/<chainId>.json is never touched.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CONTRACTS_DIR, envStr, rpcHost } from "../../keeper/src/env";
import { foundryBin, shadowRoot } from "../../keeper/src/foundry";
import {
  ANVIL_ROLE_INDEX,
  anvilAccount,
  anvilPrivateKey,
  deploymentLabel,
  deploymentPath,
  detectChain,
  loadDeployment,
  makeClient,
  type ChainInfo,
  type Deployment,
  type Network,
} from "../../keeper/src/network";

export { foundryBin };

/** Backstop pool take threshold set on every lane at deploy (below the legacy 100 bps penalty). */
export const DEFAULT_MIN_DISCOUNT_BPS = 75;

/** backstopMinDiscountBps(lane) for lanes 0..7 of every design in `dep` (read-only). */
export async function readMinDiscounts(rpcUrl: string, dep: Deployment): Promise<Record<string, number[]>> {
  const client = makeClient(rpcUrl);
  const abi = [
    { type: "function", name: "backstopMinDiscountBps", stateMutability: "view", inputs: [{ name: "lane", type: "uint8" }], outputs: [{ type: "uint256" }] },
  ] as const;
  const designs: Array<[string, `0x${string}`]> = [["paraclr", dep.clearinghouse], ...(dep.naive ? ([["naive", dep.naive]] as Array<[string, `0x${string}`]>) : [])];
  const out: Record<string, number[]> = {};
  for (const [name, address] of designs) {
    out[name] = (
      await Promise.all(
        Array.from({ length: 8 }, (_, lane) => client.readContract({ address, abi, functionName: "backstopMinDiscountBps", args: [lane] })),
      )
    ).map(Number);
  }
  return out;
}

/** Key order of deployments/<chainId>.json; any other key the deploy script writes is kept after these. */
const KEY_ORDER = ["chainId", "clearinghouse", "ausd", "oracle", "naive", "deployBlock", "markets"];

function normaliseKey(name: string, v: string): Hex {
  const k = v.startsWith("0x") ? v : `0x${v}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${name} is not a 32-byte hex private key`);
  return k as Hex;
}

export interface DeployOptions {
  network: Network;
  rpcUrl: string;
  /** Print forge output (default true). */
  verbose?: boolean;
}

export interface DeployResult {
  info: ChainInfo;
  deployment: Deployment;
  operator: `0x${string}`;
  pricePusher: `0x${string}`;
}

export async function deployStack(opts: DeployOptions): Promise<DeployResult> {
  const info = await detectChain(opts.rpcUrl);
  if (info.network !== opts.network) {
    throw new Error(`RPC ${rpcHost(opts.rpcUrl)} is ${info.network} (chain ${info.chainId}), expected ${opts.network}`);
  }

  const opEnv = envStr("OPERATOR_PRIVATE_KEY");
  const pusherEnv = envStr("PRICE_PUSHER_PRIVATE_KEY");
  if (opts.network === "monad-testnet" && (!opEnv || !pusherEnv)) {
    throw new Error(
      "deploy:monad needs OPERATOR_PRIVATE_KEY and PRICE_PUSHER_PRIVATE_KEY in keeper/.env " +
        "(create them locally with `npm run keeper:init`).",
    );
  }
  const operatorKey = opEnv ? normaliseKey("OPERATOR_PRIVATE_KEY", opEnv) : anvilPrivateKey(ANVIL_ROLE_INDEX.operator);
  const operator = privateKeyToAccount(operatorKey).address;
  const pricePusher = pusherEnv
    ? privateKeyToAccount(normaliseKey("PRICE_PUSHER_PRIVATE_KEY", pusherEnv)).address
    : anvilAccount(ANVIL_ROLE_INDEX.pricePusher).address;

  const client = makeClient(opts.rpcUrl);
  const balance = await client.getBalance({ address: operator });
  console.log(`[deploy] ${info.network} chain ${info.chainId} via ${rpcHost(opts.rpcUrl)}`);
  console.log(`[deploy] operator/owner ${operator} (balance ${formatEther(balance)}), price pusher ${pricePusher}`);
  // Measured on anvil (Oct 7): 67 txs, 15.57M gas used, 20.72M gas LIMIT — both designs + insurance
  // + backstop seeding + the per-lane min discount. Monad bills the limit: ≈2.1 MON at 102 gwei.
  if (opts.network === "monad-testnet" && balance < BigInt(3) * BigInt(1e18)) {
    console.warn("[deploy] WARNING operator has < 3 MON; the deploy (~20.7M gas billed on limit, ≈2.1 MON) may run out.");
  }

  // Every lane pool on both designs gets this take threshold explicitly (Deploy.s.sol honours the
  // env), so it never depends on the contract default. 75 bps < the legacy 1% penalty.
  const minDiscountBps = Number(envStr("BACKSTOP_MIN_DISCOUNT_BPS") ?? DEFAULT_MIN_DISCOUNT_BPS);
  if (!Number.isInteger(minDiscountBps) || minDiscountBps <= 0 || minDiscountBps > 10_000) {
    throw new Error("BACKSTOP_MIN_DISCOUNT_BPS must be an integer in 1..10000");
  }

  // Private stack → shadow root (Deploy.s.sol's own JSON write can't reach deployments/).
  const privateOut = envStr("DEPLOYMENTS_OUT");
  const shadow = privateOut ? shadowRoot(`deploy-${new URL(opts.rpcUrl).port || "rpc"}`) : null;
  const root = shadow?.root ?? CONTRACTS_DIR;
  const scriptPath = join(CONTRACTS_DIR, "script", "Deploy.s.sol");
  const args = ["script", `${scriptPath}:Deploy`, "--root", root, "--rpc-url", opts.rpcUrl, "--broadcast"];
  // Monad: one tx at a time (keeps in-flight fees inside the reserve-balance budget; avoids
  // relying on the "pending" nonce, which Monad treats as "latest").
  if (opts.network === "monad-testnet") args.push("--slow");
  const forge = foundryBin("forge");
  if (shadow) {
    rmSync(join(shadow.deploymentsDir, `${info.chainId}.json`), { force: true }); // never read a stale one
    console.log(`[deploy] private deploy: forge root ${root} → ${deploymentLabel(info.chainId)}`);
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(forge, args, {
      cwd: root,
      env: { ...process.env, PRIVATE_KEY: operatorKey, ORACLE_UPDATERS: pricePusher, BACKSTOP_MIN_DISCOUNT_BPS: String(minDiscountBps) },
      stdio: opts.verbose === false ? ["ignore", "ignore", "inherit"] : "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`forge script exited with ${code}`))));
  });

  // Exact deploy block from the broadcast receipts.
  const runFile = join(root, "broadcast", "Deploy.s.sol", String(info.chainId), "run-latest.json");
  const forgeOut = shadow ? join(shadow.deploymentsDir, `${info.chainId}.json`) : deploymentPath(info.chainId);
  const depFile = deploymentPath(info.chainId);
  if (!existsSync(forgeOut)) throw new Error(`forge did not write ${forgeOut}`);
  const dep = JSON.parse(readFileSync(forgeOut, "utf8")) as Record<string, unknown>;
  if (existsSync(runFile)) {
    const run = JSON.parse(readFileSync(runFile, "utf8")) as { receipts?: Array<{ blockNumber: string }> };
    const blocks = (run.receipts ?? []).map((r) => Number(BigInt(r.blockNumber)));
    if (blocks.length) dep.deployBlock = Math.min(...blocks);
  }
  // Keep every key the script wrote (e.g. "naive"), canonical ones first.
  const ordered: Record<string, unknown> = {};
  for (const k of KEY_ORDER) if (k in dep) ordered[k] = dep[k];
  for (const [k, v] of Object.entries(dep)) if (!(k in ordered)) ordered[k] = v;
  mkdirSync(dirname(depFile), { recursive: true });
  writeFileSync(depFile, JSON.stringify(ordered, null, 2) + "\n");

  const deployment = await loadDeployment(makeClient(opts.rpcUrl), info);
  console.log(`[deploy] wrote ${deploymentLabel(info.chainId)} (deployBlock ${deployment.deployBlock})`);
  const mins = await readMinDiscounts(opts.rpcUrl, deployment);
  for (const [name, lanes] of Object.entries(mins)) {
    if (lanes.some((b) => b !== minDiscountBps)) {
      throw new Error(`${name}: backstopMinDiscountBps per lane = [${lanes.join(", ")}], expected ${minDiscountBps} everywhere`);
    }
  }
  console.log(`[deploy] backstopMinDiscountBps = ${minDiscountBps} on all 8 lanes of ${Object.keys(mins).join(" + ")} (verified on chain)`);
  return { info, deployment, operator, pricePusher };
}

/** True when deployments/<chainId>.json exists, has code, and is owned by `owner`. */
export async function isDeployed(rpcUrl: string, info: ChainInfo, owner: `0x${string}`): Promise<boolean> {
  try {
    const client = makeClient(rpcUrl);
    const dep = await loadDeployment(client, info);
    const actual = (await client.readContract({
      address: dep.clearinghouse,
      abi: [{ type: "function", name: "owner", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }],
      functionName: "owner",
    })) as string;
    return actual.toLowerCase() === owner.toLowerCase();
  } catch {
    return false;
  }
}
