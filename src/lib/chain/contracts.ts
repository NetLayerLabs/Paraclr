// Contract addresses from env — the FALLBACK when `deployments/<chainId>.json`
// is missing (see deployments.ts for precedence). Literal
// `process.env.NEXT_PUBLIC_*` access so Next inlines them at build time
// (dynamic lookups are NOT inlined). Missing/invalid → null.

import { isAddress, type Address } from "viem";

function parseAddress(value: string | undefined): Address | null {
  return value && isAddress(value) ? value : null;
}

export const CONTRACTS = {
  clearinghouse: parseAddress(process.env.NEXT_PUBLIC_CLEARINGHOUSE_ADDRESS),
  ausd: parseAddress(process.env.NEXT_PUBLIC_AUSD_ADDRESS),
  oracle: parseAddress(process.env.NEXT_PUBLIC_ORACLE_ADDRESS),
} as const;

/** True when both core contracts are configured via env. */
export const CONTRACTS_CONFIGURED = CONTRACTS.clearinghouse !== null && CONTRACTS.ausd !== null;

/** AUSD uses 6 decimals (Agora AUSD). Assumption for the testnet mock too. */
export const AUSD_DECIMALS = 6;
