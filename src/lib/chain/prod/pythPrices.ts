// Production display prices: Pyth.
//
// Primary: Hermes "latest" for the markets' feeds, polled through the keeper's
// `/hermes` proxy (it holds the Pyth API key; the browser never sees it) - or
// NEXT_PUBLIC_PYTH_HERMES_URL if set (with an SSE stream). The Pyth price
// *stored* on chain can be minutes old on Monad mainnet, so it is only the
// fallback: the clearinghouse's `latestPrice(market)` every block when the
// proxy is unreachable. Display only - transaction price data is chosen in
// priceUpdate.ts.

import type { Address, Hex } from "viem";
import type { MarketSymbol, PriceTick } from "../../types";
import { subscribeBlocks } from "../clients";
import { PYTH_HERMES_URL } from "../config";
import { updateBaseUrl } from "./priceUpdate";
import { priceToNumber } from "../units";
import type { PriceSource, TickHandler } from "../../prices/source";
import { prodAbi } from "./abi";
import { readLoose } from "./state";

interface RawPrice {
  price?: string;
  conf?: string;
  expo?: number;
  publish_time?: number;
}

interface RawUpdate {
  parsed?: Array<{ id?: string; price?: RawPrice }>;
}

interface ParsedPrice {
  id: Hex;
  price: number;
  conf: number;
  publishTime: number;
}

const normFeedId = (id: string): Hex => (id.startsWith("0x") ? id.toLowerCase() : `0x${id.toLowerCase()}`) as Hex;

function scaled(v: string | undefined, expo: number | undefined): number {
  if (v === undefined || expo === undefined) return Number.NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n * 10 ** expo : Number.NaN;
}

function parsePrices(raw: RawUpdate): ParsedPrice[] {
  const out: ParsedPrice[] = [];
  for (const p of raw.parsed ?? []) {
    if (!p.id || !p.price) continue;
    const price = scaled(p.price.price, p.price.expo);
    if (!(price > 0)) continue;
    out.push({
      id: normFeedId(p.id),
      price,
      conf: Math.abs(scaled(p.price.conf, p.price.expo)) || 0,
      publishTime: Number(p.price.publish_time ?? 0),
    });
  }
  return out;
}

const query = (ids: readonly string[]) => ids.map((id) => `ids[]=${encodeURIComponent(normFeedId(id))}`).join("&");

// ---- which source is live (for the badge) ----------------------------------------

export type PythFeedMode = "hermes" | "onchain" | "connecting";

let feedMode: PythFeedMode = "connecting";
const modeListeners = new Set<() => void>();
function setMode(m: PythFeedMode) {
  if (m === feedMode) return;
  feedMode = m;
  modeListeners.forEach((l) => l());
}
export function getPythFeedMode(): PythFeedMode {
  return feedMode;
}
export function subscribePythFeedMode(l: () => void): () => void {
  modeListeners.add(l);
  return () => modeListeners.delete(l);
}

export interface PythSourceConfig {
  feeds: Partial<Record<MarketSymbol, Hex>>;
  clearinghouse: Address;
  markets: Record<MarketSymbol, Hex>;
  /** The deployment's listed markets: the only ones priced (an unlisted market has no feed on chain). */
  listed: readonly MarketSymbol[];
}

const POLL_MS = 2_000;

/**
 * Production price source: Hermes "latest" via the keeper's proxy (polled; an
 * SSE stream when NEXT_PUBLIC_PYTH_HERMES_URL is set), falling back to the
 * Pyth price stored on chain (`latestPrice`, every block) if it fails.
 * Ticks carry Pyth's publish time.
 */
export class PythPriceSource implements PriceSource {
  readonly kind = "pyth" as const;
  private readonly byId = new Map<string, MarketSymbol>();
  /** Latest confidence per market (±, price units) for the UI. */
  static readonly conf = new Map<MarketSymbol, number>();

