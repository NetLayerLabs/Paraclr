// Server-only: reads `deployments/143.json` (Monad mainnet) for the landing page,
// the /terms and /risk pages, the root metadata and the OG card, and
// `deployments/10143.json` (Monad testnet) for the landing's testnet state.
//
// The mainnet beta counts as LIVE only when that file exists, parses, names
// chain 143 (or no chain), carries `"production": true` and lists at least one
// contract address. Anything else renders the "pending launch gate" state. We
// never claim live before the file exists, and we never invent a parameter: a
// value that isn't in the file (under one of the keys below) shows as "set at
// launch".
//
// The same rules decide "Live on Monad testnet" from deployments/10143.json
// (chain 10143). That file name is shared with the older demo stack, whose
// format has no `"production"` flag: without `"production": true` it is NOT
// the production deployment and the testnet state stays off (the demo stack
// is reported by benchResults.server.ts instead). Both files are read from the
// repo's deployments/ only (never PARACLR_DEPLOYMENTS_DIR): the landing claims
// what is committed, not a local rehearsal.
//
// The file is written by contracts/script/DeployProd.s.sol (contracts agent).
// Keys read here (see docs/PRODUCTION_PLAN.md, Deviations, content agent):
//   production: true                     required for the live state
//   chainId: 143                         optional; any other value -> not live
//   <name>: "0x…40 hex" | { address }    every address at the top level, or under
//                                        `contracts` / `addresses` / `roles` /
//                                        `governance`, becomes a contract-table row
//                                        (`pyth: { address, feeds }` works too)
//   deployBlock, deployedAt              optional
//   markets: { "MON/AUSD": "0x…" }       optional, market names
//   params | caps | limits | config | fees | oracle | orders | governance | risk:
//     maxLeverage                        x (a value >= 1e15 is read as 1e18 fixed point)
//     maxDepositPerAccountAusd           whole AUSD (…Ausd suffix); without the
//     maxTvlPerLaneAusd                  suffix the value is raw 6-decimal units,
//     maxOiPerLaneMarketAusd             as stored on chain
//     minPositionSizeAusd
//     tradingFeeBps, maxConfBps, maintenanceMarginBps
//     executionFeeMon (whole MON) | executionFeeWei | executionFee (wei)
//     minExecDelaySeconds, maxExecDelaySeconds, maxPriceAgeSeconds,
//     timelockMinDelaySeconds, fundingIntervalSeconds   (a bare name is seconds too)
// Key matching ignores case and underscores, so MAX_DEPOSIT_PER_ACCOUNT_AUSD works.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cache } from "react";

export const MONAD_MAINNET_CHAIN_ID = 143;
export const MONADSCAN = "https://monadscan.com";
export const PRODUCTION_FILE = `deployments/${MONAD_MAINNET_CHAIN_ID}.json`;

export const MONAD_TESTNET_CHAIN_ID = 10143;
/** Monad testnet explorer (viem `monadTestnet.blockExplorers.default`). */
export const MONAD_TESTNET_EXPLORER = "https://testnet.monadexplorer.com";
export const TESTNET_PRODUCTION_FILE = `deployments/${MONAD_TESTNET_CHAIN_ID}.json`;

export interface ProdContract {
  key: string;
  name: string;
  role: string;
  address: string;
  /** Not deployed by Paraclr (AUSD, Pyth). */
  external: boolean;
}

export interface ProdParams {
  maxLeverage: number | null;
  /** Whole AUSD. */
  depositCapPerAccount: number | null;
  tvlCapPerLane: number | null;
  oiCapPerLaneMarket: number | null;
  minPositionSize: number | null;
  tradingFeeBps: number | null;
  maintenanceMarginBps: number | null;
  /** Whole MON. */
  executionFee: number | null;
  minExecDelaySeconds: number | null;
  maxExecDelaySeconds: number | null;
  maxConfBps: number | null;
  maxPriceAgeSeconds: number | null;
  timelockDelaySeconds: number | null;
  fundingIntervalSeconds: number | null;
}

