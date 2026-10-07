// Production deployment file: deployments/143.json (written by DeployProd.s.sol through
// `npm run deploy:mainnet`), or DEPLOYMENTS_OUT. A rehearsal NEVER reads or writes
// deployments/143.json: on an anvil (fork) DEPLOYMENTS_OUT is mandatory.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { DEPLOYMENTS_DIR, envStr, REPO_ROOT } from "../env";
import { clearinghouseAbi } from "./abi";
import { KNOWN, MAINNET_CHAIN_ID, rel, type ProdChain } from "./config";

export interface ProdDeployment {
  file: string;
  chainId: number;
  production: boolean;
  clearinghouse: Address;
  ausd: Address;
  pyth: Address;
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

/** Where this process reads/writes the production deployment. Refuses the canonical file on anvil. */
export function prodDeploymentPath(chain: Pick<ProdChain, "fork" | "chainId">): string {
  const override = envStr("DEPLOYMENTS_OUT");
  const file = override ? resolve(REPO_ROOT, override) : join(DEPLOYMENTS_DIR, `${chain.chainId}.json`);
  if (chain.fork && resolve(file) === resolve(CANONICAL_MAINNET_FILE)) {
    throw new Error(
      `refusing to use ${rel(CANONICAL_MAINNET_FILE)} against an anvil chain: set DEPLOYMENTS_OUT to a rehearsal path ` +
        "(npm run rehearse:mainnet does this for you).",
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
    if (v && typeof v === "object" && !Array.isArray(v) && !["markets", "feeds", "pythFeeds", "caps", "params"].includes(k)) {
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
  return {
    file,
    chainId: Number(raw.chainId),
    production: raw.production === true,
    clearinghouse: addr(raw, ["clearinghouse", "ParaclrClearinghouseProd", "paraclr"], file, true),
    ausd: addr(raw, ["ausd", "AUSD", "collateral"], file, true),
    pyth: addr(raw, ["pyth", "oracle", "Pyth"], file, true),
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
  if (!dep) throw new Error(`no production deployment at ${rel(file)}. Run \`npm run deploy:mainnet\` first.`);
  if (dep.chainId !== chain.chainId) throw new Error(`${rel(file)} is for chain ${dep.chainId}, RPC is ${chain.chainId}`);
  if (!dep.production) throw new Error(`${rel(file)} lacks "production": true — refusing to run production loops on a demo deployment`);
  const codes = await Promise.all([dep.clearinghouse, dep.ausd, dep.pyth].map((address) => chain.client.getCode({ address })));
  if (codes.some((c) => !c || c === "0x")) throw new Error(`${rel(file)} points at addresses with no code on ${chain.label}`);
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
