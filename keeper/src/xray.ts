// Conflict X-ray: the measured storage read/write dependency graph of a crash's resolution phase,
// for the lane-sharded design and the deliberately naive shared-state design side by side.
//
// Method (docs/FAIR_LIQUIDATION_PLAN.md §Keeper additions):
//   - every resolution-phase tx is traced twice with debug_traceTransaction + prestateTracer:
//       diffMode:false → every account/slot the tx touched (read or written), with pre-values;
//       diffMode:true  → only what changed: pre (old values) / post (new values). A slot set to
//                        zero appears only in `pre`, a slot set from zero only in `post`, so the
//                        write set is keys(pre) ∪ keys(post). A no-op SSTORE (same value) is not a
//                        write: a later reader of that slot still reads the value it would have.
//   - access(tx) = every storage slot + account field in the non-diff prestate; write(tx) = every
//     storage slot + account field that changed in diff mode; both after EXCLUSIONS (below).
//   - edge i→j, for i before j in the SAME block (block order = transactionIndex), when
//     write(i) ∩ access(j) ≠ ∅, i.e. j read or wrote a slot i wrote. Different blocks are
//     ordered by consensus already; optimistic re-execution only happens inside a block.
//   - If the RPC has no usable debug_traceTransaction, the blocks are replayed on an anvil fork at
//     the parent block and traced there (xray-fork.ts) — labelled method "anvil-fork-replay".
//
// What this is NOT: it shows the read/write dependencies that would force Monad's optimistic
// executor to re-execute a tx. It does not observe Monad's actual re-execution counts.

import type { Address, Hex } from "viem";
import type { Client, Network } from "./network";

export type DesignName = "paraclr-lanes" | "naive-shared";
export type XrayMethod = "debug_traceTransaction" | "anvil-fork-replay";

export interface XrayTx {
  hash: `0x${string}`;
  lane: number | null;
  block: number;
  index: number;
  kind: string;
  /** Storage slots / account fields the tx read but did not modify (after exclusions). */
  reads: number;
  /** Storage slots / account fields the tx modified (after exclusions). */
  writes: number;
}

export interface XrayEdge {
  from: `0x${string}`;
  to: `0x${string}`;
  /** `<address>:<slot>` (or `<address>:balance|nonce|code`) written by `from`, then accessed by `to`. */
  slots: string[];
}

export interface XrayDesign {
  design: DesignName;
  contract: `0x${string}`;
  blocks: number[];
  txs: XrayTx[];
  edges: XrayEdge[];
  summary: {
    txs: number;
    edges: number;
    longestChain: number;
    independentTxs: number;
    /** Additive: edges between txs of different lanes (or with no lane) — the cross-lane conflicts. */
    crossLaneEdges: number;
    /** Additive: edges between txs of the same lane. */
    sameLaneEdges: number;
  };
}

export interface XrayReport {
  runId: string;
  chainId: number;
  network: Network;
  method: XrayMethod;
  forkedFrom?: { chainId: number; block: number };
  designs: XrayDesign[];
  exclusions: string[];
  // ---- additive (not in the plan's interface; consumers may ignore) ----
  generatedAt: string;
  /** Edges are only drawn between txs of the same block. */
  edgeScope: "same-block";
  /** Human labels for every slot that appears on an edge, when the storage layout was available. */
  slotLabels: Record<string, string>;
  /** Why a fallback was taken, replay mismatches, labeler availability, … */
  notes: string[];
}

/** One tx to trace, as the keeper sent it. */
export interface XrayInput {
  hash: Hex;
  lane: number | null;
  kind: string;
}

export interface XrayDesignInput {
  design: DesignName;
  contract: Address;
  txs: XrayInput[];
}

export const XRAY_EXCLUSIONS = [
  "Each tx's own sender account (EOA) `balance` and `nonce`: written by the gas pre-payment/refund and the nonce increment of the account that signed it, not by contract code. (Same-sender txs are ordered by nonce anyway.)",
  "The block coinbase (fee recipient) `balance`: every tx credits its priority fee to it; on anvil the coinbase is 0x0000000000000000000000000000000000000000.",
  "Transient storage (EIP-1153, the reentrancy guard): it is cleared at the end of every tx, is not part of the state, and never appears in prestate traces.",
  "Txs that are not part of the design's resolution phase (the shock, price pushes, the other design's txs) are not nodes of that design's graph. The price loop is paused for the whole crash run, so no oracle write lands between the shock and the last resolution tx.",
] as const;

