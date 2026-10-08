import { MARKETS, type MarketSymbol, type PriceTick } from "../types";
import type { PriceSource, TickHandler } from "./source";

/**
 * Chainlink Data Streams source.
 *
 * ── How Data Streams works ────────────────────────────────────────────────
 * Data Streams is pull-based: a DON signs a fresh report every ~sub-second and
 * you subscribe over WebSocket:
 *
 *   wss://ws.dataengine.chain.link/api/v1/ws?feedIDs=<id>,<id>          (mainnet)
 *   wss://ws.testnet-dataengine.chain.link/api/v1/ws?feedIDs=<id>,<id>  (testnet)
 *
 * Each message is JSON:
 *   { "report": { "feedID": "0x0003…", "fullReport": "0x…" } }
 *
 * `fullReport` is ABI-encoded:
 *   (bytes32[3] reportContext, bytes reportBlob, bytes32[] rawRs, bytes32[] rawSs, bytes32 rawVs)
 * The schema version is the first two bytes of the feed ID (0x0003 = v3,
 * "Crypto Advanced"). A v3 reportBlob is:
 *   (bytes32 feedId, uint32 validFromTimestamp, uint32 observationsTimestamp,
 *    uint192 nativeFee, uint192 linkFee, uint32 expiresAt,
 *    int192 benchmarkPrice, int192 bid, int192 ask)
 * Prices are fixed-point with 18 decimals. We decode word 6 (benchmarkPrice)
 * client-side below - no dependency needed. The rawRs/rawSs/rawVs signatures
 * are only needed for on-chain verification via the VerifierProxy (e.g. when
 * the clearinghouse contract settles against a report).
 *
 * ── Feed-ID mapping ───────────────────────────────────────────────────────
 * Feed IDs are 32-byte hex strings published at docs.chain.link/data-streams.
 * Configure them per market (AUSD is a USD stablecoin, so X/USD ≈ X/AUSD):
 *   NEXT_PUBLIC_CHAINLINK_FEED_MON  → MON/USD  stream  → "MON/AUSD"
 *   NEXT_PUBLIC_CHAINLINK_FEED_SOL  → SOL/USD  stream  → "SOL/AUSD"
 *   NEXT_PUBLIC_CHAINLINK_FEED_BTC  → BTC/USD  stream  → "BTC/AUSD"
 * Markets without a configured feed stay on the simulator.
 *
 * ── Auth (be honest) ──────────────────────────────────────────────────────
 * The Data Streams WS handshake requires HMAC headers:
 *   Authorization: <API key>
 *   X-Authorization-Timestamp: <ms>
 *   X-Authorization-Signature-SHA256: HMAC_SHA256(secret,
 *       "GET /api/v1/ws?feedIDs=… <sha256('')> <API key> <timestamp>")
 * Browsers can't set headers on a WebSocket and the secret must never ship to
 * the client, so NEXT_PUBLIC_CHAINLINK_STREAMS_WS should point at a small
 * server-side relay that holds CHAINLINK_API_KEY / CHAINLINK_API_SECRET,
 * opens the authenticated upstream socket and forwards messages verbatim.
 * Sketch (Node, `ws` package - not installed in this repo):
 *
 *   const up = new WebSocket(`${UPSTREAM}/api/v1/ws?feedIDs=${ids}`, {
 *     headers: signHeaders("GET", `/api/v1/ws?feedIDs=${ids}`),
 *   });
 *   wss.on("connection", (client) => up.on("message", (m) => client.send(m)));
 *
 * (Next.js Route Handlers can't upgrade WebSockets, so the relay is either a
 * standalone process or a Route Handler that re-streams as SSE.) The client
 * accepts both the raw `{report:{feedID,fullReport}}` shape and a pre-decoded
 * `{feedID, price, observationsTimestamp}` shape, so the relay may decode too.
 */

export interface ChainlinkConfig {
  wsUrl: string;
  feeds: Partial<Record<MarketSymbol, string>>;
}

export function chainlinkConfigFromEnv(): ChainlinkConfig | null {
  // Literal property access so Next inlines NEXT_PUBLIC_* at build time.
  const wsUrl = process.env.NEXT_PUBLIC_CHAINLINK_STREAMS_WS;
  const feeds: Partial<Record<MarketSymbol, string>> = {};
  const mon = process.env.NEXT_PUBLIC_CHAINLINK_FEED_MON;
  const sol = process.env.NEXT_PUBLIC_CHAINLINK_FEED_SOL;
  const btc = process.env.NEXT_PUBLIC_CHAINLINK_FEED_BTC;
  if (mon) feeds["MON/AUSD"] = mon.toLowerCase();
  if (sol) feeds["SOL/AUSD"] = sol.toLowerCase();
  if (btc) feeds["BTC/AUSD"] = btc.toLowerCase();
  if (!wsUrl || Object.keys(feeds).length === 0) return null;
  return { wsUrl, feeds };
}

