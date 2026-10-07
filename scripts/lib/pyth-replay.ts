// Rehearsal-only Pyth data sources (never used by the production keeper):
//
//   harvestUpdates()   collects REAL signed Pyth accumulator updates from Monad mainnet
//                      transactions (anyone who calls Pyth's updatePriceFeeds puts the Hermes
//                      blob in calldata). Since 2026-08-26 Hermes needs an API key; harvesting
//                      lets the fork rehearsal use genuine Wormhole-signed data, verified on the
//                      fork by the real Pyth contract, without one.
//   HermesReplay       a local HTTP server that speaks the two Hermes v2 routes the keeper uses
//                      (/v2/updates/price/latest and /v2/updates/price/{publish_time}), serving
//                      either the harvested updates ("replay" mode, subset to the requested feeds
//                      exactly like Hermes) or MockPyth-format updates from a settable price table
//                      ("mock" mode, for the liquidation leg on a plain anvil with the test
//                      MockPyth). It never serves an update from the future of the chain clock, can
//                      require a bearer key (exercises the keeper's PYTH_API_KEY path) and can
//                      inject outages (exercises backoff + alerts).

import { createServer, type Server } from "node:http";
import { encodeAbiParameters, keccak256, toHex, type Hex } from "viem";
import { extractUpdatesFromCalldata, parseAccumulatorUpdate, subsetUpdate } from "../../keeper/src/prod/pyth-wire";
import type { Client } from "../../keeper/src/prod/config";

export interface HarvestedUpdate {
  block: number;
  txHash: Hex;
  /** Full blob as found on chain. */
  blob: Hex;
  slot: string;
  /** Messages for the feeds of interest, by lowercase id. */
  messages: Record<string, { price: string; conf: string; expo: number; publishTime: number; prevPublishTime: number }>;
}

const PRICE_FEED_UPDATE = keccak256(toHex("PriceFeedUpdate(bytes32,uint64,int64,uint64)"));

/**
 * Every Pyth update (for `feeds`) landed on chain in (fromBlock, toBlock], oldest first, deduped by
 * slot. Uses 100-block eth_getLogs windows (the public RPC's limit).
 */
export async function harvestUpdates(
  client: Client,
  pyth: Hex,
  feeds: readonly Hex[],
  fromBlock: number,
  toBlock: number,
  log: (m: string) => void = () => undefined,
): Promise<HarvestedUpdate[]> {
  const want = new Set(feeds.map((f) => f.toLowerCase()));
  const txs = new Map<string, number>();
  for (let to = toBlock; to > fromBlock; to -= 100) {
    const from = Math.max(fromBlock + 1, to - 99);
    const logs = await client.getLogs({ address: pyth, fromBlock: BigInt(from), toBlock: BigInt(to) } as never);
    for (const l of logs as Array<{ topics: Hex[]; transactionHash: Hex; blockNumber: bigint }>) {
      if (l.topics[0] === PRICE_FEED_UPDATE && want.has(l.topics[1]?.toLowerCase())) txs.set(l.transactionHash, Number(l.blockNumber));
    }
  }
  log(`harvest: ${txs.size} mainnet txs updated the feeds in blocks ${fromBlock + 1}..${toBlock}`);
  const out: HarvestedUpdate[] = [];
  const seen = new Set<string>();
  const entries = [...txs.entries()];
  for (let i = 0; i < entries.length; i += 10) {
    const chunk = entries.slice(i, i + 10);
    const got = await Promise.all(chunk.map(([hash]) => client.getTransaction({ hash: hash as Hex })));
    got.forEach((tx, j) => {
      for (const blob of extractUpdatesFromCalldata(tx.input)) {
        const p = parseAccumulatorUpdate(blob);
        const key = `${p.slot}`;
        const messages: HarvestedUpdate["messages"] = {};
        for (const m of p.messages) {
          if (!want.has(m.id)) continue;
          messages[m.id] = { price: m.price.toString(), conf: m.conf.toString(), expo: m.expo, publishTime: m.publishTime, prevPublishTime: m.prevPublishTime };
        }
        if (Object.keys(messages).length === 0 || seen.has(key)) continue;
        seen.add(key);
        out.push({ block: chunk[j][1], txHash: chunk[j][0] as Hex, blob, slot: key, messages });
      }
    });
  }
  out.sort((a, b) => minTime(a) - minTime(b) || a.block - b.block);
  return out;
}

function minTime(u: HarvestedUpdate): number {
  return Math.min(...Object.values(u.messages).map((m) => m.publishTime));
}

/** Harvested updates that carry ALL of `ids`, with publishTime of each id. */
export function updatesWith(updates: HarvestedUpdate[], ids: readonly Hex[]): HarvestedUpdate[] {
  return updates.filter((u) => ids.every((id) => u.messages[id.toLowerCase()]));
}

// ---------------------------------------------------------------------------
// Hermes-compatible replay / mock server
// ---------------------------------------------------------------------------

export interface MockPrice {
  /** Integer price at `expo` (e.g. 2841507 with expo −8 = 0.02841507). */
  price: bigint;
  conf: bigint;
  expo: number;
}

export interface ReplayOptions {
  port: number;
  mode: "replay" | "mock";
  updates?: HarvestedUpdate[];
  /** Chain clock (s): never serve an update published after this. */
  now: () => Promise<number>;
  /** Required `Authorization: Bearer <key>` (unset = open). */
  apiKey?: string;
}

interface RequestLog {
  at: number;
  path: string;
  status: number;
  ids: string[];
}

export class HermesReplay {
  private server: Server | null = null;
  private outageUntil = 0;
  readonly requests: RequestLog[] = [];
  /** mock mode: current price per feed id (lowercase). */
  readonly prices = new Map<string, MockPrice>();
  /** mock mode: feeds that "died" — always served with this publish time (stale). */
  readonly frozen = new Map<string, number>();

