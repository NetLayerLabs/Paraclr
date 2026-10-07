// Production deployment file: deployments/143.json / deployments/10143.json (written by
// DeployProd.s.sol through `npm run deploy:mainnet` / `deploy:testnet`), or DEPLOYMENTS_OUT. A
// rehearsal or the sandbox NEVER reads or writes either canonical file: on an anvil (fork)
// DEPLOYMENTS_OUT is mandatory.
//
// Oracle: the contract's `pyth()` is the truth. On testnet it may have been switched, through the
// timelock, from the real Pyth to the keeper-signed fallback (contracts/src/testnet/
// KeeperSignedPyth.sol, after the Pyth API trial); `oracle` says which one is live.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { DEPLOYMENTS_DIR, envStr, REPO_ROOT } from "../env";
import { clearinghouseAbi } from "./abi";
import { KNOWN, MAINNET_CHAIN_ID, net, rel, TESTNET_CHAIN_ID, type ProdChain } from "./config";

export interface ProdDeployment {
  file: string;
  chainId: number;
  production: boolean;
  /** "monad-testnet" on testnet deployments (DEPLOY_NETWORK); absent on the original mainnet file. */
  network: string | null;
  clearinghouse: Address;
  ausd: Address;
  /** The oracle the clearinghouse uses NOW (`pyth()` on chain; the file's value until verified). */
  pyth: Address;
  /** The real Pyth contract of this network (the file's "pyth"). */
  realPyth: Address;
  /** The keeper-signed fallback oracle, if one was recorded (file "fallbackOracle" or env KEEPER_SIGNED_PYTH_ADDRESS). */
  fallbackOracle: Address | null;
  /** Which oracle is live: "pyth" or "keeper-signed" (fallbackOracle == pyth()). */
  oracle: "pyth" | "keeper-signed";
  timelock: Address | null;
  guardian: Address | null;
  deployBlock: number;
  /** symbol → bytes32 market id */
  markets: Record<string, Hex>;
  /** symbol → Pyth feed id */
  feeds: Record<string, Hex>;
  raw: Record<string, unknown>;
}

export const CANONICAL_MAINNET_FILE = join(DEPLOYMENTS_DIR, `${MAINNET_CHAIN_ID}.json`);
export const CANONICAL_TESTNET_FILE = join(DEPLOYMENTS_DIR, `${TESTNET_CHAIN_ID}.json`);

/** Where this process reads/writes the production deployment. Refuses a canonical file on anvil. */
export function prodDeploymentPath(chain: Pick<ProdChain, "fork" | "chainId">): string {
  const override = envStr("DEPLOYMENTS_OUT");
  const file = override ? resolve(REPO_ROOT, override) : join(DEPLOYMENTS_DIR, `${chain.chainId}.json`);
  const canonical = [CANONICAL_MAINNET_FILE, CANONICAL_TESTNET_FILE].find((f) => resolve(file) === resolve(f));
  if (chain.fork && canonical) {
    throw new Error(
      `refusing to use ${rel(canonical)} against an anvil chain: set DEPLOYMENTS_OUT to a rehearsal / sandbox path ` +
        "(npm run rehearse:mainnet, rehearse:testnet and sandbox do this for you).",
    );
  }
  if (chain.fork && !override) {
    throw new Error("an anvil (fork) run needs DEPLOYMENTS_OUT (rehearsal output dir); deployments/ is for the real chain only");
  }
  return file;
}

function addr(raw: Record<string, unknown>, keys: string[], file: string, required: true): Address;
function addr(raw: Record<string, unknown>, keys: string[], file: string, required: false): Address | null;
function addr(raw: Record<string, unknown>, keys: string[], file: string, required: boolean): Address | null {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === "string" && isAddress(v)) return getAddress(v);
  }
  if (required) throw new Error(`${rel(file)}: missing address "${keys[0]}"`);
  return null;
}

/** Shallow-flatten one level of nested objects ({ contracts: {…}, roles: {…} }) so either layout works. */
function flatten(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const [k, v] of Object.entries(raw)) {
    if (v && typeof v === "object" && !Array.isArray(v) && !["markets", "feeds", "pythFeeds", "caps", "params", "oracleSwitch"].includes(k)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) if (!(k2 in out)) out[k2] = v2;
    }
  }
  return out;
}

