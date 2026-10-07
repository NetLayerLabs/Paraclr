// Client for the keeper service (keeper/, owned by the chain agent). Types
// follow the interface contract in docs/ONCHAIN_PLAN.md exactly; responses are
// validated loosely so a keeper version skew degrades instead of crashing.

import { NETWORK } from "./config";

export interface TxTiming {
  txHash: `0x${string}`;
  block: number | null;
  submittedAt: number; // ms epoch, measured by keeper
  confirmedAt: number | null;
}

export interface RunBatch extends TxTiming {
  lane: number;
  keeper: `0x${string}`;
  accounts: number;
  liquidated: number;
  gasUsed: string;
  gasLimit: string;
  /** Sweeper step when the keeper reports it (e.g. "startAuctions", "backstopTakeBatch"). */
  kind?: string;
}

export interface RunLiquidation {
  lane: number;
  account: `0x${string}`;
  equity: string;
  badDebt: string;
  txHash: `0x${string}`;
  logIndex: number;
}

export type AuctionOutcome = "backstop" | "external" | "cured" | "expired";

/** Crash run v2 (docs/FAIR_LIQUIDATION_PLAN.md): every amount is a raw 6dp string. */
export interface RunAuctions {
  started: number;
  takenByBackstop: number;
  takenExternal: number;
  cured: number;
  expired: number;
  avgDiscountBps: number;
  traderResidualReturned: string;
  backstopPaid: string;
  badDebt: string;
  /** What the old fixed-penalty liquidation path would have taken from the same traders. */
  legacyCounterfactual: { traderLoss: string };
  /**
   * Σ max(0, equity at AuctionStarted) over taken + expired accounts. Trader loss
   * to the auctions = traderEquityAtStart − traderResidualReturned.
   */
  traderEquityAtStart?: string;
  /** Present when external takes in this run came from keeper-run demo bots. */
  externalTakers?: { demo: boolean; accounts: `0x${string}`[]; reservationBps: [number, number] | null };
}

export interface RunUnderwater {
  maxBlocks: number;
  p50Blocks: number;
  p95Blocks: number;
  /** Keeper-measured wall-clock of the longest time underwater. */
  maxMs: number;
  perAccount: Array<{ account: `0x${string}`; lane: number; fromBlock: number; toBlock: number; outcome: AuctionOutcome }>;
}

export interface RunReport {
  runId: string;
  status: "running" | "done" | "failed";
  error?: string;
  chainId: number;
  network: "anvil" | "monad-testnet";
  shock: TxTiming & { bps: number };
  batches: RunBatch[];
  liquidations: RunLiquidation[];
  totals: {
    accountsScanned: number;
    liquidated: number;
    badDebt: string; // AUSD 6dp, decimal string
    wallClockMs: number; // first batch submitted → last batch receipt
    blocks: number[]; // distinct blocks the batches landed in
    sameBlock: boolean;
    totalGasUsed: string;
  };
  /** Present on crash runs v2 (auction liquidations). */
  auctions?: RunAuctions;
  underwater?: RunUnderwater;
  /** Set once the Conflict X-ray for this run exists (`GET /runs/:id/xray`). */
  xrayId?: string;
  /** Set when the keeper could not produce the X-ray (the crash itself still counts). */
  xrayError?: string;
  /** "auctions" (crash run v2) or "legacy" (one liquidateBatch per lane). */
  mode?: "auctions" | "legacy";
}

export interface XrayTx {
  hash: `0x${string}`;
  lane: number | null;
  block: number;
  index: number;
  kind: string;
  reads: number;
  writes: number;
}

export interface XrayEdge {
  from: `0x${string}`;
  to: `0x${string}`;
  slots: string[];
}

export interface XrayDesign {
  design: "paraclr-lanes" | "naive-shared";
  contract: `0x${string}`;
  blocks: number[];
  txs: XrayTx[];
  edges: XrayEdge[];
  summary: {
    txs: number;
    edges: number;
    /** Edges between txs of different lanes: the lane design's claim is that this is 0. */
    crossLaneEdges: number;
    /** Edges between txs of the same lane (one lane's own storage, e.g. pool take then bot take). */
    sameLaneEdges: number;
    longestChain: number;
    independentTxs: number;
  };
}

