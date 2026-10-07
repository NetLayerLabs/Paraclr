// `npm run pyth:cadence` — how fresh is the Pyth price STORED on Monad mainnet, without us?
//
// Read-only (eth_getLogs + block headers on the RPC; nothing is sent). For every feed it collects
// the PriceFeedUpdate events of the Pyth contract over the last --blocks blocks (Pyth emits one
// only when it stores a newer price), then replays the stored price's age over time:
//   - pushes/hour and the gap between stored publish times (p50 / p90 / max),
//   - the fraction of wall time the stored price is ≤ 10 s / ≤ 15 s / ≤ 30 s old (the production
//     contract's maxStoredPriceAge is 15 s),
//   - a simulation of the keeper's interval push policy (push when the stored price would be older
//     than --target seconds) on top of the observed third-party pushes → pushes/day we'd pay for.
// Output: JSON on stdout (and --out FILE). The production push policy and its MON/day figures in
// docs/RUNBOOK.md come from this.
//
//   --blocks N (default 27000 ≈ 3 h)   --rpc URL (default https://rpc.monad.xyz)   --target S (12)

import { writeFileSync } from "node:fs";
import { createPublicClient, http, keccak256, toHex, type Hex } from "viem";
import { parseArgs } from "../keeper/src/env";
import { KNOWN, MAINNET_RPC_URL } from "../keeper/src/prod/config";

const TOPIC = keccak256(toHex("PriceFeedUpdate(bytes32,uint64,int64,uint64)"));

export interface FeedCadence {
  symbol: string;
  feed: Hex;
  updates: number;
  pushesPerHour: number;
  gapS: { p50: number; p90: number; max: number };
  /** Fraction of the window the stored price was at most N seconds old. */
  freshShare: { le10: number; le15: number; le30: number };
}

export interface CadenceReport {
  measuredAt: string;
  rpc: string;
  fromBlock: number;
  toBlock: number;
  windowS: number;
  feeds: FeedCadence[];
  /** Fraction of time ALL feeds were ≤ 15 s old at once (a `[]` call on a 3-market account). */
  allFeedsFreshShare15: number;
  /** Interval policy simulated on the observed timeline: our pushes per day (3-feed push). */
  intervalPolicy: { targetS: number; pushesPerDay: number; pushesPerDayWithoutThirdParty: number };
}

function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
}

