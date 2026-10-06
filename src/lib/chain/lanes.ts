// Lane-level reads for the Clearing screen's Live mode.

import type { Address } from "viem";
import { LANE_COUNT } from "../types";
import { paraclrClearinghouseAbi } from "./abi";
import { readMany } from "./clients";
import { ausdToNumber } from "./units";

export interface LaneStat {
  lane: number;
  insuranceFund: number; // AUSD
  badDebt: number; // AUSD
  totalLiquidations: number;
  lastSettledAt: number; // unix seconds
  accountCount: number;
}

const LANES = Array.from({ length: LANE_COUNT }, (_, i) => i);

export async function readLanes(clearinghouse: Address): Promise<LaneStat[]> {
  const res = await readMany({
    contracts: LANES.map((l) => ({
      address: clearinghouse,
      abi: paraclrClearinghouseAbi,
      functionName: "getLane" as const,
      args: [l] as const,
    })),
  });
  return res.map((r, lane) => {
    if (r.status !== "success") throw r.error;
    const [insuranceFund, badDebt, totalLiquidations, lastSettledAt, accountCount] = r.result as readonly [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ];
    return {
      lane,
      insuranceFund: ausdToNumber(insuranceFund),
      badDebt: ausdToNumber(badDebt),
      totalLiquidations: Number(totalLiquidations),
      lastSettledAt: Number(lastSettledAt),
      accountCount: Number(accountCount),
    };
  });
}

/** Every registered account per lane (paged by the per-lane count). */
export async function readLaneAccounts(clearinghouse: Address, counts: number[], cap = 2_000): Promise<string[][]> {
  const res = await readMany({
    contracts: LANES.map((l) => ({
      address: clearinghouse,
      abi: paraclrClearinghouseAbi,
      functionName: "getLaneAccounts" as const,
      args: [l, BigInt(0), BigInt(Math.min(cap, Math.max(1, counts[l] ?? 0)))] as const,
    })),
  });
  return res.map((r) => (r.status === "success" ? (r.result as readonly string[]).map((a) => a.toLowerCase()) : []));
}

/** Accounts liquidatable at the current oracle marks (view; may be slow on big lanes). */
export async function readLiquidatable(clearinghouse: Address, counts: number[], cap = 2_000): Promise<Set<string>> {
  const res = await readMany({
    contracts: LANES.map((l) => ({
      address: clearinghouse,
      abi: paraclrClearinghouseAbi,
      functionName: "getLiquidatableAccounts" as const,
      args: [l, BigInt(0), BigInt(Math.min(cap, Math.max(1, counts[l] ?? 0)))] as const,
    })),
  });
  const out = new Set<string>();
  for (const r of res) {
    if (r.status === "success") for (const a of r.result as readonly string[]) out.add(a.toLowerCase());
  }
  return out;
}