/** Storage-conflict map of one crash run, for both designs. */
export interface XrayReport {
  runId: string;
  chainId: number;
  network: "anvil" | "monad-testnet";
  method: "debug_traceTransaction" | "anvil-fork-replay";
  forkedFrom?: { chainId: number; block: number };
  designs: XrayDesign[];
  exclusions: string[];
  /** Additive keeper fields (optional). */
  generatedAt?: string;
  /** "same-block": edges are only drawn between txs of the same block. */
  edgeScope?: string;
  /** Human label per "contract:slot" key that appears on an edge. */
  slotLabels?: Record<string, string>;
  notes?: string[];
}

/** Keeper-run demo taker accounts seen in run reports this session (lowercase). */
export const demoTakers = new Set<string>();

export interface KeeperHealth {
  chainId: number;
  mode?: string;
  block?: number;
  addresses?: Record<string, unknown>;
  prices?: unknown;
  crashed?: boolean;
  /** Production keeper (docs/PRODUCTION_PLAN.md): executes delayed orders with Pyth updates. */
  production?: boolean;
  paused?: boolean;
  caps?: unknown;
  priceSource?: string;
}

export interface FaucetResult {
  gasTxHash?: `0x${string}`;
  ausdTxHash?: `0x${string}`;
}

export class KeeperError extends Error {
  constructor(
    message: string,
    readonly kind: "unreachable" | "http" | "bad-response",
    readonly status?: number,
  ) {
    super(message);
    this.name = "KeeperError";
  }
}

export function keeperUrl(): string {
  return NETWORK?.keeperUrl ?? "http://127.0.0.1:8787";
}

async function call<T>(
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 8_000);
  let res: Response;
  try {
    res = await fetch(`${keeperUrl()}${path}`, {
      method: init.method ?? "GET",
      headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: ctrl.signal,
      cache: "no-store",
    });
  } catch {
    throw new KeeperError(
      `Keeper unreachable at ${keeperUrl()} — start it with \`npm run keeper\` (or set NEXT_PUBLIC_KEEPER_URL).`,
      "unreachable",
    );
  } finally {
    clearTimeout(timer);
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const msg =
      json && typeof json === "object" && typeof (json as { error?: unknown }).error === "string"
        ? (json as { error: string }).error
        : res.status === 429
          ? "Rate limited — try again in a bit."
          : `HTTP ${res.status}`;
    throw new KeeperError(`Keeper ${path.split("/")[1] ?? ""}: ${msg}`, "http", res.status);
  }
  if (json === null || typeof json !== "object") {
    throw new KeeperError(`Keeper returned an unexpected response for ${path}`, "bad-response");
  }
  return json as T;
}

function normalizeTiming(t: Partial<TxTiming> | undefined): TxTiming {
  return {
    txHash: (t?.txHash ?? "0x") as `0x${string}`,
    block: typeof t?.block === "number" ? t.block : null,
    submittedAt: typeof t?.submittedAt === "number" ? t.submittedAt : 0,
    confirmedAt: typeof t?.confirmedAt === "number" ? t.confirmedAt : null,
  };
}

/** Fill defaults so the UI can read any RunReport field without guards. */
export function normalizeReport(raw: unknown): RunReport {
  const r = (raw ?? {}) as Partial<RunReport> & Record<string, unknown>;
  const totals = (r.totals ?? {}) as Partial<RunReport["totals"]>;
  const shock = (r.shock ?? {}) as Partial<RunReport["shock"]>;
  return {
    runId: String(r.runId ?? ""),
    status: r.status === "done" || r.status === "failed" ? r.status : "running",
    error: typeof r.error === "string" ? r.error : undefined,
    chainId: typeof r.chainId === "number" ? r.chainId : (NETWORK?.chainId ?? 0),
    network:
      r.network === "monad-testnet" || r.network === "anvil"
        ? r.network
        : NETWORK?.reportNetwork === "monad-testnet"
          ? "monad-testnet"
          : "anvil",
    shock: { ...normalizeTiming(shock), bps: typeof shock.bps === "number" ? shock.bps : 8000 },
    batches: (Array.isArray(r.batches) ? r.batches : []).map((b) => ({
      ...normalizeTiming(b),
      lane: Number(b.lane ?? 0),
      keeper: (b.keeper ?? "0x") as `0x${string}`,
      accounts: Number(b.accounts ?? 0),
      liquidated: Number(b.liquidated ?? 0),
      gasUsed: String(b.gasUsed ?? "0"),
      gasLimit: String(b.gasLimit ?? "0"),
      kind: typeof b.kind === "string" ? b.kind : undefined,
    })),
    liquidations: (Array.isArray(r.liquidations) ? r.liquidations : []).map((l) => ({
      lane: Number(l.lane ?? 0),
      account: (l.account ?? "0x") as `0x${string}`,
      equity: String(l.equity ?? "0"),
      badDebt: String(l.badDebt ?? "0"),
      txHash: (l.txHash ?? "0x") as `0x${string}`,
      logIndex: Number(l.logIndex ?? 0),
    })),
    totals: {
      accountsScanned: Number(totals.accountsScanned ?? 0),
      liquidated: Number(totals.liquidated ?? 0),
      badDebt: String(totals.badDebt ?? "0"),
      wallClockMs: Number(totals.wallClockMs ?? 0),
      blocks: Array.isArray(totals.blocks) ? totals.blocks.map(Number) : [],
      sameBlock: Boolean(totals.sameBlock),
      totalGasUsed: String(totals.totalGasUsed ?? "0"),
    },
    auctions: normalizeAuctions(r.auctions),
    underwater: normalizeUnderwater(r.underwater),
    xrayId: typeof r.xrayId === "string" && r.xrayId ? r.xrayId : undefined,
    xrayError: typeof r.xrayError === "string" && r.xrayError ? r.xrayError : undefined,
    mode: r.mode === "legacy" ? "legacy" : r.mode === "auctions" ? "auctions" : undefined,
  };
}

