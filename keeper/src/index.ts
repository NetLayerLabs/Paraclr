// Paraclr keeper — `npm run keeper`.
//
// The only process that holds operator keys. Pushes the oracle price feed, serves the faucet,
// and runs the measured 8-lane flash-crash. Reads keeper/.env; on a local anvil every setting
// has a zero-config default (anvil dev keys), see keeper/README.md.
//
// `npm run keeper -- --network mainnet` (or `--network testnet`) runs the PRODUCTION keeper instead
// (keeper/src/prod/main.ts: keeper/.env.mainnet / keeper/.env.testnet, chain 143 / 10143, Pyth/Hermes,
// order executor, funding, auctions, monitoring; no faucet / price pusher / crash / demo takers).
// Nothing below runs in those modes. Without --network this is the DEMO keeper (keeper/.env).

import type { Server } from "node:http";
import { encodeFunctionData, formatEther } from "viem";
import { abis, createContext, ensureAnvilBalances, readOraclePrices, roleBalances, type KeeperContext } from "./context";
import { CrashController } from "./crash";
import { loadKeeperEnv, parseArgs, rpcHost } from "./env";
import { Faucet } from "./faucet";
import { applyPrivateStackDefaults, defaultRpcUrl, deploymentLabel } from "./network";
import { fromWad, PriceLoop, PriceSim } from "./prices";
import { estimateLimit, waitForReceipt } from "./sender";
import { startServer } from "./server";
import { Sweeper } from "./sweeper";
import { createTakers, takerConfig } from "./takers";
import { runProdKeeper } from "./prod/main";

/** The price pusher must be on the oracle's updater allowlist; fix it if we own the oracle. */
async function ensurePusherIsUpdater(ctx: KeeperContext): Promise<void> {
  const pusher = ctx.roles.pricePusher.address;
  const operator = ctx.roles.operator.address;
  const [owner, allowed] = await Promise.all([
    ctx.client.readContract({ address: ctx.dep.oracle, abi: abis.oracle, functionName: "owner" }),
    ctx.client.readContract({ address: ctx.dep.oracle, abi: abis.oracle, functionName: "isUpdater", args: [pusher] }),
  ]);
  if (owner.toLowerCase() !== operator.toLowerCase()) {
    console.warn(`[keeper] WARNING operator ${operator} is not the oracle owner (${owner}); crash/recover will fail.`);
  }
  if (allowed || pusher.toLowerCase() === owner.toLowerCase()) return;
  if (owner.toLowerCase() !== operator.toLowerCase()) {
    console.warn(`[keeper] WARNING price pusher ${pusher} is not an oracle updater and the operator can't add it.`);
    return;
  }
  const data = encodeFunctionData({ abi: abis.oracle, functionName: "setUpdater", args: [pusher, true] });
  const op = ctx.senders.for(ctx.roles.operator);
  const { limit } = await estimateLimit(ctx.client, { account: op.address, to: ctx.dep.oracle, data }, ctx.config.gasMarginBps);
  const sub = await op.send({ to: ctx.dep.oracle, data, gas: limit });
  await waitForReceipt(ctx.client, sub.hash, { pollMs: ctx.config.receiptPollMs, timeoutMs: ctx.config.receiptTimeoutMs });
  console.log(`[keeper] allowlisted price pusher ${pusher} on the oracle (${sub.hash})`);
}

