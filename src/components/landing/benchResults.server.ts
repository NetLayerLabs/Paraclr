// Server-only: reads the committed evidence for the landing page:
//   bench/results/*.json   RunReport (v1: liquidateBatch crash; v2 adds auctions + underwater)
//   bench/xray/*.json      XrayReport (Conflict X-ray: lanes vs naive shared state)
//   deployments/10143.json Monad testnet addresses
//   contracts/test/*.sol   test counts (declared test / invariant functions)
// Uses node:fs, so import it only from Server Components (src/app/page.tsx).
//
// The landing page has no request-time APIs, so this runs at build time
// (`next build`) and on every request in `next dev`. A new
// bench/results/10143-*.json or bench/xray/10143-*.json shows up on the next
// build with no code change.
//
// Never invent numbers here: everything returned is copied or derived
// (counting, division) from a committed file. Malformed or unfinished runs are
// skipped rather than guessed at.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const MONAD_TESTNET_CHAIN_ID = 10143;
export const ANVIL_CHAIN_ID = 31337;

export interface LaneBatch {
  lane: number;
  accounts: number;
  liquidated: number;
  gasUsed: number;
  block: number | null;
  txHash: string;
}

export type AuctionOutcome = "backstop" | "external" | "cured" | "expired";

/** RunReport v2 `auctions` block. AUSD amounts are converted from raw 6dp strings. */
export interface AuctionStats {
  started: number;
  takenByBackstop: number;
  takenExternal: number;
  cured: number;
  expired: number;
  avgDiscountBps: number | null;
  /** AUSD (not raw). */
  traderResidualReturned: number | null;
  backstopPaid: number | null;
  badDebt: number | null;
  /** What the old fixed-penalty liquidation path would have taken from traders (keeper-computed). */
  legacyTraderLoss: number | null;
  /** traderEquityAtStart − traderResidualReturned: what the auction took, comparable with legacyTraderLoss. */
  auctionTraderLoss: number | null;
  /** External takes were made by keeper-run demo bots (`auctions.externalTakers.demo`). */
  externalTakersDemo: boolean;
}

/** RunReport v2 `underwater` block. */
export interface UnderwaterStats {
  maxBlocks: number | null;
  p50Blocks: number | null;
  p95Blocks: number | null;
  maxMs: number | null;
  /** Counted from `perAccount`, per lane (index 0..7) and outcome. */
  perLane: Array<Record<AuctionOutcome, number>>;
  accounts: number;
}

export interface BenchRun {
  file: string;
  runId: string | null;
  chainId: number;
  /** "anvil" | "monad-testnet" (as written by the keeper). */
  network: string;
  /** Free-text label from the bench CLI, e.g. "local anvil (NOT Monad)". */
  measuredOn: string | null;
  startedAt: string | null;
  /** RPC client, e.g. "anvil/v1.7.1". */
  clientVersion: string | null;
  accountsScanned: number;
  accountsSeeded: number | null;
  seedTxCount: number | null;
  /** v1: accounts closed by liquidateBatch. v2 runs may not report it. */
  liquidated: number | null;
  batchCount: number;
  blocks: number[];
  sameBlock: boolean;
  totalGasUsed: number;
  gasPerLiquidation: number | null;
  wallClockMs: number;
  shockBps: number | null;
  shockTxHash: string | null;
  lanes: LaneBatch[];
  /** RunReport v2 only. */
  auctions: AuctionStats | null;
  underwater: UnderwaterStats | null;
  xrayId: string | null;
}

export interface XrayTx {
  hash: string;
  lane: number | null;
  block: number;
  index: number;
  kind: string;
  reads: number;
  writes: number;
}

export interface XrayDesign {
  design: string;
  contract: string;
  blocks: number[];
  /** Sorted by (lane, block, index); lane null last. */
  txs: XrayTx[];
  /** Indices into `txs`. `slots` is the number of shared slots on the edge. */
  edges: Array<{ from: number; to: number; slots: number; crossLane: boolean; sameBlock: boolean }>;
  summary: { txs: number; edges: number; longestChain: number | null; independentTxs: number | null };
  /** Derived by counting `edges`. */
  crossLaneEdges: number;
  sameBlockEdges: number;
  /** Slots that appear on the most edges (counted), with the keeper's label when it has one. */
  hotSlots: Array<{ slot: string; label: string | null; edges: number }>;
}

export interface XrayEvidence {
  file: string;
  runId: string;
  chainId: number;
  network: string;
  method: string;
  forkedFrom: { chainId: number; block: number } | null;
  lanes: XrayDesign | null;
  naive: XrayDesign | null;
  exclusions: string[];
  /** "same-block" when the keeper only draws edges inside one block. */
  edgeScope: string | null;
}