const n0 = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v ?? 0) || 0);
const s0 = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "0");
const OUTCOMES: AuctionOutcome[] = ["backstop", "external", "cured", "expired"];

function normalizeAuctions(raw: unknown): RunAuctions | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const a = raw as Partial<RunAuctions>;
  return {
    started: n0(a.started),
    takenByBackstop: n0(a.takenByBackstop),
    takenExternal: n0(a.takenExternal),
    cured: n0(a.cured),
    expired: n0(a.expired),
    avgDiscountBps: n0(a.avgDiscountBps),
    traderResidualReturned: s0(a.traderResidualReturned),
    backstopPaid: s0(a.backstopPaid),
    badDebt: s0(a.badDebt),
    legacyCounterfactual: { traderLoss: s0(a.legacyCounterfactual?.traderLoss) },
    traderEquityAtStart: a.traderEquityAtStart !== undefined ? s0(a.traderEquityAtStart) : undefined,
    externalTakers: normalizeExternalTakers(a.externalTakers),
  };
}

function normalizeExternalTakers(raw: unknown): RunAuctions["externalTakers"] {
  if (!raw || typeof raw !== "object") return undefined;
  const x = raw as { demo?: unknown; accounts?: unknown; reservationBps?: unknown };
  const accounts = (Array.isArray(x.accounts) ? x.accounts : []).map((a) => String(a).toLowerCase() as `0x${string}`);
  if (x.demo) for (const a of accounts) demoTakers.add(a);
  const r = Array.isArray(x.reservationBps) && x.reservationBps.length === 2 ? x.reservationBps.map(Number) : null;
  return { demo: Boolean(x.demo), accounts, reservationBps: r ? [r[0], r[1]] : null };
}

function normalizeUnderwater(raw: unknown): RunUnderwater | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Partial<RunUnderwater>;
  return {
    maxBlocks: n0(u.maxBlocks),
    p50Blocks: n0(u.p50Blocks),
    p95Blocks: n0(u.p95Blocks),
    maxMs: n0(u.maxMs),
    perAccount: (Array.isArray(u.perAccount) ? u.perAccount : []).map((p) => ({
      account: String(p.account ?? "0x").toLowerCase() as `0x${string}`,
      lane: n0(p.lane),
      fromBlock: n0(p.fromBlock),
      toBlock: n0(p.toBlock),
      outcome: OUTCOMES.includes(p.outcome as AuctionOutcome) ? (p.outcome as AuctionOutcome) : "expired",
    })),
  };
}

