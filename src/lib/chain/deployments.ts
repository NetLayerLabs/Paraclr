// Deployed contract addresses for the active chain.
//
// Precedence (docs/ONCHAIN_PLAN.md):
//   1. `deployments/<chainId>.json` written by the deploy flow - read on the
//      server by deployments.server.ts and handed to the client as a prop, so a
//      missing file never breaks the build;
//   2. NEXT_PUBLIC_CLEARINGHOUSE_ADDRESS / _AUSD_ADDRESS / _ORACLE_ADDRESS;
//   3. the keeper's `GET /health` → `addresses` (runtime.ts).
// AUSD and oracle addresses can also be read from the clearinghouse itself
// (`ausd()`, `oracle()`), so the clearinghouse address is the only hard
// requirement.

import { isAddress, isHex, keccak256, toHex, type Address, type Hex } from "viem";
import { MARKETS, type MarketSymbol } from "../types";
import { CONTRACTS } from "./contracts";

/** Shape of `deployments/<chainId>.json` (owned by the chain agent). */
export interface DeploymentFile {
  chainId: number;
  clearinghouse: Address;
  ausd: Address | null;
  oracle: Address | null;
  deployBlock: number | null;
  markets: Partial<Record<string, Hex>>;
  /**
   * The production contract set (docs/PRODUCTION_PLAN.md): real collateral,
   * Pyth, delayed orders. Only `"production": true` counts.
   */
  production: boolean;
  /** Pyth contract (production): the network's real Pyth (`realPyth`, else `pyth`). */
  pyth: Address | null;
  /**
   * Testnet only: the keeper-signed fallback oracle (contracts/src/testnet/
   * KeeperSignedPyth.sol) the timelock may switch the clearinghouse to after
   * the Pyth data trial. runtime.ts reads the live oracle from `pyth()`.
   */
  fallbackOracle: Address | null;
  /** Pyth price feed id per app market (production; optional - also readable on chain). */
  pythFeeds: Partial<Record<string, Hex>>;
  timelock: Address | null;
  guardian: Address | null;
}

export interface ResolvedContracts {
  clearinghouse: Address;
  ausd: Address | null;
  oracle: Address | null;
  deployBlock: number | null;
  /** bytes32 market id per app market (`keccak256("MON/AUSD")` unless the deployment says otherwise). */
  markets: Record<MarketSymbol, Hex>;
  /**
   * The markets this deployment trades, in MARKETS order. Production: the
   * deployment file's `markets` keys (runtime.ts then keeps only those listed
   * on chain); every read, price feed and market picker uses this list, so an
   * unlisted market (e.g. MON on testnet) is never read. Demo stacks: all.
   */
  listed: MarketSymbol[];
  source: "deployments" | "env" | "keeper";
  production: boolean;
  pyth: Address | null;
  fallbackOracle: Address | null;
  pythFeeds: Partial<Record<MarketSymbol, Hex>>;
  timelock: Address | null;
  guardian: Address | null;
}

export function marketIdOf(symbol: string): Hex {
  return keccak256(toHex(symbol));
}

function addr(v: unknown): Address | null {
  return typeof v === "string" && isAddress(v) ? v : null;
}

function bytes32Map(v: unknown): Partial<Record<string, Hex>> {
  const out: Partial<Record<string, Hex>> = {};
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (typeof x === "string" && isHex(x) && x.length === 66) out[k] = x;
    }
  }
  return out;
}

/** Feed ids keyed by app market; accepts "MON/AUSD" or "MON/USD"-style keys. */
function feedMap(v: Partial<Record<string, Hex>>): Partial<Record<MarketSymbol, Hex>> {
  const out: Partial<Record<MarketSymbol, Hex>> = {};
  for (const s of MARKETS) {
    const base = s.split("/")[0];
    const hit = v[s] ?? v[`${base}/USD`] ?? v[base] ?? v[`Crypto.${base}/USD`];
    if (hit) out[s] = hit;
  }
  return out;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}