export interface RepoFacts {
  /** Declared `function test…` in contracts/test (not a pass count). */
  foundryTests: number | null;
  /** Declared `function invariant_…` in contracts/test. */
  invariantTests: number | null;
}

export interface LandingEvidence {
  anvilRuns: BenchRun[];
  monadRuns: BenchRun[];
  /** Largest run, preferring runs with auction data (v2); latest wins ties. */
  anvilHeadline: BenchRun | null;
  monadHeadline: BenchRun | null;
  /** Monad testnet X-ray if one exists, else the latest anvil one, else null. */
  xray: XrayEvidence | null;
  /** deployments/10143.json exists and has a clearinghouse address. */
  monadDeployment: {
    clearinghouse: string;
    naive: string | null;
    ausd: string | null;
    oracle: string | null;
  } | null;
  repo: RepoFacts;
}

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
/** Raw 6-decimal AUSD integer string (or number) → AUSD. */
const ausd = (v: unknown): number | null => {
  if (typeof v === "string" && /^-?\d+$/.test(v)) return Number(v) / 1e6;
  if (typeof v === "number" && Number.isFinite(v)) return v / 1e6;
  return null;
};

const OUTCOMES: AuctionOutcome[] = ["backstop", "external", "cured", "expired"];

function parseAuctions(raw: unknown): AuctionStats | null {
  if (!isObj(raw)) return null;
  const started = num(raw.started);
  if (started === null) return null;
  const legacy = isObj(raw.legacyCounterfactual) ? raw.legacyCounterfactual : null;
  const equityAtStart = ausd(raw.traderEquityAtStart);
  const returned = ausd(raw.traderResidualReturned);
  return {
    started,
    takenByBackstop: num(raw.takenByBackstop) ?? 0,
    takenExternal: num(raw.takenExternal) ?? 0,
    cured: num(raw.cured) ?? 0,
    expired: num(raw.expired) ?? 0,
    avgDiscountBps: num(raw.avgDiscountBps),
    traderResidualReturned: returned,
    backstopPaid: ausd(raw.backstopPaid),
    badDebt: ausd(raw.badDebt),
    legacyTraderLoss: legacy ? ausd(legacy.traderLoss) : null,
    auctionTraderLoss: equityAtStart !== null && returned !== null ? equityAtStart - returned : null,
    externalTakersDemo: isObj(raw.externalTakers) && raw.externalTakers.demo === true,
  };
}

function parseUnderwater(raw: unknown): UnderwaterStats | null {
  if (!isObj(raw)) return null;
  const perLane = Array.from({ length: 8 }, () => ({ backstop: 0, external: 0, cured: 0, expired: 0 }));
  let accounts = 0;
  if (Array.isArray(raw.perAccount)) {
    for (const a of raw.perAccount) {
      if (!isObj(a)) continue;
      const lane = num(a.lane);
      const outcome = a.outcome as AuctionOutcome;
      if (lane === null || lane < 0 || lane > 7 || !OUTCOMES.includes(outcome)) continue;
      perLane[lane][outcome] += 1;
      accounts += 1;
    }
  }
  const out: UnderwaterStats = {
    maxBlocks: num(raw.maxBlocks),
    p50Blocks: num(raw.p50Blocks),
    p95Blocks: num(raw.p95Blocks),
    maxMs: num(raw.maxMs),
    perLane,
    accounts,
  };
  return out.maxBlocks === null && accounts === 0 ? null : out;
}

function parseRun(file: string, raw: unknown): BenchRun | null {
  if (!isObj(raw) || raw.status !== "done") return null;
  const totals = raw.totals;
  if (!isObj(totals)) return null;
  const chainId = num(raw.chainId);
  const accountsScanned = num(totals.accountsScanned);
  const liquidated = num(totals.liquidated);
  const totalGasUsed = num(totals.totalGasUsed);
  const wallClockMs = num(totals.wallClockMs);
  if (chainId === null || accountsScanned === null || totalGasUsed === null || wallClockMs === null) {
    return null;
  }
  const auctions = parseAuctions(raw.auctions);
  // A v1 run without a liquidation count is malformed; v2 runs may omit it.
  if (liquidated === null && !auctions) return null;

  const blocks = Array.isArray(totals.blocks) ? totals.blocks.map(num).filter((b): b is number => b !== null) : [];
  const batches = Array.isArray(raw.batches) ? raw.batches.filter(isObj) : [];
  const lanes: LaneBatch[] = batches
    .map((b) => ({
      lane: num(b.lane) ?? -1,
      accounts: num(b.accounts) ?? 0,
      liquidated: num(b.liquidated) ?? 0,
      gasUsed: num(b.gasUsed) ?? 0,
      block: num(b.block),
      txHash: str(b.txHash) ?? "",
    }))
    .filter((b) => b.lane >= 0)
    .sort((a, b) => a.lane - b.lane);

  const bench = isObj(raw.bench) ? raw.bench : null;
  const shock = isObj(raw.shock) ? raw.shock : null;

  return {
    file,
    runId: str(raw.runId),
    chainId,
    network: str(raw.network) ?? "unknown",
    measuredOn: bench ? str(bench.measuredOn) : null,
    startedAt: bench ? str(bench.startedAt) : null,
    clientVersion: bench ? str(bench.clientVersion) : null,
    accountsScanned,
    accountsSeeded: bench ? num(bench.accountsSeeded) : null,
    seedTxCount: bench && Array.isArray(bench.seedTxs) ? bench.seedTxs.length : null,
    liquidated,
    batchCount: batches.length,
    blocks,
    sameBlock: totals.sameBlock === true,
    totalGasUsed,
    gasPerLiquidation: liquidated ? Math.round(totalGasUsed / liquidated) : null,
    wallClockMs,
    shockBps: shock ? num(shock.bps) : null,
    shockTxHash: shock ? str(shock.txHash) : null,
    lanes,
    auctions,
    underwater: parseUnderwater(raw.underwater),
    xrayId: str(raw.xrayId),
  };
}

