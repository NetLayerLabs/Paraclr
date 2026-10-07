// Read-side RPC plumbing for the chain modes: one public client, one shared
// block-number watcher (so prices, account and lane readers don't each poll
// eth_blockNumber), and a multicall-or-parallel batch reader.

import {
  createPublicClient,
  http,
  type Chain,
  type HttpTransport,
  type MulticallParameters,
  type MulticallReturnType,
  type PublicClient,
  type ReadContractParameters,
} from "viem";
import { NETWORK } from "./config";

export type ChainPublicClient = PublicClient<HttpTransport, Chain>;

const RATE_LIMITED = /"code"\s*:\s*-32007|request limit|requests? limited to|rate.?limit|too many requests/i;

/**
 * fetch for the RPC transports that waits and retries when the provider refuses a request
 * for its per-second cap. Monad's public RPC (QuickNode) answers -32007 inside an HTTP 200,
 * which viem doesn't retry, so a burst of reads on load would fail the whole connection.
 * A refused request wasn't processed, so resending it (even a raw transaction) is safe.
 */
export const rateLimitedFetch: typeof fetch = async (input, init) => {
  for (let attempt = 0; ; attempt++) {
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
      transport: http(NETWORK.rpcUrl, { timeout: 10_000, retryCount: 1, fetchFn: rateLimitedFetch }),
      pollingInterval: NETWORK.pollMs,
    });
  }
  return client;
}

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
    return pc.multicall({ ...params, allowFailure: true });
  }
  const calls = params.contracts as unknown as readonly ReadContractParameters[];
  const settled = await Promise.allSettled(calls.map((c) => pc.readContract(c)));
  return settled.map((s) =>
    s.status === "fulfilled"
      ? { status: "success", result: s.value }
      : { status: "failure", error: s.reason as Error, result: undefined },
  ) as unknown as MulticallReturnType<contracts, true>;
}

// ---- shared block subscription ---------------------------------------------

type BlockListener = (block: bigint) => void;
type ErrorListener = (error: Error | null) => void;

const blockListeners = new Set<BlockListener>();
const errorListeners = new Set<ErrorListener>();
let unwatch: (() => void) | null = null;
let latestBlock: bigint | null = null;

export function getLatestBlock(): bigint | null {
  return latestBlock;
}

/** Called on every new block (polled). Returns an unsubscribe function. */
export function subscribeBlocks(listener: BlockListener): () => void {
  blockListeners.add(listener);
  if (latestBlock !== null) {
    const b = latestBlock;
    queueMicrotask(() => blockListeners.has(listener) && listener(b));
  }
  if (!unwatch) {
    unwatch = publicClient().watchBlockNumber({
      emitOnBegin: true,
      emitMissed: false,
      poll: true,
      pollingInterval: NETWORK?.pollMs ?? 1_000,
      onBlockNumber: (b) => {
        latestBlock = b;
        errorListeners.forEach((l) => l(null));
        blockListeners.forEach((l) => l(b));
      },
      onError: (e) => errorListeners.forEach((l) => l(e)),
    });
  }
  return () => {
    blockListeners.delete(listener);
    if (blockListeners.size === 0 && unwatch) {
      unwatch();
      unwatch = null;
    }
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
