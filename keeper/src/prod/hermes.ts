// Pyth Hermes client: signed price-update data for order execution, auctions and withdraw-time
// health checks.
//
// Endpoints (Hermes v2; routes unchanged by the 2026-08-26 "Pyth Core upgrade"):
//   GET /v2/updates/price/latest?ids[]=…&encoding=hex&parsed=true
//   GET /v2/updates/price/{publish_time}?ids[]=…&encoding=hex&parsed=true
//       → the FIRST update with publish_time ≥ the given time (what parsePriceFeedUpdatesUnique
//         needs: its prevPublishTime is < the requested time). 404 while it doesn't exist yet.
// Since 2026-08-26 Hermes answers 401 without an API key: `Authorization: Bearer $PYTH_API_KEY`
// (docs.pyth.network/price-feeds/core/upgrade/preparing).
//
// Outages: every call retries transient failures (network, 5xx, 429) with exponential backoff +
// jitter, then tries each PYTH_HERMES_FALLBACK_URLS endpoint. After a failed round the client
// backs off globally (circuit breaker) so the per-block loops don't hammer a dead endpoint.
// Alerts: `hermes:auth` (401/403 — key missing/expired; critical), `hermes:down` (no successful
// response for HERMES_OUTAGE_ALERT_MS; critical), resolved automatically on recovery.
//
// Every blob is parsed locally (pyth-wire.ts) so callers can check publish times and confidence
// before sending a tx. If a blob is not Pyth wire format (the rehearsal's MockPyth leg), the
// response's `parsed` section is used instead and `parsedLocally` is false.

import type { Hex } from "viem";
import { envStr } from "../env";
import type { Alerter } from "./alerts";
import { envNum } from "./config";
import { parseAccumulatorUpdate, type PriceMessage } from "./pyth-wire";

export interface PriceUpdate {
  /** Update blobs to pass to the contract (`bytes[] priceUpdate`). */
  data: Hex[];
  /** Price messages by lowercase feed id. */
  messages: Map<string, PriceMessage>;
  parsedLocally: boolean;
  /** Host that served it (no path/query, so no key leaks). */
  source: string;
  fetchedAt: number;
}

export class HermesError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly transient: boolean,
  ) {
    super(message);
  }
}

interface HermesJson {
  binary?: { encoding?: string; data?: string[] };
  parsed?: Array<{
    id: string;
    price: { price: string; conf: string; expo: number; publish_time: number };
    ema_price?: { price: string; conf: string; expo: number; publish_time: number };
    metadata?: { prev_publish_time?: number; slot?: number };
  }>;
}

export interface HermesOptions {
  urls: string[];
  apiKey?: string;
  timeoutMs: number;
  /** Attempts per endpoint per call (transient errors only). */
  attempts: number;
  outageAlertMs: number;
  alerter?: Alerter;
}