async function main(): Promise<void> {
  const envFile = loadKeeperEnv();
  applyPrivateStackDefaults(defaultRpcUrl());
  const ctx = await createContext();
  const { info, dep, config } = ctx;
  const label = info.network === "anvil" ? "local anvil (NOT Monad)" : "Monad testnet";
  console.log(`[keeper] ${label} · chain ${info.chainId} · rpc ${rpcHost(ctx.rpcUrl)} · ${info.clientVersion}`);
  console.log(`[keeper] env: ${envFile ?? "(no keeper/.env — anvil defaults)"} · keys: ${ctx.roles.source}`);
  console.log(`[keeper] clearinghouse ${dep.clearinghouse} · oracle ${dep.oracle} · ausd ${dep.ausd} (${deploymentLabel(info.chainId)})`);

  const topped = await ensureAnvilBalances(ctx);
  if (topped.length) console.log(`[keeper] anvil: topped up ${topped.length} role account(s)`);
  for (const r of await roleBalances(ctx)) {
    console.log(`[keeper]   ${r.role.padEnd(12)} ${r.address}  ${Number(r.formatted).toFixed(4)} ${info.network === "anvil" ? "ETH" : "MON"}`);
  }
  if (ctx.roles.keepers.length < 8) {
    console.warn(`[keeper] WARNING only ${ctx.roles.keepers.length} keeper key(s): lanes will share keys (serialised nonces).`);
  }
  await ensurePusherIsUpdater(ctx);

  const current = await readOraclePrices(ctx);
  const sim = new PriceSim(
    ctx.markets.map((m) => m.symbol),
    Object.fromEntries(Object.entries(current).map(([s, p]) => [s, fromWad(p.price)])),
    config.priceIntervalMs,
  );
  const loop = new PriceLoop(ctx, sim);
  const sweeper = new Sweeper(ctx);
  const crash = new CrashController(ctx, loop, sweeper);
  const faucet = new Faucet(ctx);
  if (config.demoTakers && ctx.features.auctions) {
    try {
      const cfg = takerConfig(ctx);
      const set = await createTakers(ctx, cfg, ctx.designs, (m) => console.log(`[keeper] ${m.trim()}`));
      sweeper.setTakers(set);
      console.log(
        `[keeper] demo external takers ON (keeper-run bots): ${set.takers.length} accounts (${cfg.perLane}/lane), ` +
          `reservation ${cfg.minBps}–${cfg.maxBps} bps, seed ${cfg.seed}, ${Number(cfg.collateral) / 1e6} AUSD collateral each per design`,
      );
    } catch (err) {
      console.error(`[keeper] demo takers could not be set up (continuing without): ${(err as Error)?.message?.split("\n")[0]}`);
    }
  } else {
    console.log(`[keeper] demo external takers OFF${ctx.features.auctions ? " (DEMO_TAKERS=1 enables them)" : ""}`);
  }
  loop.start();
  if (config.sweeperEnabled) sweeper.start();
  const server: Server = startServer({ ctx, crash, faucet, loop, sweeper });
  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(
      err.code === "EADDRINUSE"
        ? `[keeper] fatal: port ${config.port} is in use (another keeper running? set KEEPER_PORT)`
        : `[keeper] fatal: ${err.message}`,
    );
    process.exit(1);
  });

  console.log(
    `[keeper] price loop ${config.priceLoopEnabled ? `every ${config.priceIntervalMs}ms` : "OFF"}` +
      (config.priceIdleMs ? ` (pauses after ${Math.round(config.priceIdleMs / 1000)}s without HTTP traffic)` : "") +
      ` · faucet ${formatEther(config.faucetGasWei)} gas + ${Number(config.faucetAusd) / 1e6} AUSD` +
      ` · max tx gas ${config.maxTxGas} · gas margin ${config.gasMarginBps / 100}%`,
  );
  console.log(
    `[keeper] designs: ${ctx.designs.map((d) => `${d.label} ${d.address}`).join(" · ")} · features ${JSON.stringify(ctx.features)}`,
  );
  console.log(
    !ctx.features.auctions
      ? "[keeper] sweeper OFF: the deployed clearinghouse has no auction API (crash runs use legacy liquidateBatch)"
      : `[keeper] sweeper ${config.sweeperEnabled ? `ON (every block, poll ${config.sweeperPollMs}ms, ${sweeper.designs.map((d) => (d.label === "naive" ? `naive [${config.sweepNaive}]` : d.label)).join(" + ")})` : "OFF (SWEEPER=0; crash runs start it for the run)"}` +
          ` · X-ray ${config.xray} → ${config.xrayDir}`,
  );
  console.log(`[keeper] listening on http://127.0.0.1:${config.port}  (CORS: ${config.corsOrigins.join(", ")})`);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[keeper] ${signal}: stopping`);
    server.close();
    await Promise.race([Promise.all([loop.stop(), sweeper.stop()]), new Promise((r) => setTimeout(r, 3_000))]);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

const cli = parseArgs(process.argv.slice(2));
if (cli.network !== undefined && cli.network !== "mainnet" && cli.network !== "testnet") {
  console.error(`[keeper] --network must be mainnet or testnet (production) or omitted (demo stack: anvil / testnet from keeper/.env), got "${String(cli.network)}"`);
  process.exit(1);
}
(cli.network === "mainnet" || cli.network === "testnet" ? runProdKeeper(cli) : main()).catch((err: unknown) => {
  console.error(`[keeper] fatal: ${(err as Error)?.message ?? err}`);
  process.exit(1);
});