export interface ProductionStatus {
  live: boolean;
  /** Why an existing file doesn't count as live (server logs only; never shown as a claim). */
  problem: string | null;
  /** Which deployment this describes. */
  network: "mainnet" | "testnet";
  /** Repo path of the deployment file. */
  file: string;
  /** Explorer base URL for the contract links. */
  explorer: string;
  chainId: number;
  deployBlock: number | null;
  deployedAt: string | null;
  contracts: ProdContract[];
  params: ProdParams;
  markets: string[];
  /**
   * Testnet only: the file records that the clearinghouse was switched to the
   * keeper-signed fallback oracle after the Pyth data trial (`oracle` equal to
   * `fallbackOracle`, as `oracle:fallback record --live` writes). Prices are
   * then labelled "simulated after the Pyth trial".
   */
  pricesSimulated: boolean;
}

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const isAddress = (v: unknown): v is string => typeof v === "string" && ADDRESS_RE.test(v);
const norm = (k: string) => k.toLowerCase().replace(/[_\-\s]/g, "");

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return null;
}

const EMPTY_PARAMS: ProdParams = {
  maxLeverage: null,
  depositCapPerAccount: null,
  tvlCapPerLane: null,
  oiCapPerLaneMarket: null,
  minPositionSize: null,
  tradingFeeBps: null,
  maintenanceMarginBps: null,
  executionFee: null,
  minExecDelaySeconds: null,
  maxExecDelaySeconds: null,
  maxConfBps: null,
  maxPriceAgeSeconds: null,
  timelockDelaySeconds: null,
  fundingIntervalSeconds: null,
};

const NETWORKS = {
  mainnet: { chainId: MONAD_MAINNET_CHAIN_ID, file: PRODUCTION_FILE, explorer: MONADSCAN },
  testnet: { chainId: MONAD_TESTNET_CHAIN_ID, file: TESTNET_PRODUCTION_FILE, explorer: MONAD_TESTNET_EXPLORER },
} as const;

function pending(network: ProductionStatus["network"]): ProductionStatus {
  const n = NETWORKS[network];
  return {
    live: false,
    problem: null,
    network,
    file: n.file,
    explorer: n.explorer,
    chainId: n.chainId,
    deployBlock: null,
    deployedAt: null,
    contracts: [],
    params: EMPTY_PARAMS,
    markets: [],
    pricesSimulated: false,
  };
}