export function readProdDeployment(file: string): ProdDeployment | null {
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  // forge's vm.serializeString may leave nested objects as JSON strings
  for (const k of ["markets", "pythFeeds", "feeds", "params"]) {
    if (typeof parsed[k] === "string") {
      try {
        parsed[k] = JSON.parse(parsed[k] as string);
      } catch {
        /* leave as is */
      }
    }
  }
  const raw = flatten(parsed);
  const markets: Record<string, Hex> = {};
  for (const [sym, id] of Object.entries((raw.markets ?? {}) as Record<string, unknown>)) {
    const v = typeof id === "string" ? id : id && typeof id === "object" ? (id as Record<string, unknown>).id : undefined;
    if (typeof v !== "string" || !isHex(v) || v.length !== 66) throw new Error(`${rel(file)}: bad market id for ${sym}`);
    markets[sym] = v;
  }
  if (Object.keys(markets).length === 0) throw new Error(`${rel(file)}: no markets`);
  const feeds: Record<string, Hex> = {};
  const feedSrc = (raw.feeds ?? raw.pythFeeds ?? {}) as Record<string, unknown>;
  for (const sym of Object.keys(markets)) {
    const fromMarkets = (raw.markets as Record<string, unknown>)[sym];
    const nested = fromMarkets && typeof fromMarkets === "object" ? (fromMarkets as Record<string, unknown>).feedId ?? (fromMarkets as Record<string, unknown>).feed : undefined;
    const v = feedSrc[sym] ?? nested;
    if (typeof v === "string" && isHex(v) && v.length === 66) feeds[sym] = v.toLowerCase() as Hex;
  }
  const pyth = addr(raw, ["pyth", "oracle", "Pyth"], file, true);
  const realPyth = addr(raw, ["realPyth", "pyth", "Pyth"], file, false) ?? pyth;
  const fallbackEnv = envStr("KEEPER_SIGNED_PYTH_ADDRESS");
  const fallbackOracle = addr(raw, ["fallbackOracle"], file, false) ?? (fallbackEnv && isAddress(fallbackEnv) ? getAddress(fallbackEnv) : null);
  return {
    file,
    chainId: Number(raw.chainId),
    production: raw.production === true,
    network: typeof raw.network === "string" ? raw.network : null,
    clearinghouse: addr(raw, ["clearinghouse", "ParaclrClearinghouseProd", "paraclr"], file, true),
    ausd: addr(raw, ["ausd", "AUSD", "collateral"], file, true),
    pyth,
    realPyth,
    fallbackOracle,
    oracle: fallbackOracle && fallbackOracle.toLowerCase() === pyth.toLowerCase() ? "keeper-signed" : "pyth",
    timelock: addr(raw, ["timelock", "owner", "TimelockController"], file, false),
    guardian: addr(raw, ["guardian"], file, false),
    deployBlock: Number(raw.deployBlock ?? 0),
    markets,
    feeds,
    raw,
  };
}

/**
 * The production deployment of the connected chain, verified: production flag, chain id, code at
 * every address, and every market's Pyth feed id (file → on-chain `priceFeedId` → known ids).
 */
export async function loadProdDeployment(chain: ProdChain): Promise<ProdDeployment> {
  const file = prodDeploymentPath(chain);
  const dep = readProdDeployment(file);
  if (!dep) throw new Error(`no production deployment at ${rel(file)}. Run \`${chain.profile.deployCmd}\` first.`);
  if (dep.chainId !== chain.chainId) throw new Error(`${rel(file)} is for chain ${dep.chainId}, RPC is ${chain.chainId}`);
  if (!dep.production) throw new Error(`${rel(file)} lacks "production": true — refusing to run production loops on a demo deployment`);
  if (dep.network && dep.network !== chain.profile.slug) throw new Error(`${rel(file)} says "network": "${dep.network}", this is --network ${chain.profile.name}`);
  const codes = await Promise.all([dep.clearinghouse, dep.ausd, dep.pyth].map((address) => chain.client.getCode({ address })));
  if (codes.some((c) => !c || c === "0x")) throw new Error(`${rel(file)} points at addresses with no code on ${chain.label}`);
  await resolveOracle(chain, dep);
  // Feed ids: the contract is authoritative (getMarkets → ids, symbols, feeds); the file must agree.
  const [ids, symbols, feeds] = (await chain.client.readContract({
    address: dep.clearinghouse,
    abi: clearinghouseAbi,
    functionName: "getMarkets",
  })) as readonly [readonly Hex[], readonly string[], readonly Hex[]];
  ids.forEach((id, i) => {
    const sym = symbols[i];
    const fromFile = dep.markets[sym];
    if (fromFile && fromFile.toLowerCase() !== id.toLowerCase()) throw new Error(`${rel(file)}: ${sym} market id differs from the contract's`);
    dep.markets[sym] = id;
    const f = feeds[i].toLowerCase() as Hex;
    if (dep.feeds[sym] && dep.feeds[sym] !== f) throw new Error(`${rel(file)}: ${sym} feed ${dep.feeds[sym]} ≠ on-chain ${f}`);
    dep.feeds[sym] = f;
    if (!chain.fork && KNOWN.feeds[sym] && KNOWN.feeds[sym].toLowerCase() !== f) {
      console.warn(`[deployment] WARNING ${sym} uses Pyth feed ${f}, not the verified ${KNOWN.feeds[sym]}`);
    }
  });
  for (const sym of Object.keys(dep.markets)) {
    if (!dep.feeds[sym]) throw new Error(`${sym} is in ${rel(file)} but not listed on the contract`);
  }
  return dep;
}

/**
 * Read the clearinghouse's live oracle (`pyth()`) and set dep.pyth / dep.oracle from it. A
 * timelocked `setPyth` to the keeper-signed fallback (testnet, after the Pyth trial) is picked up
 * here at startup and live by the monitor (PythUpdated). An oracle that is neither the file's Pyth
 * nor the recorded fallback is refused: the keeper would not know how to price it.
 */
export async function resolveOracle(chain: ProdChain, dep: ProdDeployment): Promise<"pyth" | "keeper-signed"> {
  const live = (await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "pyth" })) as Address;
  if (live.toLowerCase() === dep.realPyth.toLowerCase()) {
    dep.pyth = dep.realPyth;
    dep.oracle = "pyth";
  } else if (dep.fallbackOracle && live.toLowerCase() === dep.fallbackOracle.toLowerCase()) {
    dep.pyth = dep.fallbackOracle;
    dep.oracle = "keeper-signed";
  } else {
    throw new Error(
      `the clearinghouse's oracle pyth() = ${live} is neither the deployment's Pyth ${dep.realPyth} nor a recorded keeper-signed fallback ` +
        `(${dep.fallbackOracle ?? "none"}). Set KEEPER_SIGNED_PYTH_ADDRESS or record it (npm run oracle:fallback -- record).`,
    );
  }
  if (net().name === "mainnet" && dep.oracle !== "pyth") throw new Error("a keeper-signed oracle is testnet-only; mainnet must run on Pyth");
  return dep.oracle;
}