// ---------------------------------------------------------------------------
// prestateTracer parsing
// ---------------------------------------------------------------------------

interface PrestateAccount {
  balance?: string;
  nonce?: number | string;
  code?: string;
  storage?: Record<string, string>;
}
type Prestate = Record<string, PrestateAccount>;
interface PrestateDiff {
  pre: Prestate;
  post: Prestate;
}

export interface AccessSets {
  /** Everything the tx touched (read and/or written). */
  access: Set<string>;
  /** Everything the tx changed. */
  write: Set<string>;
}

const ACCOUNT_FIELDS = ["balance", "nonce", "code"] as const;

function slotKey(addr: string, slot: string): string {
  return `${addr.toLowerCase()}:${normSlot(slot)}`;
}

/** Normalise a storage key to 0x + 64 lowercase hex chars. */
export function normSlot(slot: string): string {
  const h = slot.toLowerCase().replace(/^0x/, "");
  return `0x${h.padStart(64, "0")}`;
}

/**
 * Turn the two prestate traces of one tx into access/write sets, applying the exclusions:
 * the sender's balance+nonce and the coinbase's balance never count.
 */
export function accessSets(prestate: Prestate, diff: PrestateDiff, sender: string, coinbase: string): AccessSets {
  const from = sender.toLowerCase();
  const cb = coinbase.toLowerCase();
  const excluded = (addr: string, field: string) =>
    (addr === from && (field === "balance" || field === "nonce")) || (addr === cb && field === "balance");

  const access = new Set<string>();
  const write = new Set<string>();
  for (const [rawAddr, acct] of Object.entries(prestate ?? {})) {
    const addr = rawAddr.toLowerCase();
    for (const f of ACCOUNT_FIELDS) if (!excluded(addr, f)) access.add(`${addr}:${f}`);
    for (const slot of Object.keys(acct.storage ?? {})) access.add(slotKey(addr, slot));
  }
  const addrs = new Set([...Object.keys(diff?.pre ?? {}), ...Object.keys(diff?.post ?? {})].map((a) => a.toLowerCase()));
  for (const addr of addrs) {
    const pre = findAcct(diff.pre, addr);
    const post = findAcct(diff.post, addr);
    for (const slot of [...Object.keys(pre?.storage ?? {}), ...Object.keys(post?.storage ?? {})]) {
      write.add(slotKey(addr, slot));
    }
    // Account-level fields: diff `post` carries only the fields that changed.
    for (const f of ACCOUNT_FIELDS) {
      if (post && post[f] !== undefined && !excluded(addr, f)) write.add(`${addr}:${f}`);
    }
  }
  // A written slot is by definition accessed (covers SSTOREs a tracer didn't list in prestate).
  for (const k of write) access.add(k);
  return { access, write };
}

function findAcct(state: Prestate | undefined, addr: string): PrestateAccount | undefined {
  if (!state) return undefined;
  if (state[addr]) return state[addr];
  for (const [k, v] of Object.entries(state)) if (k.toLowerCase() === addr) return v;
  return undefined;
}

// ---------------------------------------------------------------------------
// Tracing
// ---------------------------------------------------------------------------

export async function tracePrestate(client: Client, hash: Hex, diffMode: boolean): Promise<unknown> {
  // Monad requires the trace-options object explicitly (else -32602), so always pass it.
  return client.request({
    method: "debug_traceTransaction" as never,
    params: [hash, { tracer: "prestateTracer", tracerConfig: { diffMode } }] as never,
  });
}

/**
 * Probe whether `client` serves debug_traceTransaction with prestateTracer + diffMode.
 * Returns null when usable, else the reason.
 */
export async function probeDebugTrace(client: Client, hash: Hex): Promise<string | null> {
  try {
    const plain = (await tracePrestate(client, hash, false)) as Prestate;
    const diff = (await tracePrestate(client, hash, true)) as PrestateDiff;
    if (!plain || typeof plain !== "object") return "debug_traceTransaction returned no prestate";
    if (!diff || typeof diff !== "object" || !("pre" in diff) || !("post" in diff)) {
      return "debug_traceTransaction ignored diffMode (no {pre, post})";
    }
    return null;
  } catch (err) {
    return (err as Error)?.message?.split("\n")[0] ?? String(err);
  }
}

export interface TracedTx {
  hash: Hex;
  from: Address;
  block: number;
  index: number;
  status: "success" | "reverted";
  gasUsed: bigint;
  sets: AccessSets;
}