function parseDesign(raw: unknown, labels: Record<string, string>): XrayDesign | null {
  if (!isObj(raw) || !Array.isArray(raw.txs)) return null;
  const txs: XrayTx[] = raw.txs
    .filter(isObj)
    .map((t) => ({
      hash: str(t.hash) ?? "",
      lane: num(t.lane),
      block: num(t.block) ?? 0,
      index: num(t.index) ?? 0,
      kind: str(t.kind) ?? "tx",
      reads: num(t.reads) ?? 0,
      writes: num(t.writes) ?? 0,
    }))
    .filter((t) => t.hash)
    .sort((a, b) => (a.lane ?? 99) - (b.lane ?? 99) || a.block - b.block || a.index - b.index);
  if (txs.length === 0) return null;
  const pos = new Map(txs.map((t, i) => [t.hash.toLowerCase(), i]));
  const edges: XrayDesign["edges"] = [];
  const slotCount = new Map<string, number>();
  for (const e of Array.isArray(raw.edges) ? raw.edges.filter(isObj) : []) {
    const from = pos.get(String(e.from).toLowerCase());
    const to = pos.get(String(e.to).toLowerCase());
    if (from === undefined || to === undefined) continue;
    const a = txs[from];
    const b = txs[to];
    for (const s of Array.isArray(e.slots) ? e.slots : []) {
      if (typeof s === "string") slotCount.set(s, (slotCount.get(s) ?? 0) + 1);
    }
    edges.push({
      from,
      to,
      slots: Array.isArray(e.slots) ? e.slots.length : 0,
      crossLane: a.lane !== null && b.lane !== null && a.lane !== b.lane,
      sameBlock: a.block === b.block,
    });
  }
  const summary = isObj(raw.summary) ? raw.summary : {};
  return {
    design: str(raw.design) ?? "unknown",
    contract: str(raw.contract) ?? "",
    blocks: Array.isArray(raw.blocks) ? raw.blocks.map(num).filter((b): b is number => b !== null) : [],
    txs,
    edges,
    summary: {
      txs: num(summary.txs) ?? txs.length,
      edges: num(summary.edges) ?? edges.length,
      longestChain: num(summary.longestChain),
      independentTxs: num(summary.independentTxs),
    },
    crossLaneEdges: edges.filter((e) => e.crossLane).length,
    sameBlockEdges: edges.filter((e) => e.sameBlock).length,
    hotSlots: [...slotCount.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 3)
      .map(([slot, n]) => ({ slot, label: labels[slot] ?? labels[slot.toLowerCase()] ?? null, edges: n })),
  };
}

