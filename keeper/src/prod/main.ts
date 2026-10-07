// Production keeper — `npm run keeper -- --network mainnet [--yes-mainnet] [--env PATH] [--rpc URL]`.
//
// Loops (docs/PRODUCTION_PLAN.md "Keeper / ops"), all driven by one head poller and chain time:
//   executor  per-lane delayed-order execution with the first Pyth update after MIN_EXEC_DELAY
//   funding   updateFunding(market) from the OPS key once per funding interval
//   sweeper   fair-liquidation auctions with fresh Pyth updates, per lane from the lane keeper key
//   monitor   balances, oracle staleness/confidence, pause, solvency, caps, governance → alerts
// HTTP: /health (production, paused, caps, priceSource "pyth", hot-key balances), /orders,
// /solvency, /backstop, /alerts, /txs, /hermes proxy. Demo endpoints answer 403.
// There is no faucet, no price pusher, no demo taker and no synthetic crash in this mode.

import { formatEther } from "viem";
import { rpcHost } from "../env";
import { activityFromEnv, computeBudget, loadGasTable } from "./budget";
import { confirmMainnet, connectMainnet, KNOWN, loadMainnetEnv, loadProdRoles, mainnetRpcUrl, printBalances, rel, roleList, type Args } from "./config";
import { createProdContext, short } from "./context";
import { OrderExecutor } from "./executor";
import { FundingUpdater } from "./funding";
import { HeadWatcher } from "./head";
import { HermesError } from "./hermes";
import { Monitor } from "./monitor";
import { PricePusher } from "./pricepush";
import { startProdServer } from "./server";
import { ProdSweeper } from "./sweeper";
import { TxLedger } from "./tx";