// ---- report decoding --------------------------------------------------------

export interface DecodedReport {
  feedId: string;
  observationsTimestamp: number; // seconds
  price: number;
}

const TWO_255 = BigInt(2) ** BigInt(255);
const TWO_256 = BigInt(2) ** BigInt(256);
const E12 = BigInt(10) ** BigInt(12);

function word(hex: string, i: number): string {
  return hex.slice(i * 64, (i + 1) * 64);
}

function int256(w: string): bigint {
  const v = BigInt("0x" + w);
  return v >= TWO_255 ? v - TWO_256 : v;
}

/** Decode a v2/v3 Data Streams `fullReport` (18-decimals benchmark price). */
export function decodeFullReport(fullReport: string): DecodedReport | null {
  const hex = fullReport.startsWith("0x") ? fullReport.slice(2) : fullReport;
  if (hex.length < 64 * 5) return null;
  // Head: reportContext (3 words, static) then offset of reportBlob.
  const blobOffsetWords = Number(BigInt("0x" + word(hex, 3))) / 32;
  const blobLen = Number(BigInt("0x" + word(hex, blobOffsetWords)));
  const blob = hex.slice((blobOffsetWords + 1) * 64, (blobOffsetWords + 1) * 64 + blobLen * 2);
  if (blob.length < 64 * 7) return null;

  const feedId = "0x" + word(blob, 0);
  const version = parseInt(feedId.slice(2, 6), 16);
  if (version !== 2 && version !== 3) return null; // other schemas (RWA, etc.) not handled

  const observationsTimestamp = Number(BigInt("0x" + word(blob, 2)));
  // Keep 6 decimals of precision before converting to a JS number.
  const price = Number(int256(word(blob, 6)) / E12) / 1e6;
  return { feedId, observationsTimestamp, price };
}

// ---- source -----------------------------------------------------------------

export class ChainlinkStreamsSource implements PriceSource {
  readonly kind = "chainlink" as const;
  private readonly bySymbol: Map<string, MarketSymbol>;

  constructor(private readonly config: ChainlinkConfig) {
    this.bySymbol = new Map();
    for (const s of MARKETS) {
      const id = config.feeds[s];
      if (id) this.bySymbol.set(id, s);
    }
  }

  private url(): string {
    const ids = [...this.bySymbol.keys()].join(",");
    const sep = this.config.wsUrl.includes("?") ? "&" : "?";
    return `${this.config.wsUrl}${sep}feedIDs=${ids}`;
  }

  private toTick(msg: unknown): PriceTick | null {
    if (!msg || typeof msg !== "object") return null;
    const m = msg as Record<string, unknown>;

    // Raw Data Streams frame.
    const report = m.report as { feedID?: string; fullReport?: string } | undefined;
    if (report?.fullReport) {
      const d = decodeFullReport(report.fullReport);
      const symbol = d && this.bySymbol.get((report.feedID ?? d.feedId).toLowerCase());
      if (!d || !symbol || !(d.price > 0)) return null;
      return {
        symbol,
        price: d.price,
        timestamp: d.observationsTimestamp * 1000,
        source: "chainlink",
      };
    }

    // Relay-decoded frame.
    if (typeof m.feedID === "string" && typeof m.price === "number") {
      const symbol = this.bySymbol.get(m.feedID.toLowerCase());
      if (!symbol || !(m.price > 0)) return null;
      const ts =
        typeof m.observationsTimestamp === "number"
          ? m.observationsTimestamp * 1000
          : typeof m.timestamp === "number"
            ? m.timestamp
            : Date.now();
      return { symbol, price: m.price, timestamp: ts, source: "chainlink" };
    }
    return null;
  }

  start(onTick: TickHandler): () => void {
    let ws: WebSocket | null = null;
    let stopped = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (stopped) return;
      try {
        ws = new WebSocket(this.url());
      } catch {
        schedule();
        return;
      }
      ws.onopen = () => {
        retry = 0;
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        try {
          const tick = this.toTick(JSON.parse(ev.data));
          if (tick) onTick(tick);
        } catch {
          /* ignore malformed frame */
        }
      };
      ws.onclose = () => schedule();
      ws.onerror = () => ws?.close();
    };

    const schedule = () => {
      if (stopped) return;
      const delay = Math.min(15_000, 500 * 2 ** retry++);
      timer = setTimeout(connect, delay);
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }
}