/** Loose validation of an X-ray JSON (keeper endpoint or bench/xray file). Null if unusable. */
export function normalizeXray(raw: unknown): XrayReport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<XrayReport>;
  if (!Array.isArray(r.designs) || r.designs.length === 0) return null;
  const designs: XrayDesign[] = r.designs
    .filter((d): d is XrayDesign => !!d && typeof d === "object" && Array.isArray(d.txs))
    .map((d) => {
      const txs: XrayTx[] = d.txs.map((t) => ({
        hash: String(t.hash ?? "0x").toLowerCase() as `0x${string}`,
        lane: typeof t.lane === "number" ? t.lane : null,
        block: n0(t.block),
        index: n0(t.index),
        kind: typeof t.kind === "string" ? t.kind : "tx",
        reads: n0(t.reads),
        writes: n0(t.writes),
      }));
      const edges: XrayEdge[] = (Array.isArray(d.edges) ? d.edges : []).map((e) => ({
        from: String(e.from ?? "0x").toLowerCase() as `0x${string}`,
        to: String(e.to ?? "0x").toLowerCase() as `0x${string}`,
        slots: Array.isArray(e.slots) ? e.slots.map(String) : [],
      }));
      const sum = (d.summary ?? {}) as Partial<XrayDesign["summary"]>;
      // Older X-ray files lack the cross/same-lane split; derive it from the tx lanes.
      const laneOf = new Map(txs.map((t) => [t.hash, t.lane]));
      const derivedCross = edges.filter((e) => {
        const a = laneOf.get(e.from);
        const b = laneOf.get(e.to);
        return a == null || b == null || a !== b;
      }).length;
      const crossLaneEdges = typeof sum.crossLaneEdges === "number" ? sum.crossLaneEdges : derivedCross;
      return {
        design: d.design === "naive-shared" ? "naive-shared" : "paraclr-lanes",
        contract: (d.contract ?? "0x") as `0x${string}`,
        blocks: Array.isArray(d.blocks) ? d.blocks.map(Number) : [...new Set(txs.map((t) => t.block))],
        txs,
        edges,
        summary: {
          txs: sum.txs ?? txs.length,
          edges: sum.edges ?? edges.length,
          crossLaneEdges,
          sameLaneEdges:
            typeof sum.sameLaneEdges === "number" ? sum.sameLaneEdges : (sum.edges ?? edges.length) - crossLaneEdges,
          longestChain: n0(sum.longestChain),
          independentTxs: n0(sum.independentTxs),
        },
      };
    });
  if (designs.length === 0) return null;
  return {
    runId: String(r.runId ?? ""),
    chainId: n0(r.chainId),
    network: r.network === "monad-testnet" ? "monad-testnet" : "anvil",
    method: r.method === "anvil-fork-replay" ? "anvil-fork-replay" : "debug_traceTransaction",
    forkedFrom:
      r.forkedFrom && typeof r.forkedFrom === "object"
        ? { chainId: n0(r.forkedFrom.chainId), block: n0(r.forkedFrom.block) }
        : undefined,
    designs,
    exclusions: Array.isArray(r.exclusions) ? r.exclusions.map(String) : [],
    generatedAt: typeof r.generatedAt === "string" ? r.generatedAt : undefined,
    edgeScope: typeof r.edgeScope === "string" ? r.edgeScope : undefined,
    slotLabels:
      r.slotLabels && typeof r.slotLabels === "object"
        ? Object.fromEntries(
            Object.entries(r.slotLabels as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), String(v)]),
          )
        : undefined,
    notes: Array.isArray(r.notes) ? r.notes.map(String) : undefined,
  };
}

export const keeperApi = {
  health: () => call<KeeperHealth>("/health", { timeoutMs: 4_000 }),
  faucet: (address: string) =>
    call<FaucetResult>("/faucet", { method: "POST", body: { address }, timeoutMs: 30_000 }),
  crash: (bps = 8000) => call<{ runId: string }>("/crash", { method: "POST", body: { bps }, timeoutMs: 15_000 }),
  run: async (runId: string) => normalizeReport(await call<unknown>(`/runs/${encodeURIComponent(runId)}`)),
  recover: () => call<{ txHash?: `0x${string}` }>("/recover", { method: "POST", body: {}, timeoutMs: 30_000 }),
  /** Recent runs, newest last (keeper memory only). */
  runs: async () => {
    const r = await call<unknown>("/runs");
    return (Array.isArray(r) ? r : []).map((x) => ({
      runId: String((x as { runId?: unknown }).runId ?? ""),
      status: String((x as { status?: unknown }).status ?? ""),
    }));
  },
  /** Conflict X-ray of a run; null while it is still being computed (404/202). */
  xray: async (runId: string): Promise<XrayReport | null> => {
    try {
      const raw = await call<unknown>(`/runs/${encodeURIComponent(runId)}/xray`, { timeoutMs: 15_000 });
      return normalizeXray(raw);
    } catch (e) {
      if (e instanceof KeeperError && e.kind === "http" && (e.status === 404 || e.status === 202 || e.status === 409)) {
        return null;
      }
      throw e;
    }
  },
};
