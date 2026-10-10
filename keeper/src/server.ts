// Keeper HTTP API (JSON, CORS). See keeper/README.md for the contract.
//
//   GET  /health                 → { chainId, mode, network, block, addresses, prices, crashed, sweeper, … }
//   POST /faucet {address}       → { gasTxHash, ausdTxHash, gasWei, ausd }
//   POST /crash {bps?, mode?, xray?} → 202 { runId }   (bps default 8000 = −20%)
//   GET  /runs/:runId            → RunReport            (poll until status !== "running")
//   GET  /runs/:runId/xray       → XrayReport           (202 { status: "pending" } while computed)
//   GET  /runs                   → [{ runId, status }]
//   POST /recover                → { txHash, block }
//   GET  /solvency[?design=naive]          → solvency() + per-lane ledgers
//   GET  /backstop[?design=naive&lp=0x…]   → per-lane pool NAV, stats, positions
//   GET  /sweeper                → sweeper status + recent txs
//   POST /price-loop {paused}    → pause/resume price pushes (bench: identical books for both designs)
//   GET  /demo-takers            → the keeper-run demo external takers
//   POST /demo-takers {enabled?, seed?, perLane?, minBps?, maxBps?} → re-derive + fund them (bench)
//
// Arena mode (`--arena` / ARENA=1, keeper/src/arena.ts):
//   GET  /arena                  → cycle state, cooldown, current/last run, book per design per lane, budget
//   POST /arena/crash            → 202 { runId } | 409 { error, code, retryAfterS? }
//   POST /crash, /recover, /price-loop, /demo-takers, /faucet need header x-admin-token = ARENA_ADMIN_TOKEN
//   (refused when it is unset). Every GET stays public.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ArenaRefusal, isAdminRoute, type Arena } from "./arena";
import { readOraclePrices, type KeeperContext } from "./context";
import { BusyError, NotCrashedError, type CrashController } from "./crash";
import { FaucetError, type Faucet } from "./faucet";
import { roleAddresses } from "./network";
import { fromWad, type PriceLoop } from "./prices";
import type { Sweeper } from "./sweeper";
import { createTakers, describeTakers, takerConfig } from "./takers";
import { backstopView, pickDesign, solvencyView, ViewError } from "./views";

interface Deps {
  ctx: KeeperContext;
  crash: CrashController;
  faucet: Faucet;
  loop: PriceLoop | null;
  sweeper: Sweeper | null;
  /** Arena mode (null = the plain demo keeper). */
  arena?: Arena | null;
}

const MAX_BODY = 16 * 1024;

function corsHeaders(req: IncomingMessage, allowed: string[]): Record<string, string> {
  const origin = req.headers.origin;
  let allow = "";
  if (allowed.includes("*")) allow = "*";
  else if (origin && allowed.includes(origin)) allow = origin;
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-admin-token",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
  if (allow) h["Access-Control-Allow-Origin"] = allow;
  return h;
}