/** Known contract / role keys → display name + one-line role. Unknown keys are humanized. */
const KNOWN: Record<string, { name: string; role: string; external?: boolean; order: number }> = {
  clearinghouse: { name: "Clearinghouse", role: "Positions, delayed orders, auctions, backstop pools, solvency()", order: 0 },
  paraclrclearinghouse: { name: "Clearinghouse", role: "Positions, delayed orders, auctions, backstop pools, solvency()", order: 0 },
  oracle: { name: "Oracle adapter", role: "Verifies Pyth updates: staleness, confidence, positive price", order: 1 },
  pythoracle: { name: "Oracle adapter", role: "Verifies Pyth updates: staleness, confidence, positive price", order: 1 },
  pythadapter: { name: "Oracle adapter", role: "Verifies Pyth updates: staleness, confidence, positive price", order: 1 },
  timelock: { name: "Timelock", role: "Owner of the protocol. Every parameter, oracle or role change waits out its delay", order: 2 },
  timelockcontroller: { name: "Timelock", role: "Owner of the protocol. Every parameter, oracle or role change waits out its delay", order: 2 },
  multisig: { name: "Owner multisig", role: "Proposes and executes changes through the timelock", order: 3 },
  ownermultisig: { name: "Owner multisig", role: "Proposes and executes changes through the timelock", order: 3 },
  owner: { name: "Owner multisig", role: "A Safe. Proposes and executes changes through the timelock", order: 3 },
  proposer: { name: "Timelock proposer", role: "Can schedule a change; it still waits out the delay", order: 3 },
  executor: { name: "Timelock executor", role: "Can execute a scheduled change after the delay", order: 3 },
  guardian: { name: "Guardian", role: "Can pause deposits and new increase orders. Cannot unpause or change parameters", order: 4 },
  ops: { name: "Ops key", role: "Funding-rate updates and monitoring", order: 5 },
  ausd: { name: "AUSD (Agora)", role: "Collateral token. Issued by Agora, not by Paraclr", external: true, order: 6 },
  backstopoperators: { name: "Lane keeper", role: "May reduce its own lane's backstop pool only", order: 5 },
  // Testnet files (deploy:testnet, oracle:fallback; docs/TESTNET_PLAN.md Deviations).
  realpyth: { name: "Pyth", role: "Price oracle contract. Run by Pyth, not by Paraclr", external: true, order: 7 },
  ausdfaucet: {
    name: "AUSD faucet (Agora)",
    role: "Agora's testnet faucet: 10,000 test AUSD per claim, one claim a minute across everyone",
    external: true,
    order: 6,
  },
  fallbackoracle: {
    name: "Fallback oracle (standby)",
    role: "Testnet only: keeper-signed prices for after the Pyth trial. Not in use until the timelock switches to it",
    order: 7,
  },
  fallbacksigner: { name: "Fallback price signer", role: "Signs the fallback oracle's prices; holds no funds", order: 8 },
  pyth: { name: "Pyth", role: "Price oracle contract. Run by Pyth, not by Paraclr", external: true, order: 7 },
  deployer: { name: "Deployer", role: "Deploy key. The deploy script renounces its powers", order: 9 },
};