export async function measureCadence(rpcUrl: string, blocks: number, targetS = 12, log: (m: string) => void = () => undefined): Promise<CadenceReport> {
  // The public RPC allows ~50 requests/s: small batches + pauses, generous retries.
  const c = createPublicClient({ transport: http(rpcUrl, { retryCount: 8, retryDelay: 1_000 }) });
  const pause = () => new Promise((r) => setTimeout(r, 300));
  const head = Number(await c.getBlockNumber());
  const from = head - blocks;
  const want = new Map(Object.entries(KNOWN.feeds).map(([s, f]) => [f.toLowerCase(), s]));
  const events: Array<{ block: number; feed: string; publishTime: number }> = [];
  for (let to = head; to > from; to -= 100 * 6) {
    await pause();
    const windows: Array<[number, number]> = [];
    for (let k = 0; k < 6; k++) {
      const hi = to - k * 100;
      const lo = Math.max(from + 1, hi - 99);
      if (hi > from) windows.push([lo, hi]);
    }
    const res = await Promise.all(
      windows.map(([lo, hi]) => c.getLogs({ address: KNOWN.pyth, fromBlock: BigInt(lo), toBlock: BigInt(hi) } as never) as Promise<Array<{ topics: Hex[]; data: Hex; blockNumber: bigint }>>),
    );
    for (const logs of res) {
      for (const l of logs) {
        if (l.topics[0] !== TOPIC) continue;
        const feed = l.topics[1]?.toLowerCase();
        if (!feed || !want.has(feed)) continue;
        events.push({ block: Number(l.blockNumber), feed, publishTime: Number(BigInt(`0x${l.data.slice(2, 66)}`)) });
      }
    }
    if (((head - to) / 600) % 10 === 0) log(`  scanned to block ${Math.max(from, to - 600)} (${events.length} updates so far)`);
  }
  // Block timestamps (only the blocks with updates + the window edges).
  const blockSet = [...new Set([from, head, ...events.map((e) => e.block)])].sort((a, b) => a - b);
  const ts = new Map<number, number>();
  for (let i = 0; i < blockSet.length; i += 10) {
    await pause();
    const chunk = blockSet.slice(i, i + 10);
    const got = await Promise.all(chunk.map((n) => c.getBlock({ blockNumber: BigInt(n) })));
    got.forEach((b, j) => ts.set(chunk[j], Number(b.timestamp)));
  }
  const t0 = ts.get(from)!;
  const t1 = ts.get(head)!;
  const windowS = t1 - t0;

  const timelines = new Map<string, Array<{ at: number; publishTime: number }>>();
  for (const e of events.sort((a, b) => a.block - b.block)) {
    const arr = timelines.get(e.feed) ?? [];
    arr.push({ at: ts.get(e.block)!, publishTime: e.publishTime });
    timelines.set(e.feed, arr);
  }

  /** Seconds in [t0, t1] during which the stored age ≤ limit, for a list of (storedAt, publishTime). */
  const freshSeconds = (tl: Array<{ at: number; publishTime: number }>, limit: number) => {
    let fresh = 0;
    for (let i = 0; i < tl.length; i++) {
      const start = Math.max(t0, tl[i].at);
      const end = Math.min(t1, i + 1 < tl.length ? tl[i + 1].at : t1);
      const freshUntil = tl[i].publishTime + limit;
      if (end > start) fresh += Math.max(0, Math.min(end, freshUntil) - start);
    }
    return fresh;
  };

  const feeds: FeedCadence[] = [];
  for (const [feed, symbol] of want) {
    const tl = timelines.get(feed) ?? [];
    const gaps = tl.slice(1).map((x, i) => x.publishTime - tl[i].publishTime).sort((a, b) => a - b);
    feeds.push({
      symbol,
      feed: feed as Hex,
      updates: tl.length,
      pushesPerHour: Math.round((tl.length / windowS) * 3600 * 10) / 10,
      gapS: { p50: pct(gaps, 0.5), p90: pct(gaps, 0.9), max: gaps[gaps.length - 1] ?? NaN },
      freshShare: {
        le10: round(freshSeconds(tl, 10) / windowS),
        le15: round(freshSeconds(tl, 15) / windowS),
        le30: round(freshSeconds(tl, 30) / windowS),
      },
    });
  }

  // All three fresh at once: step through every second of the window.
  const step = (tl: Array<{ at: number; publishTime: number }>) => {
    let i = -1;
    return (t: number) => {
      while (i + 1 < tl.length && tl[i + 1].at <= t) i++;
      return i < 0 ? -Infinity : tl[i].publishTime;
    };
  };
  const cursors = [...want.keys()].map((f) => step(timelines.get(f) ?? []));
  let allFresh = 0;
  // Interval policy: we push all 3 feeds (one Hermes blob) whenever the oldest stored price would
  // exceed targetS; our push stores publishTime ≈ t − 1 (Hermes latency).
  let ourLast = -Infinity;
  let ours = 0;
  for (let t = t0; t < t1; t++) {
    const stored = cursors.map((cur) => cur(t));
    if (stored.every((p) => t - p < 15)) allFresh++; // integer seconds: matches the continuous share above
    const effective = stored.map((p) => Math.max(p, ourLast));
    if (effective.some((p) => t - p > targetS)) {
      ours++;
      ourLast = t - 1;
    }
  }
  const scale = 86_400 / windowS;
  return {
    measuredAt: new Date().toISOString(),
    rpc: new URL(rpcUrl).host,
    fromBlock: from,
    toBlock: head,
    windowS,
    feeds,
    allFeedsFreshShare15: round(allFresh / windowS),
    intervalPolicy: {
      targetS,
      pushesPerDay: Math.round(ours * scale),
      pushesPerDayWithoutThirdParty: Math.round(86_400 / (targetS + 1)),
    },
  };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rpc = typeof args.rpc === "string" ? args.rpc : MAINNET_RPC_URL;
  const blocks = Number(args.blocks ?? 27_000);
  const target = Number(args.target ?? 12);
  const r = await measureCadence(rpc, blocks, target, (m) => console.error(m));
  const json = JSON.stringify(r, null, 2);
  if (typeof args.out === "string") writeFileSync(args.out, json + "\n");
  console.log(json);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(`pyth:cadence failed: ${(err as Error)?.message ?? err}`);
    process.exit(1);
  });
}
