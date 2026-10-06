// Deployed contract addresses for the active chain.
//
// Precedence (docs/ONCHAIN_PLAN.md):
//   1. `deployments/<chainId>.json` written by the deploy flow — read on the
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
}

export interface ResolvedContracts {
  clearinghouse: Address;
  ausd: Address | null;
  oracle: Address | null;
  deployBlock: number | null;
  /** bytes32 market id per app market (`keccak256("MON/AUSD")` unless the deployment says otherwise). */
  markets: Record<MarketSymbol, Hex>;
  source: "deployments" | "env" | "keeper";
}

export function marketIdOf(symbol: string): Hex {
  return keccak256(toHex(symbol));
}

function addr(v: unknown): Address | null {
  return typeof v === "string" && isAddress(v) ? v : null;
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
  const markets: Partial<Record<string, Hex>> = {};
  if (r.markets && typeof r.markets === "object") {
    for (const [k, v] of Object.entries(r.markets as Record<string, unknown>)) {
      if (typeof v === "string" && isHex(v) && v.length === 66) markets[k] = v;
    }
  }
  return {
    deployment: {
      chainId: chainId ?? expectedChainId,
      clearinghouse,
      ausd: addr(r.ausd),
      oracle: addr(r.oracle),
      deployBlock: num(r.deployBlock),
      markets,
    },
    error: null,
  };
}

function marketMap(overrides: Partial<Record<string, Hex>> = {}): Record<MarketSymbol, Hex> {
  const out = {} as Record<MarketSymbol, Hex>;
  for (const s of MARKETS) out[s] = overrides[s] ?? marketIdOf(s);
  return out;
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
      source: "deployments",
    };
  }
  if (CONTRACTS.clearinghouse) {
    return {
      clearinghouse: CONTRACTS.clearinghouse,
      ausd: CONTRACTS.ausd,
      oracle: CONTRACTS.oracle,
      deployBlock: null,
      markets: marketMap(),
      source: "env",
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
    source: "keeper",
  };
}
