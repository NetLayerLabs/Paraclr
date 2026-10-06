// Synthetic cross-margin book for the clearing demo.
//
// Accounts are sharded into lanes by `hash(id) % THREAD_COUNT`, mirroring the
// on-chain design: each lane owns its own storage slots (accounts + insurance
// fund), so batches on different lanes touch disjoint state and Monad's
// optimistic parallel executor can run them without re-execution conflicts.

import { MARKETS, THREAD_COUNT } from "@/lib/types";
import type { ClearingAccount, MarketSymbol, Position } from "@/lib/types";
import { createRng, fnv1a } from "./rng";

export type MarkPrices = Record<MarketSymbol, number>;

/** Used when the live feed hasn't produced a tick yet. */
export const DEFAULT_REFERENCE_PRICES: MarkPrices = {
  "MON/AUSD": 3.5,
  "SOL/AUSD": 180,
  "BTC/AUSD": 98_000,
};

export const DEFAULT_SEED = 0x9a7ac1;
export const DEFAULT_ACCOUNT_COUNT = 500;
export const USER_ACCOUNT_PREFIX = "you:";

export function laneOf(id: string): number {
  return fnv1a(id) % THREAD_COUNT;
}

function pickSymbol(r: number): MarketSymbol {
  if (r < 0.45) return MARKETS[0]; // MON
  if (r < 0.75) return MARKETS[1]; // SOL
  return MARKETS[2]; // BTC
}

function hex(rand: () => number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += Math.floor(rand() * 16).toString(16);
  return s;
}

/**
 * Deterministically generate `count` cross-margin accounts around the given
 * reference prices. Leverage 2–20x (skewed low), ~60% long, AUSD collateral.
 */
export function generateAccounts(
  reference: MarkPrices,
  count = DEFAULT_ACCOUNT_COUNT,
  seed = DEFAULT_SEED,
): ClearingAccount[] {
  const rand = createRng(seed);
  const accounts: ClearingAccount[] = [];

  for (let i = 0; i < count; i++) {
    const id = `0x${hex(rand, 4)}…${hex(rand, 4)}#${i}`;
    const owner = `0x${hex(rand, 40)}`;
    const nPos = rand() < 0.55 ? 1 : rand() < 0.75 ? 2 : 3;
    const positions: Position[] = [];
    let posted = 0;

    for (let p = 0; p < nPos; p++) {
      const symbol = pickSymbol(rand());
      const side = rand() < 0.6 ? "long" : "short";
      const leverage = Math.round(2 + 18 * Math.pow(rand(), 2));
      const margin = Math.round(Math.pow(10, 1.8 + 2.4 * rand()));
      // Entries cluster near the reference; high-leverage entries are tighter
      // (anyone far underwater would already have been liquidated).
      const entryPrice = reference[symbol] * (1 + ((rand() - 0.5) * 0.12) / leverage);
      positions.push({
        id: `${id}/p${p}`,
        owner,
        symbol,
        side,
        size: (margin * leverage) / entryPrice,
        entryPrice,
        margin,
        leverage,
        openedAt: 0,
      });
      posted += margin;
    }

    // Cross-margin buffer: most traders run thin, a few are heavily over-collateralised.
    const buffer = 0.15 + Math.pow(rand(), 1.6) * 2.5;
    accounts.push({
      id,
      thread: laneOf(id),
      collateral: Math.round(posted * (1 + buffer)),
      positions,
      health: "healthy",
    });
  }
  return accounts;
}

/** Wrap the signed-in user's real positions as one more clearing account. */
export function userAccount(owner: string, positions: Position[]): ClearingAccount | null {
  if (positions.length === 0) return null;
  const id = `${USER_ACCOUNT_PREFIX}${owner}`;
  return {
    id,
    thread: laneOf(id),
    collateral: positions.reduce((sum, p) => sum + p.margin, 0),
    positions,
    health: "healthy",
  };
}

export function isUserAccount(id: string): boolean {
  return id.startsWith(USER_ACCOUNT_PREFIX);
}
