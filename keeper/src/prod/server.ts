// Production keeper HTTP API (JSON, CORS restricted to KEEPER_CORS_ORIGIN).
//
//   GET  /health                       production status (see healthJson)
//   GET  /livez                        200 while the head poller advances (≤ 60 s), else 503 —
//                                      for the platform's restart health check only
//   GET  /orders?account=0x…           orders the executor tracks (all, or one account's)
//   GET  /orders/:id                   one order
//   GET  /solvency                     solvency() + every lane's ledger, at one block
//   GET  /backstop[?lp=0x…]            per-lane backstop pool NAV / stats / positions
//   GET  /alerts                       active alerts + the last 50 events
//   GET  /txs                          last 100 keeper txs + gas per kind
//   GET  /hermes/v2/updates/price/latest?ids[]=…       Hermes proxy for the app (the API key stays
//   GET  /hermes/v2/updates/price/{publish_time}?ids[]=…  on the server; only this deployment's
//                                                      feeds; cached HERMES_PROXY_CACHE_MS; rate-limited)
//   POST /faucet, /crash, /recover, /price-loop, /demo-takers, GET /runs…  → 403: the demo
//        endpoints do not exist in production (no faucet, no price pusher, no synthetic crash,
//        no demo bots).
//   POST /drip {address}               testnet visitor gas drip (drip.ts): DRIP_AMOUNT_MON once per
//                                      fresh address; errors are {error, code}. GET /drip/:address
//                                      polls its status. Off without DRIP_PRIVATE_KEY, never on mainnet.
//   POST /faucet {address}  ONLY in the local sandbox (SANDBOX_FAUCET=1, refused unless the chain
//        is an anvil fork): fork MON + testnet AUSD (sandbox-faucet.ts).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { clearinghouseAbi } from "./abi";
import { LANES } from "./config";
import { short, type ProdContext } from "./context";
import type { OrderExecutor } from "./executor";
import { orderJson } from "./executor";
import type { FundingUpdater } from "./funding";
import type { HeadWatcher } from "./head";
import type { Monitor } from "./monitor";
import type { FallbackPrepush } from "./oracle-switch";
import type { PoolExitHelper } from "./poolexit";
import type { PricePusher } from "./pricepush";
import type { ProdSweeper } from "./sweeper";
import { DripError, type GasDrip } from "./drip";
import { SandboxFaucet, SandboxFaucetError } from "./sandbox-faucet";
import { txJson, type TxLedger } from "./tx";

export interface ProdDeps {
  ctx: ProdContext;
  heads: HeadWatcher;
  executor: OrderExecutor;
  funding: FundingUpdater;
  sweeper: ProdSweeper;
  monitor: Monitor;
  ledger: TxLedger;
  pusher: PricePusher;
  poolExit: PoolExitHelper;
  prepush?: FallbackPrepush;
  drip?: GasDrip;
}

const DISABLED = /^\/(faucet|crash|recover|price-loop|demo-takers|runs)(\/|$)/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