function send(res: ServerResponse, status: number, body: unknown, cors: Record<string, string>): void {
  const json = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  if (size === 0) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export async function health({ ctx, crash, loop, faucet, sweeper }: Deps) {
  const [block, prices] = await Promise.all([ctx.client.getBlockNumber(), readOraclePrices(ctx)]);
  return {
    chainId: ctx.info.chainId,
    mode: ctx.info.mode,
    network: ctx.info.network,
    block: Number(block),
    addresses: {
      clearinghouse: ctx.dep.clearinghouse,
      ausd: ctx.dep.ausd,
      oracle: ctx.dep.oracle,
      naive: ctx.dep.naive,
      ...roleAddresses(ctx.roles),
    },
    markets: ctx.dep.markets,
    /** AUSD per base unit, from the on-chain oracle (MockOracle.getPrice). */
    prices: Object.fromEntries(Object.entries(prices).map(([s, p]) => [s, fromWad(p.price)])),
    pricesUpdatedAt: Object.fromEntries(Object.entries(prices).map(([s, p]) => [s, p.updatedAt])),
    crashed: crash.crashed,
    activeRunId: crash.activeRunId,
    lastRunId: crash.lastRunId,
    priceLoop: loop?.status() ?? null,
    faucet: faucet.describe(),
    features: ctx.features,
    sweeper: sweeper ? summarizeSweeper(sweeper) : null,
    demoTakers: sweeper ? sweeper.externalTakersInfo() : null,
  };
}

function summarizeSweeper(sweeper: Sweeper) {
  const st = sweeper.status();
  return {
    enabled: st.enabled,
    running: st.running,
    paused: st.paused,
    lastBlock: st.lastBlock,
    designs: st.designs,
    sent: st.sent,
    failures: st.failures,
    lastError: st.lastError,
  };
}

function sweepTxJson(t: Sweeper["recent"][number]) {
  return {
    design: t.design,
    lane: t.lane,
    kind: t.kind,
    accounts: t.accounts.length,
    keeper: t.keeper,
    txHash: t.hash,
    decidedAtBlock: t.decidedAtBlock,
    block: t.block,
    status: t.status,
    submittedAt: t.submittedAt,
    confirmedAt: t.confirmedAt,
    gasUsed: t.gasUsed?.toString() ?? null,
    gasLimit: t.gasLimit.toString(),
  };
}

export function startServer(deps: Deps): Server {
  const { ctx, crash, faucet, loop, sweeper } = deps;
  const arena = deps.arena ?? null;
  const server = createServer(async (req, res) => {
    const cors = corsHeaders(req, ctx.config.corsOrigins);
    const url = new URL(req.url ?? "/", "http://keeper.local");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    loop?.touch();
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors);
        res.end();
        return;
      }
      if (arena && isAdminRoute(req.method, path) && !arena.adminOk(req.headers["x-admin-token"])) {
        throw new HttpError(
          403,
          arena.config.adminToken
            ? "arena mode: this route needs the x-admin-token header"
            : "arena mode: admin routes are disabled (ARENA_ADMIN_TOKEN is not set)",
        );
      }
      if (req.method === "GET" && path === "/arena") {
        if (!arena) throw new HttpError(404, "this keeper is not in arena mode (--arena / ARENA=1)");
        return send(res, 200, await arena.view(), cors);
      }
      if (req.method === "POST" && path === "/arena/crash") {
        if (!arena) throw new HttpError(404, "this keeper is not in arena mode (--arena / ARENA=1)");
        await readJson(req); // body ignored (the arena always shocks ARENA_BPS); size-capped
        const ip = arena.clientIp(req.headers, req.socket.remoteAddress);
        return send(res, 202, await arena.requestCrash(ip), cors);
      }
      if (req.method === "GET" && (path === "/health" || path === "/")) {
        return send(res, 200, await health(deps), cors);
      }
      if (req.method === "POST" && path === "/faucet") {
        const body = await readJson(req);
        return send(res, 200, await faucet.drip(body.address), cors);
      }
      if (req.method === "POST" && path === "/crash") {
        const body = await readJson(req);
        const bps = body.bps === undefined ? 8_000 : Number(body.bps);
        if (!Number.isInteger(bps) || bps < 1_000 || bps >= 10_000) {
          throw new HttpError(400, "bps must be an integer in [1000, 9999] (8000 = −20%)");
        }
        const mode = body.mode === undefined ? "auto" : body.mode;
        if (mode !== "auto" && mode !== "auctions" && mode !== "legacy") {
          throw new HttpError(400, "mode must be auto | auctions | legacy");
        }
        const xray = body.xray === undefined ? undefined : Boolean(body.xray);
        let runId: string;
        try {
          ({ runId } = crash.start({ bps, mode, xray }));
        } catch (err) {
          if (err instanceof BusyError) throw err;
          throw new HttpError(400, (err as Error).message);
        }
        return send(res, 202, { runId }, cors);
      }
      if (req.method === "GET" && path === "/runs") {
        return send(res, 200, crash.listRuns(), cors);
      }
      const m = /^\/runs\/([\w-]+)$/.exec(path);
      if (req.method === "GET" && m) {
        const report = crash.getRun(m[1]);
        if (!report) throw new HttpError(404, `unknown run ${m[1]}`);
        return send(res, 200, report, cors);
      }
      const x = /^\/runs\/([\w-]+)\/xray$/.exec(path);
      if (req.method === "GET" && x) {
        const xr = crash.getXray(x[1]);
        if (xr === "pending") return send(res, 202, { runId: x[1], status: "pending" }, cors);
        if (!xr) throw new HttpError(404, `no X-ray for run ${x[1]}`);
        return send(res, 200, xr, cors);
      }
      if (req.method === "GET" && path === "/solvency") {
        return send(res, 200, await solvencyView(ctx, pickDesign(ctx, url.searchParams.get("design"))), cors);
      }
      if (req.method === "GET" && path === "/backstop") {
        const design = pickDesign(ctx, url.searchParams.get("design"));
        return send(res, 200, await backstopView(ctx, design, sweeper, url.searchParams.get("lp")), cors);
      }
      if (req.method === "GET" && path === "/sweeper") {
        if (!sweeper) throw new HttpError(404, "no sweeper in this process");
        const st = sweeper.status();
        return send(res, 200, { ...st, recent: sweeper.recent.slice(-50).map(sweepTxJson) }, cors);
      }
      if (req.method === "POST" && path === "/price-loop") {
        if (!loop) throw new HttpError(404, "no price loop in this process");
        const body = await readJson(req);
        if (typeof body.paused !== "boolean") throw new HttpError(400, "body must be { paused: boolean }");
        if (crash.activeRunId) throw new HttpError(409, `crash run ${crash.activeRunId} is active`);
        if (body.paused) {
          await loop.pause(typeof body.reason === "string" ? body.reason.slice(0, 80) : "paused via /price-loop");
        } else {
          if (crash.crashed) throw new HttpError(409, "prices are crashed: POST /recover resumes the loop");
          loop.resume();
        }
        return send(res, 200, { priceLoop: loop.status() }, cors);
      }
      if (req.method === "GET" && path === "/demo-takers") {
        return send(res, 200, describeTakers(sweeper?.takers ?? null), cors);
      }
      if (req.method === "POST" && path === "/demo-takers") {
        if (!sweeper || !ctx.features.auctions) throw new HttpError(404, "no auction sweeper in this process");
        const body = await readJson(req);
        if (crash.activeRunId) throw new HttpError(409, `crash run ${crash.activeRunId} is active`);
        const num = (k: string) => {
          if (body[k] === undefined) return undefined;
          const v = Number(body[k]);
          if (!Number.isInteger(v) || v < 0) throw new HttpError(400, `${k} must be a non-negative integer`);
          return v;
        };
        const overrides = { seed: num("seed"), perLane: num("perLane"), minBps: num("minBps"), maxBps: num("maxBps") };
        await sweeper.idle();
        if (ctx.designs.some((d) => sweeper.takersHolding(d.design) > 0)) {
          throw new HttpError(409, "current demo takers still hold inherited positions; retry in a few blocks");
        }
        if (body.enabled === false) {
          sweeper.setTakers(null);
        } else {
          const cfg = takerConfig(ctx, Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)));
          if (cfg.maxBps < cfg.minBps) throw new HttpError(400, "maxBps must be >= minBps");
          sweeper.setTakers(await createTakers(ctx, cfg, ctx.designs, (m) => console.log(`[demo-takers] ${m.trim()}`)));
        }
        return send(res, 200, describeTakers(sweeper.takers), cors);
      }
      if (req.method === "POST" && path === "/recover") {
        return send(res, 200, await crash.recover(), cors);
      }
      throw new HttpError(404, `no route ${req.method} ${path}`);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...err.extra }, cors);
      if (err instanceof ArenaRefusal) return send(res, err.status, { error: err.message, code: err.code, ...err.extra }, cors);
      if (err instanceof FaucetError) return send(res, err.status, { error: err.message, ...err.extra }, cors);
      if (err instanceof BusyError) return send(res, 409, { error: err.message, runId: err.runId }, cors);
      if (err instanceof NotCrashedError) return send(res, 409, { error: err.message }, cors);
      if (err instanceof ViewError) return send(res, err.status, { error: err.message }, cors);
      const msg = (err as Error)?.message?.split("\n")[0] ?? String(err);
      console.error(`[http] ${req.method} ${path} failed: ${msg}`);
      return send(res, 500, { error: msg }, cors);
    }
  });
  server.listen(ctx.config.port);
  return server;
}
