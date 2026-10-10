// Read-side RPC plumbing for the chain modes: one public client, one shared
// block watcher (so prices, account and lane readers don't each poll the
// head), and a multicall-or-parallel batch reader.
//
// Public Monad RPCs allow ~15 requests/s per IP, shared with the keeper when
// it runs on the same machine, so on a remote chain every read is shaped to
// stay well under that:
//   - the head is polled every NETWORK.pollMs (1.5 s) with one
//     eth_getBlockByNumber that also carries the timestamp (no separate
//     eth_blockNumber + eth_getBlockByNumber pair per reader);
//   - same-tick requests are merged into one JSON-RPC batch (viem's http
//     transport `batch`), and the per-block readers all run in the same tick;
//   - a browser-side limiter spaces requests out before the provider has to
//     refuse any (a 429 is logged by the browser itself, so avoiding it is
//     the only cure);
//   - polling stops while the tab is hidden and resumes on return.
// Local chains (anvil, the sandbox fork) keep the plain transport.

import {
  createPublicClient,
  http,
  multicall3Abi,
  type Address,
  type Chain,
  type HttpTransport,
  type MulticallParameters,
  type MulticallReturnType,
  type PublicClient,
  type ReadContractParameters,
} from "viem";
import { NETWORK } from "./config";

export type ChainPublicClient = PublicClient<HttpTransport, Chain>;

/** The RPC is a shared public endpoint (not anvil / a local fork): shape the traffic. */
const REMOTE = !!NETWORK && !NETWORK.local;

const RATE_LIMITED = /"code"\s*:\s*-32007|request limit|requests? limited to|rate.?limit|too many requests/i;

// ---- browser-side request limiter --------------------------------------------

/** HTTP requests this browser sends a public RPC per second (the provider allows ~15 per IP). */
const MAX_RPS = 8;
let starts: number[] = [];
let queue: Promise<void> = Promise.resolve();

/** Resolves once a request may start without exceeding MAX_RPS over the last second. Callers are served in order. */
function reserveSlot(): Promise<void> {
  const next = queue.then(async () => {
    let now = Date.now();
    starts = starts.filter((t) => now - t < 1_000);
    if (starts.length >= MAX_RPS) {
      await new Promise((r) => setTimeout(r, starts[0] + 1_000 - now + 5));
      now = Date.now();
      starts = starts.filter((t) => now - t < 1_000);
    }
    starts.push(now);
  });
  queue = next.catch(() => undefined);
  return next;
}

/**
 * fetch for the RPC transports that waits and retries when the provider refuses a request
 * for its per-second cap. Monad's public RPC (QuickNode) answers -32007 inside an HTTP 200,
 * which viem doesn't retry, so a burst of reads on load would fail the whole connection.
 * A refused request wasn't processed, so resending it (even a raw transaction) is safe.
 * On a remote chain it also paces requests (MAX_RPS) so the cap is rarely hit at all.
 */
export const rateLimitedFetch: typeof fetch = async (input, init) => {
  for (let attempt = 0; ; attempt++) {
    if (REMOTE) await reserveSlot();
    const res = await fetch(input, init);
    if (attempt >= 6) return res;
    const limited = res.status === 429 || (res.ok && RATE_LIMITED.test(await res.clone().text()));
    if (!limited) return res;
    await new Promise((r) => setTimeout(r, Math.min(4_000, 250 * 2 ** attempt) * (0.75 + Math.random() / 2)));
  }
};

let client: ChainPublicClient | null = null;

/** Public client for the active chain mode. Throws in sim mode. */
export function publicClient(): ChainPublicClient {
  if (!NETWORK) throw new Error("No chain configured (NEXT_PUBLIC_CHAIN_MODE=sim)");
  if (!client) {
    client = createPublicClient({
      chain: NETWORK.chain,
      transport: http(NETWORK.rpcUrl, {
        timeout: 10_000,
        retryCount: 1,
        fetchFn: rateLimitedFetch,
        // Remote: requests issued in the same tick go out as one JSON-RPC batch
        // (one HTTP request, one slot at the provider's cap). Local: unchanged.
        batch: REMOTE ? { wait: 10, batchSize: 100 } : false,
      }),
      pollingInterval: NETWORK.pollMs,
    });
  }
  return client;
}

/**
 * Calldata per Multicall3 chunk. viem's default (1 KiB) splits a per-block
 * state read (~25 views) into two eth_calls; one chunk is plenty for the
 * batches here and still far below any RPC payload limit.
 */
const MULTICALL_CHUNK_BYTES = 16_384;

/**
 * Batch of view calls. Uses Multicall3 when the chain has it (Monad testnet:
 * one RPC request), otherwise parallel eth_calls (anvil has no Multicall3).
 * Never throws for individual failures: each entry is success/failure.
 */