  constructor(private readonly cfg: PythSourceConfig) {
    for (const s of cfg.listed) {
      const id = cfg.feeds[s];
      if (id) this.byId.set(normFeedId(id), s);
    }
  }

  start(onTick: TickHandler): () => void {
    let stopped = false;
    setMode("connecting");
    const last = new Map<MarketSymbol, string>();
    const emitOne = (symbol: MarketSymbol, price: number, conf: number, publishTime: number, block?: number) => {
      const key = `${price}:${publishTime}`;
      if (last.get(symbol) === key) return;
      last.set(symbol, key);
      PythPriceSource.conf.set(symbol, conf);
      const tick: PriceTick = { symbol, price, timestamp: publishTime * 1000, source: "pyth", block };
      onTick(tick);
    };

    // On-chain stored Pyth price (default).
    let offChain: (() => void) | null = null;
    const startOnchain = () => {
      if (stopped || offChain) return;
      setMode("onchain");
      let busy = false;
      offChain = subscribeBlocks((b) => {
        if (busy) return;
        busy = true;
        const listed = this.cfg.listed;
        readLoose(
          listed.map((m) => ({
            address: this.cfg.clearinghouse,
            abi: prodAbi,
            functionName: "latestPrice",
            args: [this.cfg.markets[m]],
          })),
        )
          .then((res) => {
            res.forEach((r, i) => {
              if (r.status !== "success" || !Array.isArray(r.result)) return;
              const [price, conf, publishTime] = r.result as [bigint, bigint, bigint];
              if (price <= BigInt(0)) return;
              emitOne(listed[i], priceToNumber(price), priceToNumber(conf), Number(publishTime), Number(b));
            });
          })
          .catch(() => undefined)
          .finally(() => {
            busy = false;
          });
      });
    };

    const base = updateBaseUrl();
    const ids = this.cfg.listed.map((s) => this.cfg.feeds[s]).filter((x): x is Hex => !!x);
    if (!base || ids.length === 0) {
      startOnchain();
      return () => {
        stopped = true;
        offChain?.();
      };
    }

    const emit = (prices: ParsedPrice[]) => {
      for (const p of prices) {
        const symbol = this.byId.get(p.id);
        if (symbol) emitOne(symbol, p.price, p.conf, p.publishTime);
      }
    };

    // Configured Hermes-compatible display feed: polling, giving up to on-chain after failures.
    let poll: ReturnType<typeof setTimeout> | undefined;
    let polling = false;
    const startPolling = () => {
      if (polling) return;
      polling = true;
      let failures = 0;
      const run = async () => {
        if (stopped) return;
        try {
          const r = await fetch(`${base}/v2/updates/price/latest?${query(ids)}&parsed=true&encoding=hex`, {
            cache: "no-store",
          });
          if (!r.ok) throw new Error(String(r.status));
          emit(parsePrices((await r.json()) as RawUpdate));
          failures = 0;
          setMode("hermes");
        } catch {
          if (++failures >= 2) {
            startOnchain();
            return;
          }
        }
        if (!stopped) poll = setTimeout(run, POLL_MS);
      };
      void run();
    };

    // SSE stream first when an explicit Hermes URL is configured (the keeper's proxy has none).
    let es: EventSource | null = null;
    if (PYTH_HERMES_URL && typeof EventSource !== "undefined") {
      let got = false;
      let errors = 0;
      es = new EventSource(`${base}/v2/updates/price/stream?${query(ids)}&parsed=true`);
      es.onmessage = (e) => {
        got = true;
        errors = 0;
        setMode("hermes");
        try {
          emit(parsePrices(JSON.parse(e.data as string) as RawUpdate));
        } catch {
          /* malformed event: skip */
        }
      };
      es.onerror = () => {
        errors++;
        if (!got || errors >= 3) {
          es?.close();
          es = null;
          if (!stopped) startPolling();
        }
      };
    } else {
      startPolling();
    }

    return () => {
      stopped = true;
      es?.close();
      if (poll) clearTimeout(poll);
      offChain?.();
    };
  }
}