  constructor(private readonly opts: ReplayOptions) {}

  get url(): string {
    return `http://127.0.0.1:${this.opts.port}`;
  }

  /** Answer 503 to everything for `ms` (outage drill). */
  outage(ms: number): void {
    this.outageUntil = Date.now() + ms;
  }

  start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req.url ?? "/", req.headers.authorization).then(({ status, body }) => {
        res.writeHead(status, { "content-type": status === 200 ? "application/json" : "text/plain" });
        res.end(typeof body === "string" ? body : JSON.stringify(body));
      });
    });
    return new Promise((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.opts.port, "127.0.0.1", () => resolve());
    });
  }

  stop(): Promise<void> {
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private async handle(rawUrl: string, auth: string | undefined): Promise<{ status: number; body: unknown }> {
    const url = new URL(rawUrl, "http://replay.local");
    const ids = url.searchParams.getAll("ids[]").map((i) => (i.startsWith("0x") ? i : `0x${i}`).toLowerCase() as Hex);
    const done = (status: number, body: unknown) => {
      this.requests.push({ at: Date.now(), path: url.pathname, status, ids });
      if (this.requests.length > 5_000) this.requests.shift();
      return { status, body };
    };
    if (this.opts.apiKey && auth !== `Bearer ${this.opts.apiKey}`) return done(401, "unauthorized");
    if (Date.now() < this.outageUntil) return done(503, "replay: injected outage");
    const m = /^\/v2\/updates\/price\/(latest|\d+)$/.exec(url.pathname);
    if (!m || ids.length === 0) return done(404, "not found");
    const now = await this.opts.now();
    if (this.opts.mode === "mock") return done(...this.mock(ids, m[1] === "latest" ? null : Number(m[1]), now));
    const pool = updatesWith(this.opts.updates ?? [], ids).filter((u) => ids.every((id) => u.messages[id].publishTime <= now));
    let pick: HarvestedUpdate | undefined;
    if (m[1] === "latest") pick = pool[pool.length - 1];
    else {
      const t = Number(m[1]);
      pick = pool.find((u) => ids.every((id) => u.messages[id].publishTime >= t));
    }
    if (!pick) return done(404, "Price ids not found or no update at/after publish_time yet");
    return done(200, hermesBody(subsetUpdate(pick.blob, ids), ids.map((id) => ({ id, ...pick!.messages[id], slot: pick!.slot }))));
  }

  /**
   * MockPyth wire format (contracts/test/prod/mocks/MockPyth.sol): one blob per request,
   * abi.encode(bytes4 "PNAU", Msg[]) with Msg = (id, price, conf, expo, publishTime, prevPublishTime).
   * publishTime = the chain clock for `latest`, or exactly the requested time for {publish_time}
   * (so prevPublishTime = t − 1 < t: the first update at/after t, as Hermes would serve it).
   */
  private mock(ids: Hex[], at: number | null, now: number): [number, unknown] {
    if (at !== null && at > now) return [404, "no update at/after publish_time yet"];
    const msgs: MockMsg[] = [];
    const parsed: Array<{ id: string; price: string; conf: string; expo: number; publishTime: number; prevPublishTime: number; slot: string }> = [];
    for (const id of ids) {
      const p = this.prices.get(id);
      if (!p) return [404, `no mock price for ${id}`];
      const frozenAt = this.frozen.get(id);
      if (frozenAt !== undefined && at !== null && at > frozenAt) return [404, "feed stopped publishing"];
      const publishTime = frozenAt ?? (at === null ? now : at);
      msgs.push({ id, price: p.price, conf: p.conf, expo: p.expo, publishTime: BigInt(publishTime), prevPublishTime: BigInt(publishTime - 1) });
      parsed.push({ id, price: p.price.toString(), conf: p.conf.toString(), expo: p.expo, publishTime, prevPublishTime: publishTime - 1, slot: "0" });
    }
    return [200, hermesBodyMany([encodeMockUpdate(msgs)], parsed)];
  }
}

export interface MockMsg {
  id: Hex;
  price: bigint;
  conf: bigint;
  expo: number;
  publishTime: bigint;
  prevPublishTime: bigint;
}

export function encodeMockUpdate(msgs: MockMsg[]): Hex {
  return encodeAbiParameters(
    [
      { type: "bytes4" },
      {
        type: "tuple[]",
        components: [
          { name: "id", type: "bytes32" },
          { name: "price", type: "int64" },
          { name: "conf", type: "uint64" },
          { name: "expo", type: "int32" },
          { name: "publishTime", type: "uint64" },
          { name: "prevPublishTime", type: "uint64" },
        ],
      },
    ],
    ["0x504e4155", msgs],
  );
}

function hermesBody(
  blob: Hex,
  msgs: Array<{ id: string; price: string; conf: string; expo: number; publishTime: number; prevPublishTime: number; slot: string }>,
) {
  return hermesBodyMany([blob], msgs);
}

function hermesBodyMany(
  blobs: Hex[],
  msgs: Array<{ id: string; price: string; conf: string; expo: number; publishTime: number; prevPublishTime: number; slot: string }>,
) {
  return {
    binary: { encoding: "hex", data: blobs.map((b) => b.slice(2)) },
    parsed: msgs.map((m) => ({
      id: m.id.slice(2),
      price: { price: m.price, conf: m.conf, expo: m.expo, publish_time: m.publishTime },
      ema_price: { price: m.price, conf: m.conf, expo: m.expo, publish_time: m.publishTime },
      metadata: { slot: Number(m.slot), proof_available_time: m.publishTime, prev_publish_time: m.prevPublishTime },
    })),
  };
}