function cors(req: IncomingMessage, allowed: string[]): Record<string, string> {
  const origin = req.headers.origin;
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
  if (allowed.includes("*")) h["Access-Control-Allow-Origin"] = "*";
  else if (origin && allowed.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string>): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

function networkOf(ctx: ProdContext): string {
  return ctx.chain.fork ? "anvil" : ctx.chain.profile.slug;
}

export function healthJson(d: ProdDeps, faucet: SandboxFaucet | null = null) {
  const { ctx, monitor, executor, funding, sweeper, heads, ledger } = d;
  const snap = monitor.snapshot;
  const prices = snap?.prices ?? {};
  const p = ctx.chain.profile;
  return {
    chainId: ctx.chain.chainId,
    mode: p.slug,
    network: networkOf(ctx),
    fork: ctx.chain.fork ? { of: p.slug, chainId: ctx.chain.chainId } : null,
    /** The local sandbox (an anvil fork with the sandbox faucet): never "live". */
    sandbox: ctx.config.sandboxFaucet,
    testnet: !p.realValue,
    label: ctx.chain.label,
    production: true,
    block: heads.head?.number ?? null,
    chainTime: heads.head?.timestamp ?? null,
    paused: snap?.paused ?? null,
    /** "pyth" (Wormhole-signed Pyth updates) or "keeper-signed" (testnet fallback after the Pyth trial). */
    priceSource: ctx.dep.oracle === "keeper-signed" ? "keeper-signed" : "pyth",
    prices: Object.fromEntries(Object.entries(prices).map(([s, p]) => [s, p?.price ?? null])),
    pricesUpdatedAt: Object.fromEntries(Object.entries(prices).map(([s, p]) => [s, p?.publishTime ?? null])),
    oracle: {
      mode: ctx.dep.oracle,
      pyth: ctx.dep.pyth,
      realPyth: ctx.dep.realPyth,
      fallbackOracle: ctx.dep.fallbackOracle,
      signer: ctx.sources.signed?.status() ?? null,
      prepush: d.prepush?.status() ?? null,
      feeds: ctx.dep.feeds,
      maxConfBps: ctx.params.maxConfBps,
      maxPriceAge: ctx.params.maxPriceAge,
      prices,
      hermes: ctx.hermes.status(),
    },
    caps: snap?.caps ?? null,
    solvency: snap?.solvency ?? null,
    laneSolvency: snap?.laneSolvency ?? null,
    nativeSolvency: snap?.nativeSolvency ?? null,
    storedPriceAgeS: snap?.storedPriceAgeS ?? null,
    poolDeposits: snap?.poolDeposits ?? null,
    pricePush: d.pusher.status(),
    reserveGuard: ctx.reserve.status(),
    poolExit: d.poolExit.status(),
    addresses: {
      clearinghouse: ctx.dep.clearinghouse,
      ausd: ctx.dep.ausd,
      oracle: ctx.dep.pyth,
      pyth: ctx.dep.pyth,
      timelock: ctx.dep.timelock,
      guardian: ctx.roles.guardian?.address ?? ctx.dep.guardian,
      ops: ctx.roles.ops?.address ?? null,
      keepers: ctx.roles.keepers.map((k) => k.address),
      naive: null,
    },
    owner: snap?.owner ?? null,
    ausd: snap?.ausd ?? null,
    markets: ctx.dep.markets,
    hotKeys: snap?.balances ?? [],
    params: ctx.params,
    features: { auctions: true, backstop: true, solvency: true, orders: true },
    executor: executor.status(),
    funding: funding.status(),
    sweeper: sweeper.status(),
    alerts: { webhook: ctx.alerter.configured, active: ctx.alerter.activeAlerts() },
    txs: ledger.summary(),
    monitorAt: snap?.at ?? null,
    monitorErrors: snap?.errors ?? [],
    uptimeS: Math.round((Date.now() - ctx.startedAt) / 1000),
    // Demo-only features, explicitly absent in production (shape kept for older app builds).
    crashed: false,
    activeRunId: null,
    lastRunId: null,
    priceLoop: null,
    faucet: faucet ? faucet.status() : null,
    /** Testnet visitor gas drip (POST /drip). */
    drip: d.drip ? d.drip.healthJson() : { enabled: false, reason: "not wired" },
    demoTakers: null,
    disabled: faucet ? ["crash", "recover", "price-loop", "demo-takers", "runs"] : ["faucet", "crash", "recover", "price-loop", "demo-takers", "runs"],
  };
}

async function solvencyJson(ctx: ProdContext) {
  const blockNumber = await ctx.chain.client.getBlockNumber();
  const read = <T>(fn: string, args: unknown[] = []) =>
    ctx.chain.client.readContract({ address: ctx.dep.clearinghouse, abi: clearinghouseAbi as never, functionName: fn as never, args: args as never, blockNumber }) as Promise<T>;
  const [sol, nat, ledgers, lanesSol] = await Promise.all([
    read<readonly [bigint, bigint, bigint, boolean]>("solvency"),
    read<readonly [bigint, bigint, boolean]>("nativeSolvency"),
    Promise.all(Array.from({ length: LANES }, (_, lane) => read<readonly bigint[]>("laneLedger", [lane]))),
    Promise.all(Array.from({ length: LANES }, (_, lane) => read<readonly bigint[]>("laneSolvency", [lane]))),
  ]);
  return {
    chainId: ctx.chain.chainId,
    network: networkOf(ctx),
    block: Number(blockNumber),
    design: "paraclr-lanes",
    contract: ctx.dep.clearinghouse,
    sharedState: false,
    ausdHeld: sol[0].toString(),
    liabilities: sol[1].toString(),
    surplus: sol[2].toString(),
    solvent: sol[3],
    native: { held: nat[0].toString(), liabilities: nat[1].toString(), solvent: nat[2] },
    lanes: ledgers.map((l, lane) => ({
      lane,
      collateral: l[0]?.toString(),
      insurance: l[1]?.toString(),
      backstopCash: l[2]?.toString(),
      keeperRewards: l[3]?.toString(),
      badDebt: l[4]?.toString(),
      nativeEscrow: l[5]?.toString(),
      nativeOwed: l[6]?.toString(),
      // v2 per-lane solvency: held vs realised claims; surplus < 0 = deficit, withdrawals haircut
      held: lanesSol[lane][0]?.toString(),
      claims: lanesSol[lane][1]?.toString(),
      surplus: lanesSol[lane][2]?.toString(),
      haircutBps: Number(lanesSol[lane][5] ?? 0),
      solvent: (lanesSol[lane][2] ?? BigInt(0)) >= BigInt(0),
    })),
  };
}

async function backstopJson(ctx: ProdContext, lpRaw: string | null) {
  let lp: Address | null = null;
  if (lpRaw) {
    if (!isAddress(lpRaw)) throw new HttpError(400, "lp must be an address");
    lp = getAddress(lpRaw);
  }
  const blockNumber = await ctx.chain.client.getBlockNumber();
  const read = <T>(fn: string, args: unknown[] = []) =>
    ctx.chain.client.readContract({ address: ctx.dep.clearinghouse, abi: clearinghouseAbi as never, functionName: fn as never, args: args as never, blockNumber }) as Promise<T>;
  const symbolOf = new Map(ctx.markets.map((m) => [m.id.toLowerCase(), m.symbol]));
  const lanes = await Promise.all(
    Array.from({ length: LANES }, async (_, lane) => {
      const [nav, stats, pos, minBps, shares, receivable, request] = await Promise.all([
        read<readonly bigint[]>("backstopNav", [lane]),
        read<readonly bigint[]>("backstopStats", [lane]),
        read<readonly [readonly Hex[], readonly bigint[], readonly bigint[]]>("backstopPositions", [lane]),
        read<bigint>("backstopMinDiscountBps", [lane]).catch(() => null),
        lp ? read<bigint>("backstopSharesOf", [lane, lp]) : Promise.resolve(null),
        read<bigint>("backstopReceivable", [lane]).catch(() => null), // v3: pool cash lent to the loss waterfall
        lp ? read<readonly bigint[]>("backstopWithdrawRequest", [lane, lp]).catch(() => null) : Promise.resolve(null),
      ]);
      return {
        lane,
        nav: { equity: nav[0].toString(), cash: nav[1].toString(), unrealizedPnl: nav[2].toString(), shareSupply: nav[3].toString() },
        stats: { taken: Number(stats[0]), discountEarned: stats[1].toString(), notionalAbsorbed: stats[2].toString() },
        positions: pos[0].map((market, i) => ({ market, symbol: symbolOf.get(market.toLowerCase()) ?? null, signedSize: pos[1][i].toString(), entryPrice: pos[2][i].toString() })),
        minDiscountBps: minBps === null ? null : Number(minBps),
        receivable: receivable === null ? null : receivable.toString(),
        ...(lp ? { lpShares: (shares as bigint).toString(), withdrawRequest: request ? { shares: request[0].toString(), readyAt: Number(request[1]), expiresAt: Number(request[2]) } : null } : {}),
      };
    }),
  );
  const sum = (f: (l: (typeof lanes)[number]) => string) => lanes.reduce((s, l) => s + BigInt(f(l)), BigInt(0)).toString();
  return {
    chainId: ctx.chain.chainId,
    network: networkOf(ctx),
    block: Number(blockNumber),
    design: "paraclr-lanes",
    contract: ctx.dep.clearinghouse,
    sharedState: false,
    auction: { stepBps: ctx.params.auctionStepBps, maxDiscountBps: ctx.params.auctionMaxDiscountBps, source: "contract" },
    totals: {
      equity: sum((l) => l.nav.equity),
      cash: sum((l) => l.nav.cash),
      unrealizedPnl: sum((l) => l.nav.unrealizedPnl),
      taken: lanes.reduce((n, l) => n + l.stats.taken, 0),
      discountEarned: sum((l) => l.stats.discountEarned),
      notionalAbsorbed: sum((l) => l.stats.notionalAbsorbed),
    },
    lanes,
    ...(lp ? { lp } : {}),
  };
}

// ---------------------------------------------------------------------------
// Hermes proxy (the browser can't hold the API key)
// ---------------------------------------------------------------------------

class HermesProxy {
  private readonly cache = new Map<string, { at: number; body: unknown }>();
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly ctx: ProdContext) {}

  /** This deployment's CURRENT feeds (a timelocked feed swap updates ctx.markets). */
  private get allowed(): Set<string> {
    return new Set(this.ctx.markets.map((m) => m.feed.toLowerCase()));
  }

  limit(ip: string): void {
    const now = Date.now();
    const b = this.buckets.get(ip) ?? { tokens: 20, at: now };
    b.tokens = Math.min(20, b.tokens + ((now - b.at) / 1000) * 5); // 5 req/s sustained, burst 20
    b.at = now;
    if (b.tokens < 1) throw new HttpError(429, "rate limited");
    b.tokens -= 1;
    this.buckets.set(ip, b);
    if (this.buckets.size > 10_000) this.buckets.clear();
  }

  async get(path: string, url: URL): Promise<unknown> {
    const ids = url.searchParams.getAll("ids[]").map((i) => (i.startsWith("0x") ? i : `0x${i}`).toLowerCase() as Hex);
    if (ids.length === 0 || ids.length > 8) throw new HttpError(400, "ids[] required (1–8)");
    const bad = ids.filter((i) => !this.allowed.has(i));
    if (bad.length) throw new HttpError(400, `only this deployment's feeds are proxied (${[...this.allowed].join(", ")})`);
    const m = /^\/hermes\/v2\/updates\/price\/(latest|\d+)$/.exec(path);
    if (!m) throw new HttpError(404, "proxied routes: /hermes/v2/updates/price/latest and /hermes/v2/updates/price/{publish_time}");
    const key = `${m[1]}|${[...ids].sort().join(",")}`;
    const hit = this.cache.get(key);
    const ttl = m[1] === "latest" ? this.ctx.config.hermesProxyCacheMs : 60_000;
    if (hit && Date.now() - hit.at < ttl) return hit.body;
    const u = m[1] === "latest" ? await this.ctx.hermes.latest(ids) : await this.ctx.hermes.firstAtOrAfter(Number(m[1]), ids);
    if (!u) throw new HttpError(404, "no update at/after publish_time yet");
    const body = {
      binary: { encoding: "hex", data: u.data.map((d) => d.slice(2)) },
      parsed: ids.map((id) => {
        const msg = u.messages.get(id)!;
        return {
          id: id.slice(2),
          price: { price: msg.price.toString(), conf: msg.conf.toString(), expo: msg.expo, publish_time: msg.publishTime },
          ema_price: { price: msg.emaPrice.toString(), conf: msg.emaConf.toString(), expo: msg.expo, publish_time: msg.publishTime },
          metadata: { prev_publish_time: msg.prevPublishTime },
        };
      }),
    };
    this.cache.set(key, { at: Date.now(), body });
    if (this.cache.size > 1_000) this.cache.clear();
    return body;
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c: Buffer) => {
      raw += c.toString();
      if (raw.length > 10_000) {
        // Oversized body: drop it and answer as an empty body (the route then rejects it) instead
        // of leaving the handler pending forever.
        req.destroy();
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

export function startProdServer(d: ProdDeps): Server {
  const { ctx, executor, ledger } = d;
  const proxy = new HermesProxy(ctx);
  const faucet = ctx.config.sandboxFaucet ? new SandboxFaucet(ctx) : null;
  const server = createServer(async (req, res) => {
    const h = cors(req, ctx.config.corsOrigins);
    const url = new URL(req.url ?? "/", "http://keeper.local");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, h);
        res.end();
        return;
      }
      if (faucet && path === "/faucet" && req.method === "POST") {
        const body = (await readBody(req)) as { address?: unknown };
        try {
          return send(res, 200, await faucet.drip(body.address), h);
        } catch (err) {
          if (err instanceof SandboxFaucetError) throw new HttpError(err.status, err.message);
          throw err;
        }
      }
      if (path === "/drip" && req.method === "POST") {
        if (!d.drip) throw new HttpError(403, "The gas drip is off on this keeper.", "disabled");
        const body = (await readBody(req)) as { address?: unknown };
        try {
          return send(res, 200, await d.drip.request(body.address, d.drip.clientIp(req)), h);
        } catch (err) {
          if (err instanceof DripError) throw new HttpError(err.status, err.message, err.code);
          throw err;
        }
      }
      if (DISABLED.test(path)) {
        throw new HttpError(
          403,
          `disabled in production (${ctx.chain.profile.label}): no faucet, no price pusher, no synthetic crash and no demo bots exist here. The X-ray evidence is from recorded testnet/anvil runs.`,
        );
      }
      if (req.method !== "GET") throw new HttpError(405, `${req.method} not allowed`);
      if (path === "/health" || path === "/") return send(res, 200, healthJson(d, faucet), h);
      if (path === "/livez") {
        const st = d.heads.status();
        const ok = st.head !== null && (st.lagMs ?? Infinity) < 60_000;
        return send(res, ok ? 200 : 503, { ok, block: st.head?.number ?? null, lagMs: st.lagMs }, h);
      }
      if (path === "/orders") {
        const acct = url.searchParams.get("account");
        if (acct && !isAddress(acct)) throw new HttpError(400, "account must be an address");
        const list = [...executor.orders.values()].filter((o) => !acct || o.account.toLowerCase() === acct.toLowerCase());
        return send(res, 200, list.slice(-200).map(orderJson), h);
      }
      const om = /^\/orders\/(\d+)$/.exec(path);
      if (om) {
        const o = executor.orders.get(om[1]);
        if (!o) throw new HttpError(404, `order ${om[1]} not tracked by this keeper`);
        return send(res, 200, orderJson(o), h);
      }
      const dm = /^\/drip\/(0x[0-9a-fA-F]{40})$/.exec(path);
      if (dm) {
        if (!d.drip) throw new HttpError(403, "The gas drip is off on this keeper.", "disabled");
        return send(res, 200, d.drip.status(dm[1]), h);
      }
      if (path === "/solvency") return send(res, 200, await solvencyJson(ctx), h);
      if (path === "/backstop") return send(res, 200, await backstopJson(ctx, url.searchParams.get("lp")), h);
      if (path === "/alerts") return send(res, 200, ctx.alerter.status(), h);
      if (path === "/txs") return send(res, 200, { byKind: ledger.summary(), recent: ledger.recent.slice(-100).map(txJson) }, h);
      if (path.startsWith("/hermes/")) {
        if (!ctx.config.hermesProxy) throw new HttpError(404, "Hermes proxy disabled (HERMES_PROXY=0)");
        proxy.limit((req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.socket.remoteAddress || "?");
        return send(res, 200, await proxy.get(path, url), { ...h, "cache-control": "public, max-age=1" });
      }
      throw new HttpError(404, `no route ${req.method} ${path}`);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, err.code ? { error: err.message, code: err.code } : { error: err.message }, h);
      const msg = short(err);
      console.error(`[http] ${req.method} ${path} failed: ${msg}`);
      return send(res, 502, { error: msg }, h);
    }
  });
  server.listen(ctx.config.port, process.env.KEEPER_BIND ?? (ctx.chain.fork ? "127.0.0.1" : "0.0.0.0"));
  return server;
}