export async function readMany<const contracts extends readonly unknown[]>(
  params: MulticallParameters<contracts, true>,
): Promise<MulticallReturnType<contracts, true>> {
  const pc = publicClient();
  if (pc.chain.contracts?.multicall3) {
    return pc.multicall({ ...params, allowFailure: true, batchSize: MULTICALL_CHUNK_BYTES });
  }
  const calls = params.contracts as unknown as readonly ReadContractParameters[];
  const settled = await Promise.allSettled(calls.map((c) => pc.readContract(c)));
  return settled.map((s) =>
    s.status === "fulfilled"
      ? { status: "success", result: s.value }
      : { status: "failure", error: s.reason as Error, result: undefined },
  ) as unknown as MulticallReturnType<contracts, true>;
}

/**
 * A native-balance view that can ride in a `readMany` batch: Multicall3's
 * `getEthBalance`. Null when the chain has no Multicall3 (use `getBalance`).
 */
export function nativeBalanceCall(address: Address): {
  address: Address;
  abi: typeof multicall3Abi;
  functionName: "getEthBalance";
  args: readonly [Address];
} | null {
  const m = publicClient().chain.contracts?.multicall3?.address;
  return m ? { address: m, abi: multicall3Abi, functionName: "getEthBalance", args: [address] } : null;
}

// ---- shared block subscription ---------------------------------------------

/** Latest head seen by the watcher, with the local time it arrived (for chain-time extrapolation). */
export interface BlockHead {
  number: bigint;
  /** Block timestamp (s). */
  timestamp: bigint;
  /** Local clock (ms) when this head was received. */
  seenAt: number;
}

type BlockListener = (block: bigint) => void;
type ErrorListener = (error: Error | null) => void;

const blockListeners = new Set<BlockListener>();
const errorListeners = new Set<ErrorListener>();
let unwatch: (() => void) | null = null;
let latestHead: BlockHead | null = null;
let visibilityHooked = false;

export function getLatestBlock(): bigint | null {
  return latestHead?.number ?? null;
}

/** Latest head (number + timestamp) the watcher has seen; null before the first poll. */
export function getLatestHead(): BlockHead | null {
  return latestHead;
}

/** Chain "now" (s) extrapolated from the latest head, or null before the first poll. */
export function chainTimeNow(now = Date.now()): number | null {
  if (!latestHead) return null;
  return Number(latestHead.timestamp) + Math.max(0, now - latestHead.seenAt) / 1_000;
}

const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

function startWatch() {
  if (unwatch || blockListeners.size === 0) return;
  // One eth_getBlockByNumber per poll carries number and timestamp for every reader.
  unwatch = publicClient().watchBlocks({
    emitOnBegin: true,
    emitMissed: false,
    poll: true,
    pollingInterval: NETWORK?.pollMs ?? 1_000,
    onBlock: (block) => {
      if (block.number === null) return;
      latestHead = { number: block.number, timestamp: block.timestamp, seenAt: Date.now() };
      errorListeners.forEach((l) => l(null));
      const b = block.number;
      blockListeners.forEach((l) => l(b));
    },
    onError: (e) => errorListeners.forEach((l) => l(e)),
  });
}

function stopWatch() {
  unwatch?.();
  unwatch = null;
}

/** Pause polling while the tab is hidden; the first poll on return (emitOnBegin) refreshes every reader. */
function hookVisibility() {
  if (visibilityHooked || typeof document === "undefined") return;
  visibilityHooked = true;
  document.addEventListener("visibilitychange", () => {
    if (hidden()) stopWatch();
    else startWatch();
  });
}

/** Called on every new block (polled). Returns an unsubscribe function. */
export function subscribeBlocks(listener: BlockListener): () => void {
  blockListeners.add(listener);
  if (latestHead !== null) {
    const b = latestHead.number;
    queueMicrotask(() => blockListeners.has(listener) && listener(b));
  }
  hookVisibility();
  if (!hidden()) startWatch();
  return () => {
    blockListeners.delete(listener);
    if (blockListeners.size === 0) stopWatch();
  };
}

/** RPC errors from the block watcher (null once it recovers). */
export function subscribeBlockErrors(listener: ErrorListener): () => void {
  errorListeners.add(listener);
  return () => errorListeners.delete(listener);
}

/**
 * Wrap an async job so it never overlaps itself and runs at most every
 * `minGapMs`; calls that arrive while busy collapse into one trailing run.
 */
export function coalesce(job: () => Promise<void>, minGapMs: number): () => void {
  let running = false;
  let queued = false;
  let lastStart = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async () => {
    timer = undefined;
    running = true;
    queued = false;
    lastStart = Date.now();
    try {
      await job();
    } catch {
      /* job reports its own errors */
    } finally {
      running = false;
      if (queued) trigger();
    }
  };

  const trigger = () => {
    if (running) {
      queued = true;
      return;
    }
    if (timer) return;
    const wait = Math.max(0, lastStart + minGapMs - Date.now());
    timer = setTimeout(run, wait);
  };
  return trigger;
}