function parseXray(file: string, raw: unknown): XrayEvidence | null {
  if (!isObj(raw) || !Array.isArray(raw.designs)) return null;
  const chainId = num(raw.chainId);
  if (chainId === null) return null;
  const labels: Record<string, string> = {};
  if (isObj(raw.slotLabels)) {
    for (const [k, v] of Object.entries(raw.slotLabels)) if (typeof v === "string") labels[k] = v;
  }
  const designs = raw.designs.map((d) => parseDesign(d, labels)).filter((d): d is XrayDesign => d !== null);
  const lanes = designs.find((d) => d.design === "paraclr-lanes") ?? null;
  const naive = designs.find((d) => d.design === "naive-shared") ?? null;
  if (!lanes && !naive) return null;
  const fork = isObj(raw.forkedFrom) ? raw.forkedFrom : null;
  const forkChain = fork ? num(fork.chainId) : null;
  const forkBlock = fork ? num(fork.block) : null;
  return {
    file,
    runId: str(raw.runId) ?? file.replace(/\.json$/, ""),
    chainId,
    network: str(raw.network) ?? (chainId === MONAD_TESTNET_CHAIN_ID ? "monad-testnet" : "anvil"),
    method: str(raw.method) ?? "unknown",
    forkedFrom: forkChain !== null && forkBlock !== null ? { chainId: forkChain, block: forkBlock } : null,
    lanes,
    naive,
    exclusions: Array.isArray(raw.exclusions) ? raw.exclusions.map(str).filter((s): s is string => s !== null) : [],
    edgeScope: str(raw.edgeScope),
  };
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function jsonFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => /^\d+-.+\.json$/.test(f)).sort();
  } catch {
    return [];
  }
}

function pickHeadline(runs: BenchRun[]): BenchRun | null {
  // Prefer runs that carry auction data; among those, the largest book, then the
  // most auctions started (the deepest shock), latest wins ties.
  const v2 = runs.filter((r) => r.auctions);
  const pool = v2.length ? v2 : runs;
  const score = (r: BenchRun) => [r.accountsScanned, r.auctions?.started ?? 0] as const;
  // runs are sorted oldest → newest (file names carry an ISO timestamp)
  return pool.reduce<BenchRun | null>((best, r) => {
    if (!best) return r;
    const [a1, a2] = score(r);
    const [b1, b2] = score(best);
    return a1 > b1 || (a1 === b1 && a2 >= b2) ? r : best;
  }, null);
}

async function loadRepoFacts(root: string): Promise<RepoFacts> {
  const dir = join(root, "contracts", "test");
  let files: string[];
  try {
    files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith(".t.sol"));
  } catch {
    return { foundryTests: null, invariantTests: null };
  }
  let tests = 0;
  let invariants = 0;
  for (const f of files) {
    let src = "";
    try {
      src = await readFile(join(dir, f), "utf8");
    } catch {
      continue;
    }
    tests += src.match(/\bfunction\s+test\w*\s*\(/g)?.length ?? 0;
    invariants += src.match(/\bfunction\s+invariant\w*\s*\(/g)?.length ?? 0;
  }
  return { foundryTests: tests || null, invariantTests: invariants || null };
}

export async function loadLandingEvidence(): Promise<LandingEvidence> {
  const root = process.cwd();

  const resultsDir = join(root, "bench", "results");
  const runs = (
    await Promise.all((await jsonFiles(resultsDir)).map(async (f) => parseRun(f, await readJson(join(resultsDir, f)))))
  ).filter((r): r is BenchRun => r !== null);
  const anvilRuns = runs.filter((r) => r.chainId === ANVIL_CHAIN_ID);
  const monadRuns = runs.filter((r) => r.chainId === MONAD_TESTNET_CHAIN_ID);

  const xrayDir = join(root, "bench", "xray");
  const xrays = (
    await Promise.all((await jsonFiles(xrayDir)).map(async (f) => parseXray(f, await readJson(join(xrayDir, f)))))
  ).filter((x): x is XrayEvidence => x !== null);
  // Run ids aren't time-ordered, so pair X-rays with bench runs: the newest run
  // whose xrayId / runId names an X-ray wins; otherwise the last file by name.
  // The headline run's X-ray comes first, so the hero and Results show the same crash.
  const pick = (chainId: number, chainRuns: BenchRun[]): XrayEvidence | null => {
    const mine = xrays.filter((x) => x.chainId === chainId);
    const headline = pickHeadline(chainRuns);
    const ordered = [...chainRuns].reverse();
    for (const r of headline ? [headline, ...ordered] : ordered) {
      const hit = mine.find((x) => (r.xrayId && x.runId === r.xrayId) || (r.runId && x.runId === r.runId));
      if (hit) return hit;
    }
    return mine.at(-1) ?? null;
  };
  const xray = pick(MONAD_TESTNET_CHAIN_ID, monadRuns) ?? pick(ANVIL_CHAIN_ID, anvilRuns);

  const dep = await readJson(join(root, "deployments", `${MONAD_TESTNET_CHAIN_ID}.json`));
  const monadDeployment =
    isObj(dep) && str(dep.clearinghouse)
      ? { clearinghouse: str(dep.clearinghouse)!, naive: str(dep.naive), ausd: str(dep.ausd), oracle: str(dep.oracle) }
      : null;

  return {
    anvilRuns,
    monadRuns,
    anvilHeadline: pickHeadline(anvilRuns),
    monadHeadline: pickHeadline(monadRuns),
    xray,
    monadDeployment,
    repo: await loadRepoFacts(root),
  };
}
