"use client";

// Polls the arena keeper (NEXT_PUBLIC_ARENA_KEEPER_URL). Every viewer polls the same state, so
// everyone watches the same run. Faster while a run is live.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ArenaView, RunReport, SolvencyJson, SweepTxJson, XrayReport } from "./types";

const DEFAULT_URL = "http://127.0.0.1:8791";

export function arenaKeeperUrl(): string {
  return (process.env.NEXT_PUBLIC_ARENA_KEEPER_URL || DEFAULT_URL).replace(/\/+$/, "");
}

const LIVE = new Set(["crashing", "resolving", "xray"]);

async function getJson<T>(path: string, signal?: AbortSignal): Promise<{ status: number; body: T }> {
  const res = await fetch(`${arenaKeeperUrl()}${path}`, { cache: "no-store", signal });
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}

export interface ArenaData {
  view: ArenaView | null;
  /** When `view` was fetched (client clock), for the local cooldown countdown. */
  fetchedAt: number;
  offline: boolean;
  sweeps: SweepTxJson[];
  report: RunReport | null;
  xray: XrayReport | null;
  xrayPending: boolean;
  solvency: Partial<Record<"paraclr" | "naive", SolvencyJson>>;
}

export function useArena() {
  const [data, setData] = useState<ArenaData>({
    view: null,
    fetchedAt: 0,
    offline: false,
    sweeps: [],
    report: null,
    xray: null,
    xrayPending: false,
    solvency: {},
  });
  const viewRef = useRef<ArenaView | null>(null);
  const reportFor = useRef<string | null>(null);
  const xrayFor = useRef<string | null>(null);
  const solvencyFor = useRef<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ctrl = new AbortController();

    const loop = async () => {
      let live = false;
      try {
        const { body: view } = await getJson<ArenaView>("/arena", ctrl.signal);
        if (stopped) return;
        if (!view || typeof view.state !== "string") throw new Error("bad /arena response");
        viewRef.current = view;
        live = LIVE.has(view.state);
        const next: Partial<ArenaData> = { view, fetchedAt: Date.now(), offline: false };

        // Tx feed: the sweeper's recent txs, while a run is live or its results are on screen.
        if (live || view.last) {
          const sw = await getJson<{ recent?: SweepTxJson[] }>("/sweeper", ctrl.signal).catch(() => null);
          if (sw && Array.isArray(sw.body.recent)) next.sweeps = sw.body.recent;
        }

        // RunReport + X-ray of the run on screen (current, else last).
        const runId = view.current?.runId ?? view.last?.runId ?? null;
        if (runId) {
          const done = view.last?.runId === runId && !view.current;
          if (reportFor.current !== runId || live || !done) {
            const r = await getJson<RunReport>(`/runs/${runId}`, ctrl.signal).catch(() => null);
            if (r && r.status === 200 && r.body?.runId === runId) {
              next.report = r.body;
              if (done && r.body.status !== "running") reportFor.current = runId;
            }
          }
          if (view.last?.runId === runId && view.last.xrayId && xrayFor.current !== runId) {
            const x = await getJson<XrayReport>(`/runs/${runId}/xray`, ctrl.signal).catch(() => null);
            if (x && x.status === 200 && Array.isArray(x.body?.designs)) {
              next.xray = { ...x.body, exclusions: Array.isArray(x.body.exclusions) ? x.body.exclusions : [] };
              next.xrayPending = false;
              xrayFor.current = runId;
            } else next.xrayPending = true;
          } else if (view.last?.runId === runId && !view.last.xrayId) {
            next.xray = null;
            next.xrayPending = false;
          } else if (view.current && view.state === "xray") {
            next.xrayPending = true;
            next.xray = null;
          } else if (view.current) {
            next.xray = null;
            next.xrayPending = false;
          }
          // Solvency of both designs once the run is over.
          if (done && solvencyFor.current !== runId) {
            const [p, n] = await Promise.all([
              getJson<SolvencyJson>("/solvency?design=paraclr", ctrl.signal).catch(() => null),
              getJson<SolvencyJson>("/solvency?design=naive", ctrl.signal).catch(() => null),
            ]);
            next.solvency = {
              ...(p?.status === 200 ? { paraclr: p.body } : {}),
              ...(n?.status === 200 ? { naive: n.body } : {}),
            };
            solvencyFor.current = runId;
          }
        }
        if (!stopped) setData((d) => ({ ...d, ...next }));
      } catch (err) {
        if (stopped || (err as Error)?.name === "AbortError") return;
        setData((d) => ({ ...d, offline: true }));
      }
      if (!stopped) timer = setTimeout(loop, live ? 400 : 1_200);
    };
    void loop();
    return () => {
      stopped = true;
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [tick]);

  return { ...data, refresh };
}

/** POST /arena/crash. Resolves with the runId or the keeper's refusal message. */
export async function postCrash(): Promise<{ ok: true; runId: string } | { ok: false; message: string; code: string }> {
  try {
    const res = await fetch(`${arenaKeeperUrl()}/arena/crash`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = (await res.json().catch(() => ({}))) as { runId?: string; error?: string; code?: string };
    if (res.status === 202 && body.runId) return { ok: true, runId: body.runId };
    return { ok: false, message: body.error ?? `The keeper answered ${res.status}.`, code: body.code ?? String(res.status) };
  } catch {
    return { ok: false, message: "The arena keeper is unreachable right now.", code: "offline" };
  }
}