/** Validate an untrusted deployment JSON. Returns a reason instead of throwing. */
export function parseDeployment(
  raw: unknown,
  expectedChainId: number,
): { deployment: DeploymentFile | null; error: string | null } {
  if (raw == null) return { deployment: null, error: null };
  if (typeof raw !== "object") return { deployment: null, error: "deployment JSON is not an object" };
  const r = raw as Record<string, unknown>;
  const chainId = num(r.chainId);
  if (chainId !== null && chainId !== expectedChainId) {
    return {
      deployment: null,
      error: `deployments/${expectedChainId}.json says chainId ${chainId}`,
    };
  }
  const clearinghouse = addr(r.clearinghouse);
  if (!clearinghouse) return { deployment: null, error: "deployment JSON has no valid clearinghouse address" };
  const markets = bytes32Map(r.markets);
  // `pyth` may be an address or { address, feeds | feedIds }.
  const pythObj = r.pyth && typeof r.pyth === "object" ? (r.pyth as Record<string, unknown>) : null;
  const pythFeeds = {
    ...bytes32Map(pythObj?.feeds ?? pythObj?.feedIds),
    ...bytes32Map(r.pythFeeds ?? r.pythFeedIds ?? r.priceFeeds ?? r.feedIds ?? r.feeds),
  };
  return {
    deployment: {
      chainId: chainId ?? expectedChainId,
      clearinghouse,
      ausd: addr(r.ausd),
      oracle: addr(r.oracle),
      deployBlock: num(r.deployBlock),
      markets,
      production: r.production === true,
      pyth: addr(r.realPyth) ?? addr(pythObj ? pythObj.address : r.pyth),
      fallbackOracle: addr(r.fallbackOracle),
      pythFeeds,
      timelock: addr(r.timelock),
      guardian: addr(r.guardian),
    },
    error: null,
  };
}

function marketMap(overrides: Partial<Record<string, Hex>> = {}): Record<MarketSymbol, Hex> {
  const out = {} as Record<MarketSymbol, Hex>;
  for (const s of MARKETS) out[s] = overrides[s] ?? marketIdOf(s);
  return out;
}

/** App markets named by a deployment's `markets` keys (unknown keys are ignored: the app has no metadata for them). */
export function marketsNamed(markets: Partial<Record<string, Hex>>): MarketSymbol[] {
  return MARKETS.filter((s) => markets[s] !== undefined);
}

/** Deployment JSON first, env second. Null when neither names a clearinghouse. */
export function resolveContracts(deployment: DeploymentFile | null): ResolvedContracts | null {
  if (deployment) {
    return {
      clearinghouse: deployment.clearinghouse,
      ausd: deployment.ausd ?? CONTRACTS.ausd,
      oracle: deployment.oracle ?? CONTRACTS.oracle,
      deployBlock: deployment.deployBlock,
      markets: marketMap(deployment.markets),
      // Production lists only what the file names (empty → runtime reads getMarkets()).
      // The demo stacks always list all three.
      listed: deployment.production ? marketsNamed(deployment.markets) : [...MARKETS],
      source: "deployments",
      production: deployment.production,
      pyth: deployment.pyth,
      fallbackOracle: deployment.fallbackOracle,
      pythFeeds: feedMap(deployment.pythFeeds),
      timelock: deployment.timelock,
      guardian: deployment.guardian,
    };
  }
  if (CONTRACTS.clearinghouse) {
    return {
      clearinghouse: CONTRACTS.clearinghouse,
      ausd: CONTRACTS.ausd,
      oracle: CONTRACTS.oracle,
      deployBlock: null,
      markets: marketMap(),
      listed: [...MARKETS],
      source: "env",
      production: false,
      pyth: null,
      fallbackOracle: null,
      pythFeeds: {},
      timelock: null,
      guardian: null,
    };
  }
  return null;
}

/** Last resort: the keeper's /health `addresses` object. */
export function contractsFromKeeper(addresses: unknown): ResolvedContracts | null {
  if (!addresses || typeof addresses !== "object") return null;
  const a = addresses as Record<string, unknown>;
  const clearinghouse = addr(a.clearinghouse);
  if (!clearinghouse) return null;
  const markets =
    a.markets && typeof a.markets === "object" ? (a.markets as Partial<Record<string, Hex>>) : {};
  return {
    clearinghouse,
    ausd: addr(a.ausd),
    oracle: addr(a.oracle),
    deployBlock: num(a.deployBlock),
    markets: marketMap(
      Object.fromEntries(
        Object.entries(markets).filter(([, v]) => typeof v === "string" && isHex(v) && v.length === 66),
      ),
    ),
    listed: [...MARKETS],
    source: "keeper",
    // Never production: production addresses come only from the deployment file.
    production: false,
    pyth: null,
    fallbackOracle: null,
    pythFeeds: {},
    timelock: null,
    guardian: null,
  };
}