export async function runProdKeeper(args: Args): Promise<void> {
  const envFile = loadMainnetEnv(args);
  const chain = await connectMainnet(mainnetRpcUrl(args));
  console.log(`[keeper] PRODUCTION · ${chain.label} · chain ${chain.chainId} · rpc ${rpcHost(chain.rpcUrl)} · ${chain.clientVersion}`);
  console.log(`[keeper] env: ${envFile ? rel(envFile) : "(process environment only: KEEPER_SECRETS_FROM_ENV=1)"}`);
  const roles = loadProdRoles(["ops", "keepers"]);
  if (roles.deployer) {
    console.warn("[keeper] WARNING DEPLOYER_PRIVATE_KEY is set in the keeper's environment: it is not needed after deploy — remove it from the server.");
  }
  if (!roles.guardian) console.log("[keeper] no GUARDIAN_PRIVATE_KEY here (recommended: keep it off the keeper host). Auto-pause is unavailable.");

  const ctx = await createProdContext(chain, roles);
  const { dep, params, config } = ctx;
  console.log(`[keeper] deployment ${rel(dep.file)}: clearinghouse ${dep.clearinghouse} · AUSD ${dep.ausd} · Pyth ${dep.pyth} · timelock ${dep.timelock ?? "?"}`);
  console.log(`[keeper] markets ${ctx.markets.map((m) => `${m.symbol}→${m.feed.slice(0, 10)}…`).join(" · ")}`);
  console.log(
    `[keeper] params: exec delay ${params.minExecDelay ?? "?"}–${params.maxExecDelay ?? "?"} s · funding every ${params.fundingInterval ?? "?"} s · ` +
      `maxConfBps ${params.maxConfBps ?? "?"} · maxPriceAge ${params.maxPriceAge ?? "?"} s · maxStoredPriceAge ${params.maxStoredPriceAge ?? "?"} s`,
  );
  console.log(`[keeper] hot keys (addresses only):`);
  await printBalances(chain.client, roleList(roles));

  // Cost estimate from measured gas (the same model keeper:fund uses).
  const quoted = await chain.client.getGasPrice().catch(() => KNOWN.minGasPriceWei);
  const gasPrice = quoted > KNOWN.minGasPriceWei ? quoted : KNOWN.minGasPriceWei;
  const plan = computeBudget(loadGasTable(), activityFromEnv(gasPrice, BigInt(0), params.fundingInterval ?? undefined));
  console.log(
    `[keeper] expected burn ≈ ${Number(formatEther(plan.perDayTotal)).toFixed(2)} MON/day at the budget's activity assumptions ` +
      "(executions are paid back by users' execution fees). `npm run keeper:fund -- --network mainnet` for details.",
  );
  console.log(
    `[keeper] Hermes ${ctx.hermes.status().endpoints.join(", ")} · API key ${ctx.hermes.status().apiKey ? "set" : "MISSING (Hermes answers 401 without PYTH_API_KEY)"} · ` +
      `alerts → ${ctx.alerter.configured ? "webhook" : "log only (ALERT_WEBHOOK_URL unset)"}`,
  );
  confirmMainnet(chain, args, "run the production keeper (executeOrder, updateFunding and auction txs from the hot keys)");

  // Preflight: Hermes must answer for every feed before we start promising executions. A missing
  // or rejected API key never fixes itself → refuse to start (clearly) instead of running blind.
  if (!ctx.hermes.status().apiKey && !chain.fork) {
    throw new Error(
      "PYTH_API_KEY is not set. Hermes requires an API key since 2026-08-26 (HTTP 401 without it): " +
        "orders could not execute and auctions could not start. Get a key (Pyth Terminal) and set PYTH_API_KEY.",
    );
  }
  try {
    const u = await ctx.hermes.latest(ctx.markets.map((m) => m.feed));
    console.log(`[keeper] Hermes OK via ${u.source}: ${[...u.messages.values()].map((m) => `${m.publishTime}`).join(", ")} (publish times)`);
  } catch (err) {
    if (err instanceof HermesError && (err.status === 401 || err.status === 403)) {
      await Promise.race([ctx.alerter.flush(), new Promise((r) => setTimeout(r, 3_000))]);
      throw new Error(`Hermes rejected PYTH_API_KEY (HTTP ${err.status}): fix the key — the keeper cannot execute orders or run auctions without it`);
    }
    console.error(`[keeper] Hermes preflight FAILED: ${short(err)} — starting anyway; backoff + alerts while it stays down.`);
  }
  const ledger = new TxLedger();
  const heads = new HeadWatcher(chain.client, config.headPollMs, (where, err) => {
    if (where === "head") return;
    console.warn(`[${where}] ${short(err)}`);
  });
  const executor = new OrderExecutor(ctx, ledger);
  const funding = new FundingUpdater(ctx, ledger);
  const sweeper = new ProdSweeper(ctx, ledger);
  const monitor = new Monitor(ctx, heads, ledger);
  const pusher = new PricePusher(ctx, ledger);
  executor.pusher = pusher;
  executor.onLogs = (logs) => monitor.onLogs(logs);
  heads.subscribe("executor", (h) => executor.tick(h));
  if (pusher.mode === "interval") {
    // "busy" = any open interest or pending order: there is something whose price must stay fresh.
    heads.subscribe("pricepush", (h) => pusher.tick(h, () => executor.pending().length > 0), 1_000);
  }
  heads.subscribe("sweeper", (h) => sweeper.tick(h));
  heads.subscribe("funding", (h) => funding.tick(h), 5_000);
  heads.subscribe("monitor", (h) => monitor.tick(h), config.monitorIntervalMs);
  heads.start();

  const server = startProdServer({ ctx, heads, executor, funding, sweeper, monitor, ledger, pusher });
  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(err.code === "EADDRINUSE" ? `[keeper] fatal: port ${config.port} is in use` : `[keeper] fatal: ${err.message}`);
    process.exit(1);
  });
  console.log(
    `[keeper] listening on :${config.port} (CORS ${config.corsOrigins.join(", ")}) · head poll ${config.headPollMs} ms · ` +
      `sweeper every ≥${config.sweeperMinIntervalMs} ms · monitor every ${config.monitorIntervalMs} ms · funding ${funding.enabled ? "on" : "OFF"} · Pyth push ${pusher.mode}`,
  );
  ctx.alerter.event("keeper:start", "info", `keeper started on ${chain.label} (block ${(await chain.client.getBlockNumber()).toString()})`);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[keeper] ${signal}: stopping (letting in-flight txs settle)`);
    heads.stop();
    server.close();
    await Promise.race([heads.idle(), new Promise((r) => setTimeout(r, 5_000))]);
    ctx.alerter.event("keeper:stop", "warning", `keeper stopping (${signal})`);
    await Promise.race([ctx.alerter.flush(), new Promise((r) => setTimeout(r, 3_000))]);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