/** Trace `hashes` on `client` (both prestate modes), with bounded concurrency. */
export async function traceAll(
  client: Client,
  hashes: Hex[],
  opts: { concurrency?: number; coinbaseOf?: (block: bigint) => Promise<Address> } = {},
): Promise<Map<Hex, TracedTx>> {
  const out = new Map<Hex, TracedTx>();
  const coinbases = new Map<bigint, Promise<Address>>();
  const coinbase = (block: bigint) => {
    let p = coinbases.get(block);
    if (!p) {
      p = opts.coinbaseOf ? opts.coinbaseOf(block) : client.getBlock({ blockNumber: block }).then((b) => b.miner);
      coinbases.set(block, p);
    }
    return p;
  };
  const queue = [...hashes];
  const worker = async () => {
    for (let h = queue.shift(); h !== undefined; h = queue.shift()) {
      const receipt = await client.getTransactionReceipt({ hash: h });
      const [plain, diff, cb] = await Promise.all([
        tracePrestate(client, h, false) as Promise<Prestate>,
        tracePrestate(client, h, true) as Promise<PrestateDiff>,
        coinbase(receipt.blockNumber),
      ]);
      out.set(h, {
        hash: h,
        from: receipt.from,
        block: Number(receipt.blockNumber),
        index: receipt.transactionIndex,
        status: receipt.status === "success" ? "success" : "reverted",
        gasUsed: receipt.gasUsed,
        sets: accessSets(plain, diff, receipt.from, cb),
      });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 8) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

/** Build one design's node list, same-block edges and summary from traced txs. */
export function buildDesignGraph(input: XrayDesignInput, traced: Map<Hex, TracedTx>): XrayDesign {
  const nodes = input.txs
    .map((t) => ({ input: t, tr: traced.get(t.hash) }))
    .filter((n): n is { input: XrayInput; tr: TracedTx } => n.tr !== undefined)
    .sort((a, b) => a.tr.block - b.tr.block || a.tr.index - b.tr.index);

  const txs: XrayTx[] = nodes.map(({ input: t, tr }) => ({
    hash: tr.hash,
    lane: t.lane,
    block: tr.block,
    index: tr.index,
    kind: tr.status === "success" ? t.kind : `${t.kind} (reverted)`,
    reads: [...tr.sets.access].filter((k) => !tr.sets.write.has(k)).length,
    writes: tr.sets.write.size,
  }));

  const edges: XrayEdge[] = [];
  const chain = new Map<Hex, number>(); // longest dependency chain ending at this tx
  const touched = new Set<Hex>();
  for (let j = 0; j < nodes.length; j++) {
    const b = nodes[j].tr;
    let best = 1;
    for (let i = j - 1; i >= 0 && nodes[i].tr.block === b.block; i--) {
      const a = nodes[i].tr;
      const slots = [...a.sets.write].filter((k) => b.sets.access.has(k)).sort();
      if (slots.length === 0) continue;
      edges.push({ from: a.hash, to: b.hash, slots });
      touched.add(a.hash).add(b.hash);
      best = Math.max(best, (chain.get(a.hash) ?? 1) + 1);
    }
    chain.set(b.hash, best);
  }
  const laneOf = new Map(txs.map((t) => [t.hash, t.lane]));
  const sameLane = (e: XrayEdge) => {
    const a = laneOf.get(e.from);
    return a !== null && a !== undefined && a === laneOf.get(e.to);
  };
  edges.sort((x, y) => {
    const xi = txs.findIndex((t) => t.hash === x.from);
    const yi = txs.findIndex((t) => t.hash === y.from);
    return xi - yi || txs.findIndex((t) => t.hash === x.to) - txs.findIndex((t) => t.hash === y.to);
  });

  return {
    design: input.design,
    contract: input.contract,
    blocks: [...new Set(txs.map((t) => t.block))].sort((a, b) => a - b),
    txs,
    edges,
    summary: {
      txs: txs.length,
      edges: edges.length,
      longestChain: txs.length ? Math.max(...chain.values()) : 0,
      independentTxs: txs.filter((t) => !touched.has(t.hash)).length,
      crossLaneEdges: edges.filter((e) => !sameLane(e)).length,
      sameLaneEdges: edges.filter(sameLane).length,
    },
  };
}

/** Slots that appear on any edge, most frequent first (for logs / reports). */
export function hotSlots(design: XrayDesign, limit = 10): Array<{ slot: string; edges: number }> {
  const count = new Map<string, number>();
  for (const e of design.edges) for (const s of e.slots) count.set(s, (count.get(s) ?? 0) + 1);
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([slot, edges]) => ({ slot, edges }));
}
