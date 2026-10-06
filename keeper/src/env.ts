// Environment + path helpers shared by the keeper, the bench and the deploy scripts.
//
// Secrets live only in gitignored env files (keeper/.env). Nothing here ever prints a key.

import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { join, resolve } from "node:path";

/** Repository root (keeper/src/env.ts → ../..). */
export const REPO_ROOT = resolve(__dirname, "..", "..");
export const KEEPER_ENV_FILE = join(REPO_ROOT, "keeper", ".env");
/** Optional overrides for local anvil runs (`dev:chain`, `deploy:anvil`); keeper/.env is ignored there. */
export const KEEPER_ANVIL_ENV_FILE = join(REPO_ROOT, "keeper", ".env.anvil");
export const DEPLOYMENTS_DIR = join(REPO_ROOT, "deployments");
export const CONTRACTS_DIR = join(REPO_ROOT, "contracts");

let loaded = false;

/**
 * Load keeper/.env into process.env (values already set in the shell win).
 * Missing file is fine: on anvil every variable has a zero-config default.
 */
export function loadKeeperEnv(file = process.env.KEEPER_ENV_FILE || KEEPER_ENV_FILE): string | null {
  if (loaded) return existsSync(file) ? file : null;
  loaded = true;
  if (!existsSync(file)) return null;
  loadEnvFile(file);
  return file;
}

export function envStr(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

export function envInt(name: string, fallback: number): number {
  const v = envStr(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return Math.floor(n);
}

export function envBigInt(name: string, fallback: bigint): bigint {
  const v = envStr(name);
  if (v === undefined) return fallback;
  try {
    return BigInt(v);
  } catch {
    throw new Error(`${name} must be an integer (wei), got "${v}"`);
  }
}

/** Parse `--flag value` / `--flag=value` / `--flag` style CLI args. */
export function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[++i];
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

/** Host part of an RPC URL, so logs/reports never leak an API key embedded in the path/query. */
export function rpcHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