export function hermesOptionsFromEnv(alerter?: Alerter): HermesOptions {
  const primary = envStr("PYTH_HERMES_URL") ?? "https://hermes.pyth.network";
  const fallbacks = (envStr("PYTH_HERMES_FALLBACK_URLS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    urls: [primary, ...fallbacks],
    apiKey: envStr("PYTH_API_KEY"),
    timeoutMs: envNum("HERMES_TIMEOUT_MS", 4_000),
    attempts: Math.max(1, envNum("HERMES_ATTEMPTS", 3)),
    outageAlertMs: envNum("HERMES_OUTAGE_ALERT_MS", 30_000),
    alerter,
  };
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

export class HermesClient {
  private consecutiveFailures = 0;
  private lastSuccessAt: number | null = null;
  private firstFailureAt: number | null = null;
  private lastError: string | null = null;
  private breakerUntil = 0;
  private requests = 0;
  private failures = 0;

  constructor(private readonly opts: HermesOptions) {
    if (opts.urls.length === 0) throw new Error("no Hermes URL configured (PYTH_HERMES_URL)");
  }

  /** Latest signed update for `ids` (liquidations, withdraw checks, monitoring). */
  latest(ids: readonly Hex[]): Promise<PriceUpdate> {
    return this.get("/v2/updates/price/latest", ids).then((u) => {
      if (!u) throw new HermesError("Hermes returned no update", 404, true);
      return u;
    });
  }

  /**
   * The first update with publishTime ≥ `publishTime` for every id, or null if Hermes doesn't
   * have one yet (404). Order execution uses this with commitTime + MIN_EXEC_DELAY.
   */
  firstAtOrAfter(publishTime: number, ids: readonly Hex[]): Promise<PriceUpdate | null> {
    return this.get(`/v2/updates/price/${Math.floor(publishTime)}`, ids);
  }

  status() {
    const now = Date.now();
    return {
      endpoints: this.opts.urls.map(host),
      apiKey: Boolean(this.opts.apiKey),
      healthy: this.consecutiveFailures === 0 && this.lastSuccessAt !== null,
      consecutiveFailures: this.consecutiveFailures,
      lastSuccessAt: this.lastSuccessAt,
      outageMs: this.firstFailureAt ? now - this.firstFailureAt : 0,
      backoffMs: Math.max(0, this.breakerUntil - now),
      lastError: this.lastError,
      requests: this.requests,
      failures: this.failures,
    };
  }

  private async get(path: string, ids: readonly Hex[]): Promise<PriceUpdate | null> {
    if (ids.length === 0) throw new Error("no feed ids");
    const wait = this.breakerUntil - Date.now();
    if (wait > 0) {
      throw new HermesError(`Hermes backing off for ${wait} ms after ${this.consecutiveFailures} failures (${this.lastError})`, null, true);
    }
    const qs = new URLSearchParams();
    for (const id of ids) qs.append("ids[]", id);
    qs.set("encoding", "hex");
    qs.set("parsed", "true");
    let last: HermesError | null = null;
    for (const base of this.opts.urls) {
      for (let attempt = 0; attempt < this.opts.attempts; attempt++) {
        if (attempt > 0) await sleep(Math.min(4_000, 200 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5));
        try {
          const out = await this.fetchOnce(`${base.replace(/\/+$/, "")}${path}?${qs.toString()}`, ids);
          this.ok();
          return out;
        } catch (err) {
          last = err instanceof HermesError ? err : new HermesError((err as Error)?.message ?? String(err), null, true);
          if (!last.transient) break; // 4xx other than 404/429: next endpoint, no retry
        }
      }
    }
    this.fail(last ?? new HermesError("unknown Hermes failure", null, true));
    throw last;
  }

  private async fetchOnce(url: string, ids: readonly Hex[]): Promise<PriceUpdate | null> {
    this.requests++;
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(this.opts.timeoutMs) });
    } catch (err) {
      throw new HermesError(`${host(url)}: ${(err as Error)?.name === "TimeoutError" ? "timeout" : ((err as Error)?.message ?? err)}`, null, true);
    }
    // Every early return below releases the unread body: an unconsumed fetch body keeps its
    // connection buffers alive outside the JS heap.
    if (res.status === 404) {
      void res.body?.cancel().catch(() => undefined);
      return null; // not published yet (publish_time route) — not a failure
    }
    if (res.status === 401 || res.status === 403) {
      void res.body?.cancel().catch(() => undefined);
      this.opts.alerter?.fire(
        "hermes:auth",
        "critical",
        `Hermes ${host(url)} answered ${res.status}: PYTH_API_KEY is ${this.opts.apiKey ? "rejected/expired" : "missing"}. Orders cannot execute and auctions cannot start until this is fixed.`,
      );
      throw new HermesError(`${host(url)}: HTTP ${res.status} (API key ${this.opts.apiKey ? "rejected" : "missing"})`, res.status, false);
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      const transient = res.status === 429 || res.status >= 500;
      throw new HermesError(`${host(url)}: HTTP ${res.status}`, res.status, transient);
    }
    this.opts.alerter?.resolve("hermes:auth");
    const body = (await res.json()) as HermesJson;
    const data = (body.binary?.data ?? []).map((d) => (d.startsWith("0x") ? d : `0x${d}`) as Hex);
    if (data.length === 0) throw new HermesError(`${host(url)}: empty binary.data`, res.status, true);
    return decode(data, body, ids, host(url));
  }

  private ok(): void {
    if (this.firstFailureAt !== null) {
      this.opts.alerter?.resolve("hermes:down", `Hermes reachable again (${this.opts.urls.map(host).join(", ")})`);
    }
    this.consecutiveFailures = 0;
    this.firstFailureAt = null;
    this.breakerUntil = 0;
    this.lastSuccessAt = Date.now();
  }

  private fail(err: HermesError): void {
    const now = Date.now();
    this.failures++;
    this.consecutiveFailures++;
    this.firstFailureAt ??= now;
    this.lastError = err.message;
    // Circuit breaker: 0.5 s, 1 s, 2 s … capped at 15 s between rounds while it keeps failing.
    this.breakerUntil = now + Math.min(15_000, 500 * 2 ** Math.min(5, this.consecutiveFailures - 1));
    if (now - this.firstFailureAt >= this.opts.outageAlertMs) {
      this.opts.alerter?.fire(
        "hermes:down",
        "critical",
        `Hermes unavailable for ${Math.round((now - this.firstFailureAt) / 1000)} s (${this.consecutiveFailures} failed rounds): ${err.message}. ` +
          "Order execution and auctions are stalled; orders expire after MAX_EXEC_DELAY (users cancel and get escrow back).",
      );
    }
  }
}

function decode(data: Hex[], body: HermesJson, ids: readonly Hex[], source: string): PriceUpdate {
  const messages = new Map<string, PriceMessage>();
  let parsedLocally = true;
  try {
    for (const blob of data) for (const m of parseAccumulatorUpdate(blob).messages) messages.set(m.id, m);
  } catch {
    parsedLocally = false;
    messages.clear();
    for (const p of body.parsed ?? []) {
      const id = (p.id.startsWith("0x") ? p.id : `0x${p.id}`).toLowerCase();
      messages.set(id, {
        id: id as Hex,
        price: BigInt(p.price.price),
        conf: BigInt(p.price.conf),
        expo: p.price.expo,
        publishTime: p.price.publish_time,
        prevPublishTime: p.metadata?.prev_publish_time ?? p.price.publish_time - 1,
        emaPrice: BigInt(p.ema_price?.price ?? p.price.price),
        emaConf: BigInt(p.ema_price?.conf ?? p.price.conf),
      });
    }
  }
  const missing = ids.filter((id) => !messages.has(id.toLowerCase()));
  if (missing.length) throw new HermesError(`${source}: update lacks feed(s) ${missing.join(", ")}`, null, true);
  return { data, messages, parsedLocally, source, fetchedAt: Date.now() };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
