"use client";

// Production backstop pool state for one lane (ParaclrClearinghouseProd v4):
//   - backstopDepositStatus(lane): pool deposits are refused while the lane owes
//     the pool a receivable, or while the pool's unrealised gain exceeds lane
//     insurance (its NAV is capped), or while the lane has bad debt;
//   - backstopWithdrawRequest(lane, lp): LP exits are two steps - request, wait
//     backstopWithdrawDelay, then withdraw ONCE inside the window;
//   - laneSolvency(lane): bad debt → a pro-rata haircut on payouts.

import { useEffect, useState } from "react";
import type { Address } from "viem";
import { useParaclr } from "../../store";
import { coalesce, subscribeBlocks } from "../clients";
import type { LiveContracts } from "../runtime";
import { ausdToNumber } from "../units";
import { prodAbi } from "./abi";
import { laneSolvencyOf, readLaneSolvencies, readLoose, signedNumber, tuple, type LaneSolvency } from "./state";

export interface PoolDepositStatus {
  open: boolean;
  /** Pool cash the lane still owes the pool (AUSD). */
  receivable: number;
  /** The pool's unrealised PnL before the insurance cap (AUSD). */
  unrealizedUncapped: number;
  insurance: number;
}

export interface WithdrawRequest {
  shares: bigint;
  /** Unix seconds. */
  readyAt: number;
  expiresAt: number;
}

export interface BackstopProd {
  depositStatus: PoolDepositStatus | null;
  /** Null when there is no live request (none, or from a retired epoch). */
  request: WithdrawRequest | null;
  solvency: LaneSolvency | null;
}

export async function readBackstopProd(c: LiveContracts, lane: number, lp: Address | null): Promise<BackstopProd> {
  const call = (functionName: string, args: readonly unknown[]) => ({
    address: c.clearinghouse,
    abi: prodAbi,
    functionName,
    args,
  });
  const res = await readLoose([
    call("backstopDepositStatus", [lane]),
    call("laneSolvency", [lane]),
    ...(lp ? [call("backstopWithdrawRequest", [lane, lp])] : []),
  ]);
  const st = tuple(res[0]);
  const rq = lp ? tuple(res[2]) : null;
  const shares = rq ? (rq[0] as bigint) : BigInt(0);
  return {
    depositStatus: st
      ? {
          open: Boolean(st[0]),
          receivable: ausdToNumber(st[1] as bigint),
          unrealizedUncapped: signedNumber(st[2] as bigint) / 1e6,
          insurance: ausdToNumber(st[3] as bigint),
        }
      : null,
    request: rq && shares > BigInt(0) ? { shares, readyAt: Number(rq[1]), expiresAt: Number(rq[2]) } : null,
    solvency: laneSolvencyOf(lane, res[1]),
  };
}

/** Why a pool deposit into this lane is refused right now, or null. */
export function poolDepositRefusal(b: BackstopProd | null): string | null {
  if (!b) return null;
  if ((b.solvency?.badDebt ?? 0) > 0) return "Pool deposits paused: this lane has bad debt";
  const st = b.depositStatus;
  if (!st || st.open) return null;
  if (st.receivable > 0) return "Pool deposits paused: the lane owes this pool";
  if (st.unrealizedUncapped > st.insurance) return "Pool deposits paused: pool gain above lane insurance";
  return "Pool deposits paused";
}

/** Per-block read of the production pool state for `lane` (null outside production). */
export function useBackstopProd(lane: number, active: boolean): { data: BackstopProd | null; refresh: () => void } {
  const production = useParaclr((s) => s.chain.status === "ready" && !!s.chain.contracts?.production);
  const contracts = useParaclr((s) => s.chain.contracts);
  const me = useParaclr((s) => (s.session?.address as Address | undefined) ?? null);
  // Keyed by lane + LP so switching lanes never shows the previous lane's state.
  const key = `${lane}:${me ?? ""}`;
  const [data, setData] = useState<{ key: string; d: BackstopProd } | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!production || !active || !contracts) return;
    let cancelled = false;
    const load = coalesce(async () => {
      try {
        const d = await readBackstopProd(contracts, lane, me);
        if (!cancelled) setData({ key: `${lane}:${me ?? ""}`, d });
      } catch {
        /* next block retries */
      }
    }, 1_500);
    const off = subscribeBlocks(() => load());
    return () => {
      cancelled = true;
      off();
    };
  }, [production, active, contracts, lane, me, nonce]);

  return { data: production && data?.key === key ? data.d : null, refresh: () => setNonce((n) => n + 1) };
}

/** Every lane's `laneSolvency`, re-read every block while `enabled` (the solvency dialog). */
export function useLaneSolvencies(enabled: boolean): LaneSolvency[] | null {
  const production = useParaclr((s) => s.chain.status === "ready" && !!s.chain.contracts?.production);
  const contracts = useParaclr((s) => s.chain.contracts);
  const [data, setData] = useState<LaneSolvency[] | null>(null);
  useEffect(() => {
    if (!production || !enabled || !contracts) return;
    let cancelled = false;
    const load = coalesce(async () => {
      try {
        const d = await readLaneSolvencies(contracts);
        if (!cancelled) setData(d);
      } catch {
        /* next block retries */
      }
    }, 1_500);
    const off = subscribeBlocks(() => load());
    return () => {
      cancelled = true;
      off();
    };
  }, [production, enabled, contracts]);
  return production ? data : null;
}