function humanize(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function collectContracts(dep: Json): ProdContract[] {
  const rows: Array<ProdContract & { order: number }> = [];
  const seen = new Set<string>();
  const add = (key: string, address: string, suffix = "") => {
    const id = `${norm(key)}:${address.toLowerCase()}`;
    if (seen.has(id)) return;
    seen.add(id);
    const known = KNOWN[norm(key)];
    rows.push({
      key: key + suffix,
      name: (known?.name ?? humanize(key)) + suffix,
      role: known?.role ?? "",
      address,
      external: known?.external ?? false,
      order: known?.order ?? 8,
    });
  };
  const scan = (obj: Json) => {
    for (const [k, v] of Object.entries(obj)) {
      if (["markets", "feeds", "pythfeeds", "priceids"].includes(norm(k))) continue;
      if (isAddress(v)) add(k, v);
      else if (isObj(v) && isAddress(v.address)) add(k, v.address); // e.g. pyth: { address, feeds }
      else if (Array.isArray(v) && v.length > 0 && v.every(isAddress)) {
        // backstopOperators[i] is lane i's keeper; lanes are numbered from 1 in the UI.
        v.forEach((a, i) => add(k, a, norm(k) === "backstopoperators" ? ` · lane ${i + 1}` : ` ${i}`));
      }
    }
  };
  scan(dep);
  for (const group of ["contracts", "addresses", "roles", "governance"]) {
    const g = dep[group];
    if (isObj(g)) scan(g);
  }
  return rows
    .sort((a, b) => a.order - b.order)
    .map((r) => ({ key: r.key, name: r.name, role: r.role, address: r.address, external: r.external }));
}

/** Every object we look in for parameters, root last so nested groups win. */
function paramScopes(dep: Json): Json[] {
  const scopes: Json[] = [];
  for (const k of ["params", "caps", "limits", "config", "fees", "oracle", "orders", "governance", "risk", "funding"]) {
    const v = dep[k];
    if (isObj(v)) scopes.push(v);
  }
  scopes.push(dep);
  return scopes;
}

function find(scopes: Json[], keys: string[]): { key: string; value: number } | null {
  const wanted = keys.map(norm);
  for (const want of wanted) {
    for (const s of scopes) {
      for (const [k, v] of Object.entries(s)) {
        if (norm(k) !== want) continue;
        const n = toNumber(v);
        if (n !== null) return { key: want, value: n };
      }
    }
  }
  return null;
}

/** Whole AUSD for `…ausd` keys; raw 6-decimal on-chain units otherwise. */
function ausdParam(scopes: Json[], wholeKeys: string[], rawKeys: string[]): number | null {
  const whole = find(scopes, wholeKeys);
  if (whole) return whole.value;
  const raw = find(scopes, rawKeys);
  return raw ? raw.value / 1e6 : null;
}

function parseParams(dep: Json): ProdParams {
  const s = paramScopes(dep);
  const lev = find(s, ["maxLeverage", "maxLeverageX"]);
  const feeMon = find(s, ["executionFeeMon"]);
  const feeWei = find(s, ["executionFeeWei", "executionFee", "minExecutionFee", "minExecutionFeeWei"]);
  const seconds = (keys: string[]) => find(s, keys)?.value ?? null;
  return {
    maxLeverage: lev ? (lev.value >= 1e15 ? lev.value / 1e18 : lev.value) : null,
    depositCapPerAccount: ausdParam(
      s,
      ["maxDepositPerAccountAusd", "depositCapPerAccountAusd", "accountDepositCapAusd", "depositCapAusd"],
      ["maxDepositPerAccount", "depositCapPerAccount", "accountDepositCap", "depositCap"],
    ),
    tvlCapPerLane: ausdParam(
      s,
      ["maxTvlPerLaneAusd", "tvlCapPerLaneAusd", "laneTvlCapAusd"],
      ["maxTvlPerLane", "tvlCapPerLane", "laneTvlCap"],
    ),
    oiCapPerLaneMarket: ausdParam(
      s,
      ["maxOiPerLaneMarketAusd", "oiCapPerLaneMarketAusd", "laneOiCapAusd", "maxOpenInterestPerLaneAusd"],
      ["maxOiPerLaneMarket", "oiCapPerLaneMarket", "laneOiCap", "maxOpenInterestPerLane"],
    ),
    minPositionSize: ausdParam(
      s,
      ["minPositionSizeAusd", "minPositionNotionalAusd", "minPositionAusd"],
      ["minPositionSize", "minPositionNotional"],
    ),
    tradingFeeBps: find(s, ["tradingFeeBps", "takerFeeBps", "feeBps"])?.value ?? null,
    maintenanceMarginBps: find(s, ["maintenanceMarginBps", "maintenanceBps"])?.value ?? null,
    executionFee: feeMon ? feeMon.value : feeWei ? feeWei.value / 1e18 : null,
    minExecDelaySeconds: seconds(["minExecDelaySeconds", "minExecDelay", "minExecutionDelay"]),
    maxExecDelaySeconds: seconds(["maxExecDelaySeconds", "maxExecDelay", "maxExecutionDelay"]),
    maxConfBps: find(s, ["maxConfBps", "maxConfidenceBps"])?.value ?? null,
    maxPriceAgeSeconds: seconds(["maxPriceAgeSeconds", "maxStalenessSeconds", "maxPriceAge", "maxStaleness", "stalenessSeconds"]),
    timelockDelaySeconds: seconds(["timelockMinDelaySeconds", "timelockDelaySeconds", "timelockMinDelay", "timelockDelay", "minDelay"]),
    fundingIntervalSeconds: seconds(["fundingIntervalSeconds", "fundingInterval", "minFundingInterval"]),
  };
}

/** Pure: a parsed deployment JSON → status (exported for checks against fixtures). */
export function parseProductionStatus(dep: unknown, network: ProductionStatus["network"]): ProductionStatus {
  const base = pending(network);
  const file = base.file;
  if (!isObj(dep)) return { ...base, problem: `${file} is not an object` };
  const chainId = toNumber(dep.chainId);
  if (chainId !== null && chainId !== base.chainId) {
    return { ...base, problem: `${file} says chainId ${chainId}` };
  }
  if (dep.production !== true) return { ...base, problem: `${file} has no "production": true` };
  let contracts = collectContracts(dep);
  const lc = (v: unknown) => (isAddress(v) ? v.toLowerCase() : null);
  const fallback = lc(dep.fallbackOracle);
  // `oracle:fallback record --live` (testnet, after the Pyth trial) points pyth / oracle at the fallback.
  const pricesSimulated =
    network === "testnet" &&
    (dep.priceSource === "keeper-signed" ||
      (fallback !== null && lc(dep.oracle) === fallback && dep.priceSource !== "pyth"));
  // One row per address and meaning: DeployProd writes `oracle` = `pyth`; testnet files add
  // `realPyth` (= `pyth` until the switch) and `fallbackOracle` (= `pyth` after it).
  const realPyth = lc(dep.realPyth) ?? lc(dep.pyth);
  contracts = contracts
    .filter((c) => {
      const k = norm(c.key);
      const a = c.address.toLowerCase();
      if (k === "oracle") return a !== lc(dep.pyth) && a !== realPyth && a !== fallback;
      if (k === "pyth") return a === realPyth && !contracts.some((o) => norm(o.key) === "realpyth" && o.address.toLowerCase() === a);
      return true;
    })
    .map((c) =>
      norm(c.key) === "fallbackoracle" && pricesSimulated
        ? {
            ...c,
            name: "Price oracle (keeper-signed)",
            role: "Testnet only, after the Pyth trial: prices signed by the Paraclr keeper, not attested by Pyth",
          }
        : c,
    );
  if (network === "testnet") {
    contracts = contracts.map((c) =>
      norm(c.key) === "ausd"
        ? { ...c, name: "AUSD (Agora, testnet)", role: "Agora's testnet AUSD: test funds, no real value. Issued by Agora, not by Paraclr" }
        : c,
    );
  }
  if (contracts.length === 0) return { ...base, problem: `${file} lists no contract addresses` };

  // The app's market order (MON, SOL, BTC), then anything else alphabetically.
  const ORDER = ["MON", "SOL", "BTC"];
  const rank = (m: string) => {
    const i = ORDER.indexOf(m.split("/")[0]);
    return i === -1 ? ORDER.length : i;
  };
  const markets = isObj(dep.markets)
    ? Object.keys(dep.markets).sort((x, y) => rank(x) - rank(y) || x.localeCompare(y))
    : [];
  const deployedAt =
    typeof dep.deployedAt === "string"
      ? dep.deployedAt
      : toNumber(dep.deployedAt) !== null
        ? new Date(toNumber(dep.deployedAt)! * 1000).toISOString()
        : null;
  return {
    ...base,
    live: true,
    problem: null,
    deployBlock: toNumber(dep.deployBlock),
    deployedAt,
    contracts,
    params: parseParams(dep),
    markets,
    pricesSimulated,
  };
}

async function load(network: ProductionStatus["network"]): Promise<ProductionStatus> {
  const n = NETWORKS[network];
  const path = join(process.cwd(), "deployments", `${n.chainId}.json`);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return pending(network); // not deployed: the normal pre-launch state
  }
  let dep: unknown;
  try {
    dep = JSON.parse(text);
  } catch {
    return { ...pending(network), problem: `${n.file} is not valid JSON` };
  }
  return parseProductionStatus(dep, network);
}

/** Mainnet beta (deployments/143.json). Memoized per render (layout metadata, page and OG card share one read). */
export const loadProductionStatus = cache(() => load("mainnet"));

/**
 * Production contracts on Monad testnet (deployments/10143.json with
 * `"production": true`; the older demo-stack file doesn't count).
 */
export const loadTestnetProductionStatus = cache(() => load("testnet"));
