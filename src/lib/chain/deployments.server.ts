// Server-only: reads `deployments/<chainId>.json` from the project root
// (or from PARACLR_DEPLOYMENTS_DIR).
// Import this ONLY from Server Components (src/app/app/page.tsx). It uses node:fs,
// so pulling it into a client bundle fails loudly at build time.
//
// The file is optional: when it is missing (deploy not run yet) we return null
// and the client falls back to NEXT_PUBLIC_*_ADDRESS env / the keeper. Callers
// opt into request-time rendering (`connection()`) so `next start` picks up a
// fresh deployment without a rebuild.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface DeploymentLoad {
  chainId: number;
  /** Parsed JSON, unvalidated (the client validates with parseDeployment). */
  raw: unknown;
  /** Why the file couldn't be used, if it exists but is broken. */
  error: string | null;
}

export async function readDeploymentJson(chainId: number): Promise<DeploymentLoad> {
  // PARACLR_DEPLOYMENTS_DIR (server-only, read at request time) points the app
  // at a rehearsal's output dir (e.g. a mainnet-fork rehearsal) without
  // touching deployments/143.json.
  const dir = process.env.PARACLR_DEPLOYMENTS_DIR || join(process.cwd(), "deployments");
  const file = join(dir, `${chainId}.json`);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { chainId, raw: null, error: null }; // not deployed yet: not an error
  }
  try {
    return { chainId, raw: JSON.parse(text) as unknown, error: null };
  } catch {
    return { chainId, raw: null, error: `deployments/${chainId}.json is not valid JSON` };
  }
}
