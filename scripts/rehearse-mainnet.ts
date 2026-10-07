// `npm run rehearse:mainnet` — full production rehearsal, nothing touches the real chain.
//
// FORK LEG (anvil fork of https://rpc.monad.xyz on :8945, real Agora AUSD, real Pyth contract):
//   harvest REAL signed Pyth updates from recent mainnet txs (or use live Hermes when
//   PYTH_API_KEY is set and --hermes live) → fork a few minutes back → keeper:init / keeper:fund /
//   deploy:mainnet through their real CLIs → seed lane insurance + backstop pools and fund traders
//   with AUSD via storage cheats → start the PRODUCTION keeper → delayed orders committed and
//   executed with real Pyth data (open, increase on a second leg, reduce, slippage → OrderFailed),
//   withdraw through the keeper's Hermes proxy, guardian pause semantics, a Hermes outage drill,
//   an expired order + cancel, funding updates, real-Pyth gas probes for the auction calls, unpause
//   through the timelock (impersonated multisig + time warp), solvency at the end.
// MOCK LEG (plain anvil :8947, chain id 143, the contracts agent's TEST MockPyth + MockAUSD):
//   real prices don't move enough for liquidations, so the auction path runs here: MON positions at
//   9.5x, pause, −10 % → the sweeper starts auctions while paused, a holder top-up cures one
//   (110 % rule), the lane pools take the rest; then a lane-7 deficit drill: BTC −90 % → the
//   pool-less lane's auction expires into bad debt beyond its insurance → `solvency:lane7`, a
//   haircut withdrawal (`haircut:lane7`), timelock unpause, LaneInDeficit on fresh deposits, and
//   the runbook repair (treasury fundLane) → the alert resolves.
//
// Output: contracts/cache/rehearsal/<UTC>/ (report.json, logs, env files with throwaway keys,
// rehearsal deployment files). Never deployments/143.json, never bench/*/143-*.
//
//   --legs fork,mock,scale  which legs (default all three)   --scale-accounts N (600) --scale-port P (8948)       --lookback N   fork this many blocks back (4000)
//   --hermes replay|live  live needs PYTH_API_KEY         --port P / --mock-port P (8945 / 8947)
//   --keep                leave anvils + keepers running at the end

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  formatEther,
  http,
  keccak256,
  parseEther,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CONTRACTS_DIR, envStr, parseArgs, REPO_ROOT, rpcHost } from "../keeper/src/env";
import { foundryBin, shadowRoot } from "../keeper/src/foundry";
import { clearinghouseAbi, erc20Abi, pythAbi } from "../keeper/src/prod/abi";
import { connectMainnet, KNOWN, MAINNET_RPC_URL, rel, type Client, type ProdChain } from "../keeper/src/prod/config";
import { readProdDeployment, type ProdDeployment } from "../keeper/src/prod/deployment";
import { parseAccumulatorUpdate } from "../keeper/src/prod/pyth-wire";
import { targetRate } from "../keeper/src/prod/funding";
import { harvestUpdates, HermesReplay, updatesWith, type HarvestedUpdate } from "./lib/pyth-replay";
import { measureCadence } from "../bench/pyth-cadence";
import {
  chainTime,
  createSafe,
  dealToken,
  laneAccount,
  mineAt,
  portFree,
  sendAs,
  setBalance,
  sleep,
  startAnvil,
  warpTo,
  WebhookSink,
} from "./lib/rehearsal";

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

interface Step {
  leg: "fork" | "mock" | "scale";
  name: string;
  ok: boolean | null; // null = skipped
  ms: number;
  detail: string;
  data?: unknown;
}

const report = {
  kind: "paraclr-mainnet-rehearsal",
  startedAt: new Date().toISOString(),
  finishedAt: "",
  notMainnet: "Every number here comes from local anvil chains (a fork of Monad mainnet, and a plain anvil with the TEST MockPyth). Nothing was sent to Monad mainnet.",
  fork: {} as Record<string, unknown>,
  mock: {} as Record<string, unknown>,
  scale: {} as Record<string, unknown>,
  steps: [] as Step[],
  gas: { limits: {} as Record<string, number>, used: {} as Record<string, number>, notes: [] as string[] },
  alerts: { fork: [] as string[], mock: [] as string[] },
  summary: { passed: 0, failed: 0, skipped: 0 },
};

const children: ChildProcess[] = [];
let OUT = "";

function bigintJson(_k: string, v: unknown) {
  return typeof v === "bigint" ? v.toString() : v;
}

function writeReport(): void {
  report.finishedAt = new Date().toISOString();
  report.summary = {
    passed: report.steps.filter((s) => s.ok === true).length,
    failed: report.steps.filter((s) => s.ok === false).length,
    skipped: report.steps.filter((s) => s.ok === null).length,
  };
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, bigintJson, 2));
}

function log(m: string): void {
  const line = `[rehearse ${new Date().toISOString().slice(11, 19)}] ${m}`;
  console.log(line);
  appendFileSync(join(OUT, "rehearsal.log"), line + "\n");
}

async function step<T>(leg: Step["leg"], name: string, fn: () => Promise<T>, opts: { fatal?: boolean } = {}): Promise<T | null> {
  const t0 = Date.now();
  log(`▶ [${leg}] ${name}`);
  try {
    const r = await fn();
    const detail = typeof r === "string" ? r : r && typeof r === "object" && "detail" in (r as object) ? String((r as unknown as { detail: unknown }).detail) : "ok";
    report.steps.push({ leg, name, ok: true, ms: Date.now() - t0, detail, data: typeof r === "object" ? r : undefined });
    log(`  ✓ ${detail}`);
    writeReport();
    return r;
  } catch (err) {
    const msg = ((err as Error)?.message ?? String(err)).split("\n").slice(0, 3).join(" ");
    report.steps.push({ leg, name, ok: false, ms: Date.now() - t0, detail: msg });
    log(`  ✗ ${msg}`);
    writeReport();
    if (opts.fatal) throw new Error(`${leg}: ${name} failed: ${msg}`);
    return null;
  }
}

function skip(leg: Step["leg"], name: string, why: string): void {
  report.steps.push({ leg, name, ok: null, ms: 0, detail: `skipped: ${why}` });
  log(`  – [${leg}] ${name} skipped: ${why}`);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// child processes (the real CLIs)
// ---------------------------------------------------------------------------

const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");

function runCli(name: string, script: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const logFile = join(OUT, `${name}.log`);
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [join(REPO_ROOT, script), ...args], { cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("exit", (code) => {
      writeFileSync(logFile, out);
      if (code === 0) resolve(out);
      else reject(new Error(`${name} exited ${code}: ${out.trim().split("\n").slice(-3).join(" | ")} (log ${rel(logFile)})`));
    });
  });
}

function startKeeper(name: string, envFile: string, rpcUrl: string, env: Record<string, string> = {}): ChildProcess {
  const logFile = join(OUT, `${name}.log`);
  const child = spawn(TSX, [join(REPO_ROOT, "keeper/src/index.ts"), "--network", "mainnet", "--env", envFile, "--rpc", rpcUrl], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sink = (d: Buffer) => appendFileSync(logFile, d.toString());
  child.stdout?.on("data", sink);
  child.stderr?.on("data", sink);
  children.push(child);
  return child;
}

async function waitHealth(port: number, timeoutMs = 90_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
      if (r.ok) return (await r.json()) as Record<string, unknown>;
    } catch {
      /* not up */
    }
    if (Date.now() > deadline) throw new Error(`keeper on :${port} did not answer /health within ${timeoutMs / 1000}s`);
    await sleep(500);
  }
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000), headers });
  return { status: r.status, body: (await r.json().catch(() => null)) as T };
}

// ---------------------------------------------------------------------------
// shared trading helpers
// ---------------------------------------------------------------------------

interface World {
  chain: ProdChain;
  dep: ProdDeployment;
  keeperPort: number;
  minExecDelay: number;
}

async function txAs(w: World, who: LocalAccount, fn: string, args: unknown[], value = BigInt(0)) {
  const data = encodeFunctionData({ abi: clearinghouseAbi as Abi, functionName: fn, args });
  return sendAs(w.chain, who, w.dep.clearinghouse, data, value);
}

async function approve(w: World, who: LocalAccount, token: Address, amount: bigint) {
  return sendAs(w.chain, who, token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [w.dep.clearinghouse, amount] }));
}

/** Simulate a call and return the decoded revert name, or null if it would succeed. */
async function revertName(w: World, from: Address, fn: string, args: unknown[], value = BigInt(0)): Promise<string | null> {
  try {
    await w.chain.client.simulateContract({ address: w.dep.clearinghouse, abi: clearinghouseAbi as Abi, functionName: fn, args, account: from, value });
    return null;
  } catch (err) {
    const e = err as { cause?: { data?: { errorName?: string } }; shortMessage?: string };
    return e.cause?.data?.errorName ?? e.shortMessage ?? "reverted";
  }
}

/** accountHealth at the prices in `update` (eth_simulateV1: push the update into Pyth, then read). */
async function simulateHealth(w: World, account: Address, update: Hex[]): Promise<readonly [bigint, bigint, bigint, bigint]> {
  const calls = [
    { from: account, to: w.dep.pyth, data: encodeFunctionData({ abi: pythAbi, functionName: "updatePriceFeeds", args: [update] }) },
    { from: account, to: w.dep.clearinghouse, data: encodeFunctionData({ abi: clearinghouseAbi, functionName: "accountHealth", args: [account] }) },
  ];
  const res = (await w.chain.client.request({
    method: "eth_simulateV1" as never,
    params: [{ blockStateCalls: [{ calls }], validation: false }, "latest"] as never,
  })) as Array<{ calls: Array<{ status: string; returnData: Hex }> }>;
  const r = res[0].calls[1];
  if (r.status !== "0x1") throw new Error("accountHealth simulation failed");
  return decodeFunctionResult({ abi: clearinghouseAbi, functionName: "accountHealth", data: r.returnData }) as readonly [bigint, bigint, bigint, bigint];
}

/** Sign (don't wait) a commitOrder from `who`; returns the tx hash once the node has it. */
async function sendCommit(w: World, who: LocalAccount, market: Hex, sizeDelta: bigint, margin: bigint, acceptable: bigint, fee: bigint): Promise<Hex> {
  const wallet = createWalletClient({ account: who, chain: w.chain.chain, transport: http(w.chain.rpcUrl) });
  const data = encodeFunctionData({ abi: clearinghouseAbi, functionName: "commitOrder", args: [market, sizeDelta, margin, acceptable] });
  return wallet.sendTransaction({ to: w.dep.clearinghouse, data, value: fee, gas: BigInt(600_000), chain: w.chain.chain });
}

interface Committed {
  label: string;
  trader: number;
  hash: Hex;
  orderId?: bigint;
  execAfter?: number;
  expect: "executed" | "failed";
}

async function orderIdsFrom(w: World, c: Committed[]): Promise<void> {
  for (const x of c) {
    const r = await w.chain.client.waitForTransactionReceipt({ hash: x.hash, pollingInterval: 200, timeout: 60_000 });
    assert(r.status === "success", `${x.label}: commitOrder reverted (${x.hash})`);
    for (const l of r.logs) {
      try {
        const e = decodeEventLog({ abi: clearinghouseAbi, data: l.data, topics: l.topics });
        if (e.eventName === "OrderCommitted") {
          const a = e.args as unknown as { orderId: bigint; execAfter: bigint };
          x.orderId = a.orderId;
          x.execAfter = Number(a.execAfter);
        }
      } catch {
        /* other event */
      }
    }
    assert(x.orderId !== undefined, `${x.label}: no OrderCommitted`);
  }
}

/** Wait until every order resolved (status ≠ Pending) and check it resolved as expected. */
async function waitResolved(w: World, c: Committed[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  const out: Array<{ label: string; status: number; latencyS: number | null; executor: string | null }> = [];
  for (const x of c) {
    for (;;) {
      const o = (await w.chain.client.readContract({ address: w.dep.clearinghouse, abi: clearinghouseAbi, functionName: "getOrder", args: [x.orderId!] })) as unknown as { status: number };
      if (o.status !== 1) {
        // the keeper records latency when ITS receipt poll sees the tx; give it a moment
        let k = null as { body: { latencyS: number | null; txHash: string | null } } | null;
        for (let i = 0; i < 10; i++) {
          k = await getJson<{ latencyS: number | null; txHash: string | null }>(`http://127.0.0.1:${w.keeperPort}/orders/${x.orderId}`).catch(() => null);
          if (k?.body?.latencyS !== null && k?.body?.latencyS !== undefined) break;
          await sleep(300);
        }
        out.push({ label: x.label, status: o.status, latencyS: k?.body?.latencyS ?? null, executor: k?.body?.txHash ?? null });
        const want = x.expect === "executed" ? 2 : 3;
        assert(o.status === want, `${x.label}: status ${o.status}, expected ${x.expect} (${want})`);
        break;
      }
      if (Date.now() > deadline) throw new Error(`${x.label}: still pending after ${timeoutMs / 1000}s`);
      await sleep(400);
    }
  }
  return out;
}

const WAD = BigInt(10) ** BigInt(18);

/** size (1e18 base units) for `notionalAusd` (6dp) at `price` (1e18). */
function sizeFor(notional6: bigint, price18: bigint): bigint {
  return (notional6 * BigInt(10) ** BigInt(30)) / price18;
}

// ---------------------------------------------------------------------------
// FORK LEG
// ---------------------------------------------------------------------------

async function forkLeg(args: Record<string, string | true>): Promise<void> {
  const port = Number(args.port ?? 8945);
  const keeperPort = 8787 + port - 8545; // 9187
  const sinkPort = port + 100;
  const replayPort = port + 101;
  const lookback = Number(args.lookback ?? 4000);
  const liveHermes = args.hermes === "live";
  if (liveHermes && !envStr("PYTH_API_KEY")) throw new Error("--hermes live needs PYTH_API_KEY in the environment");
  const feeds = Object.values(KNOWN.feeds);
  assert(await portFree(port), `port ${port} is busy (another anvil?)`);

  // 0a. third-party Pyth push cadence on mainnet (read-only): drives the push policy + budget
  if (args["no-cadence"] !== true) {
    await step("fork", "measure the third-party Pyth push cadence on Monad mainnet (read-only, eth_getLogs)", async () => {
      const c = await measureCadence(MAINNET_RPC_URL, Number(args["cadence-blocks"] ?? 9_000), 12, log);
      report.fork.pythCadence = c;
      writeFileSync(join(OUT, "pyth-cadence.json"), JSON.stringify(c, null, 2));
      return `${Math.round(c.windowS / 60)} min: ${c.feeds.map((f) => `${f.symbol} ${f.pushesPerHour}/h, gap p50 ${f.gapS.p50}s p90 ${f.gapS.p90}s max ${f.gapS.max}s, stored ≤15 s ${Math.round(f.freshShare.le15 * 100)}%`).join(" · ")}; all 3 ≤15 s ${Math.round(c.allFeedsFreshShare15 * 100)}%; interval policy (12 s) would push ${c.intervalPolicy.pushesPerDay}/day`;
    });
  }

  // 0b. harvest real signed Pyth updates from mainnet
  const mainnet = createPublicClient({ transport: http(MAINNET_RPC_URL, { retryCount: 4, retryDelay: 500 }) }) as unknown as Client;
  const head = Number(await mainnet.getBlockNumber());
  const forkBlock = liveHermes ? head - 2 : head - lookback;
  let usable: HarvestedUpdate[] = [];
  if (!liveHermes) {
    await step("fork", "harvest real Pyth updates from Monad mainnet txs", async () => {
      const all = await harvestUpdates(mainnet, KNOWN.pyth, feeds as Hex[], forkBlock, head, log);
      usable = updatesWith(all, feeds as Hex[]).filter((u) => feeds.every((f) => u.messages[f.toLowerCase()].prevPublishTime < u.messages[f.toLowerCase()].publishTime));
      writeFileSync(join(OUT, "harvest.json"), JSON.stringify({ forkBlock, head, updates: all }, null, 2));
      const times = usable.map((u) => u.messages[feeds[0].toLowerCase()].publishTime);
      const gaps = times.slice(1).map((t, i) => t - times[i]);
      report.fork.harvest = { mainnetHead: head, forkBlock, txs: new Set(all.map((u) => u.txHash)).size, updates: all.length, usableAllFeeds: usable.length, firstT: times[0], lastT: times[times.length - 1], gapS: { min: Math.min(...gaps), max: Math.max(...gaps) } };
      assert(usable.length >= 8, `only ${usable.length} usable updates; raise --lookback`);
      return `${all.length} signed updates from ${new Set(all.map((u) => u.txHash)).size} mainnet txs; ${usable.length} carry MON+SOL+BTC (publish gaps ${Math.min(...gaps)}–${Math.max(...gaps)} s)`;
    }, { fatal: true });
  }

  // 1. anvil fork
  const anvilLog = join(OUT, "anvil-fork.log");
  const anvil = await step("fork", `anvil --fork-url ${rpcHost(MAINNET_RPC_URL)} --fork-block-number ${forkBlock} (:${port}, 128 KB code limit)`, async () => {
    const a = await startAnvil({ port, forkUrl: MAINNET_RPC_URL, forkBlock, blockTime: 1, logFile: anvilLog });
    children.push(a);
    return a;
  }, { fatal: true });
  void anvil;
  const rpcUrl = `http://127.0.0.1:${port}`;
  const chain = await connectMainnet(rpcUrl);
  report.fork.chain = { label: chain.label, network: chain.network, chainId: chain.chainId, forkBlock, forkedFrom: rpcHost(MAINNET_RPC_URL) };

  // 2. webhook sink + Hermes (replay of the harvested updates, or live)
  const sink = new WebhookSink(sinkPort);
  await sink.start();
  const replay = new HermesReplay({ port: replayPort, mode: "replay", updates: usable, now: () => chainTime(chain.client), apiKey: "rehearsal-key" });
  if (!liveHermes) await replay.start();

  // 3. env file via the real keeper:init, then rehearsal settings
  const envFile = join(OUT, "fork.env");
  const deployments = join(OUT, "fork-deployments-143.json");
  // The owner is a REAL Safe (v1.4.1 factory + singleton already deployed on Monad mainnet), 2-of-2
  // throwaway signers; the timelock procedure later executes as that Safe (anvil impersonation).
  const funderKey = generatePrivateKey();
  await setBalance(chain.client, privateKeyToAccount(funderKey).address, parseEther("100000"));
  const owner = (await step("fork", "owner = a real Safe (2-of-2) created through the canonical SafeProxyFactory on the fork", async () => {
    const signers = [privateKeyToAccount(generatePrivateKey()).address, privateKeyToAccount(generatePrivateKey()).address];
    const safe = await createSafe(chain, privateKeyToAccount(funderKey), signers, 2);
    report.fork.ownerSafe = { safe, signers, threshold: 2 };
    return { detail: `Safe ${safe} (owners ${signers.length}, threshold 2)`, safe };
  }, { fatal: true }))!.safe as Address;
  await step("fork", "keeper:init --network mainnet (hot keys → rehearsal env, mode 600)", async () => {
    const out = await runCli("fork-keeper-init", "keeper/src/init-env.ts", ["--network", "mainnet", "--env", envFile]);
    appendFileSync(
      envFile,
      [
        "",
        "# ---- rehearsal overrides (anvil fork; throwaway keys) ----",
        `KEEPER_RPC_URL=${rpcUrl}`,
        `OWNER_MULTISIG_ADDRESS=${owner}`,
        `KEEPER_PORT=${keeperPort}`,
        "KEEPER_CORS_ORIGIN=http://localhost:3000",
        `DEPLOYMENTS_OUT=${deployments}`,
        `ALERT_WEBHOOK_URL=http://127.0.0.1:${sinkPort}/webhook`,
        liveHermes ? `PYTH_HERMES_URL=${envStr("PYTH_HERMES_URL") ?? "https://hermes.pyth.network"}` : `PYTH_HERMES_URL=${replay.url}`,
        liveHermes ? `PYTH_API_KEY=${envStr("PYTH_API_KEY")}` : "PYTH_API_KEY=rehearsal-key",
        "HERMES_OUTAGE_ALERT_MS=8000",
        "MONITOR_INTERVAL_MS=3000",
        "ALERT_REPEAT_MS=600000",
        // Harvested updates are 40–100 s apart: the replayed "latest" price is legitimately that old.
        liveHermes ? "" : "ALERT_PRICE_AGE_WARN_S=150",
        liveHermes ? "" : "ALERT_PRICE_AGE_CRITICAL_S=600",
        "",
      ].join("\n"),
    );
    chmodSync(envFile, 0o600);
    return out.split("\n").filter((l) => /keeper\[|deployer|guardian|ops/.test(l)).length + " role addresses printed (keys only in the file)";
  }, { fatal: true });

  // 4. keeper:fund through the real CLI (preview, then send from a funder key given by env var)
  await step("fork", "keeper:fund --network mainnet (preview from measured gas, then --send from a funder)", async () => {
    const preview = await runCli("fork-keeper-fund-preview", "keeper/src/fund-roles.ts", ["--network", "mainnet", "--env", envFile, "--roles", "deployer,guardian,ops,keepers"]);
    assert(/preview only/.test(preview), "preview did not stop before sending");
    const sent = await runCli("fork-keeper-fund-send", "keeper/src/fund-roles.ts", ["--network", "mainnet", "--env", envFile, "--roles", "deployer,guardian,ops,keepers", "--send", "--funder-env", "REHEARSAL_FUNDER_KEY"], {
      REHEARSAL_FUNDER_KEY: funderKey,
    });
    const n = (sent.match(/success/g) ?? []).length;
    assert(n === 11, `expected 11 transfers, saw ${n}`);
    return `preview printed targets; 11 transfers sent from the funder (3-block spacing for Monad's reserve rule)`;
  });

  // DeployProd checks markPrice() (stored Pyth price ≤ maxPriceAge) at the end: put the fork clock
  // right after a harvested update so the wrapper's Pyth refresh pushes a fresh one.
  if (!liveHermes) {
    const now = await chainTime(chain.client);
    const u = usable.find((x) => x.messages[feeds[0].toLowerCase()].publishTime > now + 1);
    if (u) await warpTo(chain.client, u.messages[feeds[0].toLowerCase()].publishTime + 1);
  }

  // 5. deploy through the real deploy:mainnet CLI (REHEARSAL_DEPLOY_HOOK: a module exporting
  //    `deploy(envFile, rpcUrl, outFile)` replaces it — debugging only, labelled in the report)
  await step("fork", "deploy:mainnet (DeployProd.s.sol, preflight + on-chain verification)", async () => {
    const hook = envStr("REHEARSAL_DEPLOY_HOOK");
    if (hook) {
      const m = (await import(hook)) as { deploy: (env: string, rpc: string, out: string) => Promise<string> };
      report.fork.deployPath = `custom hook ${hook} (NOT DeployProd.s.sol)`;
      return `custom deploy hook: ${await m.deploy(envFile, rpcUrl, deployments)}`;
    }
    report.fork.deployPath = "npm run deploy:mainnet (contracts/script/DeployProd.s.sol)";
    const out = await runCli("fork-deploy", "scripts/deploy-mainnet.ts", ["--network", "mainnet", "--env", envFile, "--rpc", rpcUrl]);
    assert(/all checks passed/.test(out.split("post-deploy verification")[1] ?? ""), "post-deploy verification did not pass");
    const gasLine = /forge: (\d+) txs · ([\d.]+)M gas used · ([\d.]+)M gas limit/.exec(out);
    if (gasLine) {
      report.gas.limits.deploy = Math.round(Number(gasLine[3]) * 1e6);
      report.gas.used.deploy = Math.round(Number(gasLine[2]) * 1e6);
    }
    return `deployed + verified (${gasLine ? `${gasLine[1]} txs, ${gasLine[2]}M gas used / ${gasLine[3]}M limit` : "gas n/a"})`;
  }, { fatal: true });
  const dep = readProdDeployment(deployments);
  assert(dep, "no rehearsal deployment file");
  report.fork.deployment = dep.raw;
  const minExecDelay = Number(await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "minExecDelay" }));
  const minFee = await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "minExecutionFee" });
  const w: World = { chain, dep, keeperPort, minExecDelay };
  process.env.KEEPER_RPC_URL = rpcUrl;

  // 6. lane seeding + traders (AUSD via storage cheats on the real AUSD contract)
  const treasury = privateKeyToAccount(generatePrivateKey());
  const traders = Array.from({ length: 8 }, (_, lane) => laneAccount(lane).account);
  await step("fork", "launch seeding via the treasury Safe batch (`timelock seed`): 8 × fundLane 200 AUSD + 8 × backstopDeposit 100 AUSD", async () => {
    await setBalance(chain.client, treasury.address, parseEther("1000"));
    await dealToken(chain.client, dep.ausd, treasury.address, BigInt(8 * 300 * 1e6));
    const outDir = join(OUT, "timelock");
    const out = await runCli("fork-seed-batch", "keeper/src/prod/timelock.ts", ["seed", "--network", "mainnet", "--env", envFile, "--rpc", rpcUrl, "--insurance", "200", "--pool", "100", "--out", outDir]);
    const file = /Safe Transaction Builder file for the TREASURY Safe: (\S+)/.exec(out)?.[1];
    assert(file, "no seed batch file");
    const batch = JSON.parse(readFileSync(join(REPO_ROOT, file), "utf8")) as { transactions: Array<{ to: Address; data: Hex; value: string }> };
    // The treasury "Safe" executes the batch's calls in order (here: a plain key standing in for it).
    for (const t of batch.transactions) await sendAs(chain, treasury, t.to, t.data, BigInt(t.value));
    const sol = await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "solvency" });
    assert(sol[3], "insolvent after seeding");
    return `${batch.transactions.length} calls from ${rel(join(REPO_ROOT, file))}; solvency() held ${Number(sol[0]) / 1e6} = liabilities ${Number(sol[1]) / 1e6}`;
  });
  const userGas: Record<string, bigint[]> = { approve: [], deposit: [], commitOrder: [], withdraw: [], cancelOrder: [] };
  await step("fork", "8 traders (one per lane) deposit the 50 AUSD cap; the 51st AUSD reverts DepositCapExceeded", async () => {
    for (const t of traders) {
      await setBalance(chain.client, t.address, parseEther("100"));
      await dealToken(chain.client, dep.ausd, t.address, BigInt(60e6));
      userGas.approve.push((await approve(w, t, dep.ausd, BigInt(60e6))).gasUsed);
      userGas.deposit.push((await txAs(w, t, "deposit", [BigInt(50e6)])).gasUsed);
    }
    const r = await revertName(w, traders[0].address, "deposit", [BigInt(1e6)]);
    assert(r === "DepositCapExceeded", `51st AUSD: expected DepositCapExceeded, got ${r}`);
    return "8 × 50 AUSD deposited; cap edge enforced (DepositCapExceeded)";
  });

  // 7. production keeper
  await step("fork", "start the production keeper (--network mainnet, rehearsal env)", async () => {
    startKeeper("fork-keeper", envFile, rpcUrl);
    const h = await waitHealth(keeperPort);
    assert(h.production === true && h.priceSource === "pyth", "health: production/priceSource");
    const dis = await fetch(`http://127.0.0.1:${keeperPort}/faucet`, { method: "POST" });
    const crash = await fetch(`http://127.0.0.1:${keeperPort}/crash`, { method: "POST" });
    assert(dis.status === 403 && crash.status === 403, `demo endpoints must answer 403 (faucet ${dis.status}, crash ${crash.status})`);
    report.fork.healthAtStart = h;
    return `/health production=true priceSource=pyth paused=${h.paused}; /faucet and /crash → 403`;
  }, { fatal: true });

  // ---- order rounds on harvested updates ----
  const price18 = (u: HarvestedUpdate, sym: string) => {
    const m = u.messages[KNOWN.feeds[sym].toLowerCase()];
    return (BigInt(m.price) * WAD) / BigInt(10) ** BigInt(-m.expo);
  };
  let cursor = 0;
  const nextUpdate = async (margin = 4): Promise<HarvestedUpdate | null> => {
    const now = await chainTime(chain.client);
    while (cursor < usable.length && usable[cursor].messages[feeds[0].toLowerCase()].publishTime - minExecDelay <= now + margin) cursor++;
    return cursor < usable.length ? usable[cursor++] : null;
  };
  const tOf = (u: HarvestedUpdate) => u.messages[feeds[0].toLowerCase()].publishTime;
  const markets = Object.fromEntries(Object.keys(KNOWN.feeds).map((s) => [s, dep.markets[s]])) as Record<string, Hex>;
  const orderRounds: unknown[] = [];

  /** --hermes live: the latest REAL Hermes prices (through the keeper's proxy) as a pseudo update. */
  const liveSnapshot = async (): Promise<HarvestedUpdate> => {
    const r = await getJson<{ parsed: Array<{ id: string; price: { price: string; conf: string; expo: number; publish_time: number }; metadata?: { prev_publish_time?: number } }> }>(
      `http://127.0.0.1:${keeperPort}/hermes/v2/updates/price/latest?${feeds.map((f) => `ids[]=${f}`).join("&")}`,
    );
    assert(r.status === 200, `keeper Hermes proxy answered ${r.status}`);
    const messages: HarvestedUpdate["messages"] = {};
    for (const p of r.body.parsed) messages[`0x${p.id.replace(/^0x/, "")}`.toLowerCase()] = { price: p.price.price, conf: p.price.conf, expo: p.price.expo, publishTime: p.price.publish_time, prevPublishTime: p.metadata?.prev_publish_time ?? p.price.publish_time - 1 };
    return { block: 0, txHash: "0x" as Hex, blob: "0x" as Hex, slot: "live", messages };
  };

  const round = async (label: string, build: (u: HarvestedUpdate) => Array<{ trader: number; market: string; size: bigint; margin: bigint; acceptable: bigint; expect: "executed" | "failed"; tag: string }>) => {
    if (liveHermes) {
      // Real time: commit now; the keeper fetches the first REAL Hermes update ≥ execAfter.
      const snap = await liveSnapshot();
      const committed: Committed[] = [];
      for (const s of build(snap)) {
        const h = await sendCommit(w, traders[s.trader], markets[s.market], s.size, s.margin, s.acceptable, minFee);
        committed.push({ label: `${label}:${s.tag}`, trader: s.trader, hash: h, expect: s.expect });
      }
      await orderIdsFrom(w, committed);
      const res = await waitResolved(w, committed, 90_000);
      orderRounds.push({ label, hermes: "live", orders: res });
      return { T: committed[0].execAfter ?? 0, res };
    }
    const u = await nextUpdate();
    if (!u) throw new Error("no harvested update left in the fork window (raise --lookback)");
    const T = tOf(u);
    const specs = build(u);
    const committed: Committed[] = [];
    await mineAt(chain.client, T - minExecDelay, async () => {
      const hashes: Hex[] = [];
      for (const s of specs) {
        const h = await sendCommit(w, traders[s.trader], markets[s.market], s.size, s.margin, s.acceptable, minFee);
        committed.push({ label: `${label}:${s.tag}`, trader: s.trader, hash: h, expect: s.expect });
        hashes.push(h);
      }
      return hashes;
    });
    await orderIdsFrom(w, committed);
    for (const c of committed) {
      const r = await chain.client.getTransactionReceipt({ hash: c.hash });
      userGas.commitOrder.push(r.gasUsed);
    }
    assert(committed.every((c) => c.execAfter === T), `execAfter ≠ the harvested publish time ${T}`);
    const res = await waitResolved(w, committed, 90_000);
    orderRounds.push({ label, publishTime: T, harvestedTx: u.txHash, orders: res });
    return { T, res };
  };

  await step("fork", "round A: 8 lanes open positions (MON/SOL/BTC, long/short, 2–5x) executed by 8 lane keepers with REAL Pyth updates", async () => {
    const { res, T } = await round("A", (u) =>
      traders.map((_, i) => {
        const sym = ["MON/AUSD", "SOL/AUSD", "BTC/AUSD"][i % 3];
        const long = i % 2 === 0;
        const p = price18(u, sym);
        const notional = BigInt((40 + 10 * (i % 4)) * 1e6);
        const margin = BigInt(20e6);
        return { trader: i, market: sym, size: long ? sizeFor(notional, p) : -sizeFor(notional, p), margin, acceptable: long ? (p * BigInt(102)) / BigInt(100) : (p * BigInt(98)) / BigInt(100), expect: "executed" as const, tag: `lane${i}-${sym}-${long ? "long" : "short"}` };
      }),
    );
    const lat = res.map((r) => r.latencyS).filter((x): x is number => x !== null);
    return { detail: `8/8 executed at the first update ≥ execAfter (publishTime ${T}); keeper latency after execAfter ${Math.min(...lat)}–${Math.max(...lat)} s`, res };
  });

  await step("fork", "round B: second leg (other leg needs a fresh price: appended update on v3 / on-demand push on v2), partial reduce, and a slippage miss → OrderFailed (executor still paid)", async () => {
    const { res } = await round("B", (u) => {
      const pSol = price18(u, "SOL/AUSD");
      const pMon = price18(u, "MON/AUSD");
      const pBtc = price18(u, "BTC/AUSD");
      return [
        // trader 0 holds MON long → adds a SOL short: other legs → keeper appends a fresh all-feed update
        { trader: 0, market: "SOL/AUSD", size: -sizeFor(BigInt(20e6), pSol), margin: BigInt(10e6), acceptable: (pSol * BigInt(98)) / BigInt(100), expect: "executed" as const, tag: "lane0-second-leg" },
        // trader 2 (BTC long? lane 2 → BTC/AUSD long): reduce by half
        { trader: 2, market: "BTC/AUSD", size: -sizeFor(BigInt(20e6), pBtc), margin: BigInt(0), acceptable: (pBtc * BigInt(97)) / BigInt(100), expect: "executed" as const, tag: "lane2-reduce" },
        // trader 6 (MON long): acceptable price far below the fill → SlippageExceeded → OrderFailed
        { trader: 6, market: "MON/AUSD", size: sizeFor(BigInt(15e6), pMon), margin: BigInt(5e6), acceptable: (pMon * BigInt(90)) / BigInt(100), expect: "failed" as const, tag: "lane6-slippage" },
      ];
    });
    const owed = await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "executionFeesOwed", args: [readKeeperAddress(envFile, 6)] });
    assert(owed > BigInt(0), "lane-6 keeper was not credited for the failed order");
    const h = await getJson<{ pricePush: { mode: string; pushes: number; feedsPushed: number; gasLimit: string }; executor: { otherLegs: string } }>(`http://127.0.0.1:${keeperPort}/health`);
    const pp = h.body.pricePush;
    const how = h.body.executor.otherLegs;
    report.fork.pricePushAfterB = { ...pp, otherLegs: how };
    // executeOrder gas: single-leg vs multi-leg (the second leg)
    const txs = await getJson<{ recent: Array<{ kind: string; gasLimit: string; gasUsed: string | null; meta: { otherLegs?: number } }> }>(`http://127.0.0.1:${keeperPort}/txs`);
    const ex = txs.body.recent.filter((t) => t.kind === "executeOrder");
    const multi = ex.filter((t) => (t.meta.otherLegs ?? 0) > 0).map((t) => Number(t.gasLimit));
    const single = ex.filter((t) => !t.meta.otherLegs).map((t) => Number(t.gasLimit));
    report.fork.executeOrderGas = { singleLegMaxLimit: Math.max(...single), multiLegLimits: multi };
    if (how === "push") {
      assert(pp.pushes >= 1, `the second leg needed a fresh stored MON price but the keeper pushed ${pp.pushes} times`);
      return { detail: `second leg executed after an on-demand Pyth push (${pp.pushes} push, ${pp.feedsPushed} feed, ${pp.gasLimit} gas limit; exec ${multi.join("/")} vs single-leg max ${Math.max(...single)}), reduce executed, slippage → Failed; lane-6 keeper credited ${formatEther(owed)} MON`, res };
    }
    assert(multi.length >= 1, "no multi-leg execution recorded");
    return { detail: `second leg executed with the other leg's fresh update APPENDED to the fill (contract v3+; no push: ${pp.pushes} pushes; exec gas limit ${multi.join("/")} vs single-leg max ${Math.max(...single)}), reduce executed, slippage → Failed; lane-6 keeper credited ${formatEther(owed)} MON`, res };
  });

  await step("fork", "withdraw with a Pyth update fetched through the keeper's Hermes proxy (/hermes/v2/…)", async () => {
    const ids = feeds.map((f) => `ids[]=${f}`).join("&");
    const r = await getJson<{ binary: { data: string[] } }>(`http://127.0.0.1:${keeperPort}/hermes/v2/updates/price/latest?${ids}`);
    assert(r.status === 200 && r.body.binary.data.length > 0, `proxy answered ${r.status}`);
    const data = r.body.binary.data.map((d) => `0x${d}` as Hex);
    parseAccumulatorUpdate(data[0]);
    const g = await txAs(w, traders[1], "withdraw", [BigInt(1e6), data]);
    userGas.withdraw.push(g.gasUsed);
    const bad = await fetch(`http://127.0.0.1:${keeperPort}/hermes/v2/updates/price/latest?ids[]=0x${"ab".repeat(32)}`);
    assert(bad.status === 400, "proxy must refuse foreign feed ids");
    return `trader 1 (open position) withdrew 1 AUSD with the proxied real update (${g.gasUsed} gas); foreign feeds → 400`;
  });

  // real-Pyth gas probes for the auction calls (healthy accounts → fixed verification cost)
  await step("fork", "gas probes: startAuctions / backstopTakeBatch / expireBatch / cancelAuction with a REAL 3-feed Pyth update", async () => {
    const u = await getJson<{ binary: { data: string[] } }>(`http://127.0.0.1:${keeperPort}/hermes/v2/updates/price/latest?${feeds.map((f) => `ids[]=${f}`).join("&")}`);
    const data = u.body.binary.data.map((d) => `0x${d}` as Hex);
    const k3 = readKeeperAddress(envFile, 3);
    const est = async (fn: string, a: unknown[]) =>
      chain.client.estimateGas({ account: k3, to: dep.clearinghouse, data: encodeFunctionData({ abi: clearinghouseAbi as Abi, functionName: fn, args: a }) });
    const probes = {
      startAuctions: await est("startAuctions", [3, [traders[3].address], data]),
      backstopTakeBatch: await est("backstopTakeBatch", [3, [traders[3].address], data]),
      expireBatch: await est("expireBatch", [3, [traders[3].address], data]),
      cancelAuction: await est("cancelAuction", [traders[3].address, data]),
    };
    report.fork.realPythProbeGas = probes;
    // Pyth push cost (pyth.updatePriceFeeds): 1 feed and 3 feeds, Hermes-style subset blobs.
    const u1 = await getJson<{ binary: { data: string[] } }>(`http://127.0.0.1:${keeperPort}/hermes/v2/updates/price/latest?ids[]=${feeds[0]}`);
    const push = async (blobs: Hex[]) =>
      chain.client.estimateGas({ account: k3, to: KNOWN.pyth, data: encodeFunctionData({ abi: pythAbi, functionName: "updatePriceFeeds", args: [blobs] }) });
    const push1 = await push(u1.body.binary.data.map((d) => `0x${d}` as Hex));
    const push3 = await push(data);
    report.fork.pythPushGas = { oneFeed: push1, threeFeeds: push3 };
    return { detail: `${Object.entries(probes).map(([k, v]) => `${k} ${v}`).join(" · ")} · pyth.updatePriceFeeds 1 feed ${push1} / 3 feeds ${push3}`, probes };
  });

  // pause semantics
  await step("fork", "guardian:pause CLI → paused; deposit (no positions) and new increase orders revert IsPaused; withdraw still works", async () => {
    const pauseOut = await runCli("fork-guardian-pause", "keeper/src/prod/guardian.ts", ["--network", "mainnet", "--env", envFile, "--rpc", rpcUrl]);
    const pg = /gas used (\d+) \/ limit (\d+)/.exec(pauseOut);
    if (pg) {
      report.gas.used.pause = Number(pg[1]);
      report.gas.limits.pause = Number(pg[2]);
    }
    const paused = await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "paused" });
    assert(paused, "not paused");
    const fresh = laneAccount(4).account;
    await setBalance(chain.client, fresh.address, parseEther("10"));
    await dealToken(chain.client, dep.ausd, fresh.address, BigInt(10e6));
    await approve(w, fresh, dep.ausd, BigInt(10e6));
    const dep1 = await revertName(w, fresh.address, "deposit", [BigInt(5e6)]);
    assert(dep1 === "IsPaused", `deposit while paused: ${dep1}`);
    // trader 7 holds only a SOL short: a BTC buy is a NEW position (an increase)
    const inc = await revertName(w, traders[7].address, "commitOrder", [markets["BTC/AUSD"], BigInt(1), BigInt(1e6), BigInt(1)], minFee);
    assert(inc === "IsPaused", `increase while paused: ${inc}`);
    const ids = feeds.map((f) => `ids[]=${f}`).join("&");
    const r = await getJson<{ binary: { data: string[] } }>(`http://127.0.0.1:${keeperPort}/hermes/v2/updates/price/latest?${ids}`);
    await txAs(w, traders[3], "withdraw", [BigInt(1e6), r.body.binary.data.map((d) => `0x${d}` as Hex)]);
    return "paused; deposit → IsPaused, increase commit → IsPaused, withdraw OK";
  });

  await step("fork", "while paused: a reduce/close order still commits and executes", async () => {
    const { res } = await round("C-paused", (u) => {
      const p = price18(u, "SOL/AUSD");
      return [{ trader: 1, market: "SOL/AUSD", size: sizeFor(BigInt(20e6), p), margin: BigInt(0), acceptable: (p * BigInt(103)) / BigInt(100), expect: "executed" as const, tag: "lane1-reduce-while-paused" }];
    });
    return { detail: "reduce executed while paused", res };
  });

  if (liveHermes) skip("fork", "Hermes outage drill", "needs the local Hermes replay (--hermes replay)");
  else await step("fork", "Hermes outage drill: 25 s of 503s → backoff + `hermes:down` alert, then recovery and a late execution (`exec:late`)", async () => {
    replay.outage(25_000);
    const { res } = await round("D-outage", (u) => {
      const p = price18(u, "BTC/AUSD");
      // trader 5 is short BTC: a reduce is a buy
      return [{ trader: 5, market: "BTC/AUSD", size: sizeFor(BigInt(10e6), p), margin: BigInt(0), acceptable: (p * BigInt(103)) / BigInt(100), expect: "executed" as const, tag: "lane5-reduce-during-outage" }];
    });
    await sleep(4_000);
    const keys = sink.keys();
    assert(keys.includes("hermes:down"), `no hermes:down alert (got ${keys.join(", ")})`);
    assert(keys.includes("resolved:hermes:down"), "hermes:down never resolved");
    return { detail: `executed after the outage (latency ${res[0].latencyS} s); alerts: ${keys.filter((k) => /hermes|exec:late/.test(k)).join(", ")}`, res };
  });

  if (liveHermes) skip("fork", "expired order", "needs the local Hermes replay (--hermes replay)");
  else await step("fork", "expired order: no Pyth update in [execAfter, deadline] → keeper alerts `exec:expired`; user cancels after the deadline and gets the fee back", async () => {
    // Commit after the LAST harvested update: Hermes (replay) never has a first update ≥ execAfter.
    const last = usable[usable.length - 1];
    const now = await chainTime(chain.client);
    const t0 = Math.max(now + 2, tOf(last) + 5);
    const c: Committed[] = [];
    await mineAt(chain.client, t0, async () => {
      // trader 4 is long SOL: a tiny reduce (allowed while paused) that can never get a price
      const h = await sendCommit(w, traders[4], markets["SOL/AUSD"], BigInt(-1), BigInt(0), BigInt(1), minFee);
      c.push({ label: "E-expire", trader: 4, hash: h, expect: "executed" });
      return [h];
    });
    await orderIdsFrom(w, c);
    const o = (await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "getOrder", args: [c[0].orderId!] })) as unknown as { deadline: bigint };
    await warpTo(chain.client, Number(o.deadline) + 2);
    await sleep(6_000);
    const keys = sink.keys();
    assert(keys.some((k) => k.startsWith("exec:expired")), `no exec:expired alert (got ${keys.join(", ")})`);
    const before = await chain.client.getBalance({ address: traders[4].address });
    const g = await txAs(w, traders[4], "cancelOrder", [c[0].orderId!]);
    userGas.cancelOrder.push(g.gasUsed);
    const after = await chain.client.getBalance({ address: traders[4].address });
    const status = ((await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "getOrder", args: [c[0].orderId!] })) as unknown as { status: number }).status;
    assert(status === 4, `order status ${status}, expected Cancelled (4)`);
    return `alerted; cancelOrder by the user: Cancelled, balance change ${formatEther(after - before)} MON (fee ${formatEther(minFee)} refunded minus cancel gas)`;
  });

  await step("fork", "funding: the OPS key's updateFunding txs landed for every market", async () => {
    const tx = await getJson<{ byKind: Record<string, { sent: number; success: number; avgGasLimit: string }> }>(`http://127.0.0.1:${keeperPort}/txs`);
    const f = tx.body.byKind.updateFunding;
    assert(f && f.success >= 3, `updateFunding successes: ${f?.success ?? 0}`);
    const states = await Promise.all(Object.values(markets).map((m) => chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "fundingState", args: [m] })));
    // The keeper's off-chain copy of the rate formula must give exactly what the contract stored:
    // every FundingUpdated(market, ratePerSec, index, skewNotional) event is re-derived from its skew.
    const logs = await chain.client.getLogs({ address: dep.clearinghouse, fromBlock: BigInt(dep.deployBlock), toBlock: "latest" } as never);
    const evs = (logs as Array<{ data: Hex; topics: [Hex, ...Hex[]] }>).flatMap((l) => {
      try {
        const e = decodeEventLog({ abi: clearinghouseAbi, data: l.data, topics: l.topics });
        return e.eventName === "FundingUpdated" ? [e.args as unknown as { market: Hex; ratePerSec: bigint; skewNotional: bigint }] : [];
      } catch {
        return [];
      }
    });
    let checked = 0;
    for (const e of evs) {
      const m = (await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "getMarket", args: [e.market] })) as readonly [boolean, string, Hex, bigint, bigint, bigint];
      const t = targetRate(e.skewNotional, m[3], m[5]);
      assert(t === e.ratePerSec, `${m[1]}: keeper formula ${t} ≠ stored ${e.ratePerSec} (skew ${e.skewNotional})`);
      checked++;
    }
    const h = await getJson<{ funding: { skippedUnchanged: number } }>(`http://127.0.0.1:${keeperPort}/health`);
    return `${f.success} updateFunding txs (avg gas limit ${f.avgGasLimit}), ${h.body.funding.skippedUnchanged} interval(s) skipped as unchanged; all ${checked} FundingUpdated rates equal the keeper's formula (current ${states.map((s) => s[1].toString()).join(" / ")} per s)`;
  });

  await step("fork", "LP two-step exit (v3): request 50 lane-0 shares → immediate withdraw reverts WithdrawNotReady → after the 1 h delay (warped) withdraw inside the 1 h window → the request is single-use", async () => {
    const shares = await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "backstopSharesOf", args: [0, treasury.address] });
    const half = shares / BigInt(2);
    await txAs(w, treasury, "backstopRequestWithdraw", [0, half]);
    const early = await revertName(w, treasury.address, "backstopWithdraw", [0, half, []]);
    assert(early === "WithdrawNotReady", `immediate withdraw: ${early}`);
    const req = await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "backstopWithdrawRequest", args: [0, treasury.address] });
    const window = Number(req[2]) - Number(req[1]);
    await warpTo(chain.client, Number(req[1]) + 5);
    const before = await chain.client.readContract({ address: dep.ausd, abi: erc20Abi, functionName: "balanceOf", args: [treasury.address] });
    await txAs(w, treasury, "backstopWithdraw", [0, half / BigInt(2), []]);
    const after = await chain.client.readContract({ address: dep.ausd, abi: erc20Abi, functionName: "balanceOf", args: [treasury.address] });
    const again = await revertName(w, treasury.address, "backstopWithdraw", [0, half / BigInt(2), []]);
    assert(again === "NoWithdrawRequest", `second withdraw on the same request: ${again} (expected NoWithdrawRequest: single-use)`);
    report.fork.lpExit = { requested: half.toString(), withdrawn: (after - before).toString(), windowS: window };
    return `requested ${Number(half) / 1e6} shares; WithdrawNotReady before ${req[1]}; window ${window} s; withdrew ${Number(after - before) / 1e6} AUSD for ${Number(half / BigInt(2)) / 1e6} shares; reusing the request → NoWithdrawRequest`;
  });

  await step("fork", "unpause through the timelock (Safe JSON prepared, the Safe impersonated, delay warped)", async () => {
    const delay = Number(envStr("TIMELOCK_MIN_DELAY_SECONDS") ?? readEnvVar(envFile, "TIMELOCK_MIN_DELAY_SECONDS") ?? 86400);
    const outDir = join(OUT, "timelock");
    await runCli("fork-timelock-schedule", "keeper/src/prod/timelock.ts", ["prepare", "--network", "mainnet", "--env", envFile, "--rpc", rpcUrl, "--call", "unpause()", "--out", outDir, "--impersonate", "schedule"]);
    const early = await runCli("fork-timelock-status", "keeper/src/prod/timelock.ts", ["status", "--network", "mainnet", "--env", envFile, "--rpc", rpcUrl, "--call", "unpause()"]);
    assert(/scheduled, ready at/.test(early), "operation not scheduled");
    await warpTo(chain.client, (await chainTime(chain.client)) + delay + 5);
    await runCli("fork-timelock-execute", "keeper/src/prod/timelock.ts", ["prepare", "--network", "mainnet", "--env", envFile, "--rpc", rpcUrl, "--call", "unpause()", "--out", outDir, "--impersonate", "execute"]);
    const paused = await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "paused" });
    assert(!paused, "still paused");
    return `scheduled → warped ${delay} s → executed; paused=false (Safe Transaction Builder JSON in ${rel(outDir)})`;
  });

  await step("fork", "after the 24 h warp the replayed prices are a day old → `oracle:stale:*` critical alerts fire", async () => {
    await sleep(8_000);
    const keys = sink.keys();
    assert(keys.some((k) => k.startsWith("oracle:stale")), `no oracle:stale alert (got ${keys.join(", ")})`);
    return keys.filter((k) => k.startsWith("oracle:stale")).join(", ");
  });

  await step("fork", "solvency() and nativeSolvency() hold at the end; per-lane ledgers", async () => {
    const [sol, nat] = await Promise.all([
      chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "solvency" }),
      chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "nativeSolvency" }),
    ]);
    const s = await getJson<Record<string, unknown>>(`http://127.0.0.1:${keeperPort}/solvency`);
    report.fork.solvency = s.body;
    assert(sol[3] && nat[2], `solvent ${sol[3]} native ${nat[2]}`);
    return `AUSD held ${Number(sol[0]) / 1e6} vs liabilities ${Number(sol[1]) / 1e6} (surplus ${sol[2]}); MON held ${formatEther(nat[0])} vs ${formatEther(nat[1])}`;
  });

  // collect
  const health = await getJson<Record<string, unknown>>(`http://127.0.0.1:${keeperPort}/health`).catch(() => null);
  const txs = await getJson<{ byKind: Record<string, Record<string, string | number>>; recent: unknown[] }>(`http://127.0.0.1:${keeperPort}/txs`).catch(() => null);
  report.fork.healthAtEnd = health?.body;
  report.fork.keeperTxs = txs?.body;
  report.fork.orders = orderRounds;
  report.fork.userGasUsed = Object.fromEntries(Object.entries(userGas).map(([k, v]) => [k, v.length ? { n: v.length, max: Math.max(...v.map(Number)), avg: Math.round(v.reduce((a, b) => a + Number(b), 0) / v.length) } : null]));
  report.fork.hermes = liveHermes ? { mode: "live" } : { mode: "replay", requests: replay.requests.length, statuses: countBy(replay.requests.map((r) => String(r.status))) };
  report.alerts.fork = sink.keys();
  const byKind = txs?.body.byKind ?? {};
  for (const k of ["executeOrder", "updateFunding", "pause"]) {
    if (byKind[k]) {
      report.gas.limits[k] = Number(byKind[k].maxGasLimit);
      report.gas.used[k] = Math.round(Number(byKind[k].gasUsed) / Math.max(1, Number(byKind[k].success)));
    }
  }
  if (!args.keep) {
    await stopKeeper("fork-keeper");
    await replay.stop();
    await sink.stop();
  }
}

/**
 * Gas limits for the MON budget (keeper/src/prod/budget.ts reads report.gas.limits via
 * `keeper:fund -- --gas-report`). Auction txs with REAL Pyth = fork real-Pyth probe + (mock tx −
 * mock probe): the per-account work comes from the mock leg, the Pyth verification from the fork.
 */
function deriveBudgetGas(): void {
  const L = report.gas.limits;
  const real = report.fork.realPythProbeGas as Record<string, bigint> | undefined;
  const mock = report.mock.mockPythProbeGas as Record<string, bigint> | undefined;
  const margin = (g: number) => Math.ceil(g * 1.1);
  const map: Array<[string, string]> = [
    ["startAuction", "startAuctions"],
    ["backstopTake", "backstopTakeBatch"],
    ["expire", "expireBatch"],
    ["cancelAuction", "cancelAuction"],
  ];
  if (real && mock) {
    for (const [budgetKey, kind] of map) {
      const mockTx = L[`${kind}:mockPyth`];
      if (mockTx === undefined) continue;
      L[budgetKey] = Math.max(margin(Number(real[kind])), mockTx - margin(Number(mock[kind])) + margin(Number(real[kind])));
    }
    report.gas.notes.push("startAuction/backstopTake/expire/cancelAuction = fork real-Pyth probe + (MockPyth-leg tx − MockPyth probe), as gas LIMITs with the keeper's 10% margin");
  }
  if (L.executeOrder !== undefined) {
    const k = (report.fork.keeperTxs as { byKind?: Record<string, Record<string, string>> } | undefined)?.byKind?.executeOrder;
    if (k) L.executeOrderAvg = Number(k.avgGasLimit);
    report.gas.notes.push("executeOrder = the MAX limit seen (an order on a second leg carries a fresh 3-feed update); executeOrderAvg = the average");
  }
  const pg = report.fork.pythPushGas as { oneFeed: bigint; threeFeeds: bigint } | undefined;
  if (pg) {
    L.pythPush = margin(Number(pg.threeFeeds));
    L.pythPush1 = margin(Number(pg.oneFeed));
    report.gas.notes.push("pythPush = pyth.updatePriceFeeds with a 3-feed Hermes subset (real Pyth, fork), +10 %; pythPush1 = 1 feed");
  }
  if (L.pause === undefined) L.pause = 60_000;
  L.transfer = 21_000;
}

function countBy(xs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}

function readEnvVar(file: string, name: string): string | undefined {
  const line = readFileSync(file, "utf8").split("\n").find((l) => l.startsWith(`${name}=`));
  return line?.slice(name.length + 1).trim() || undefined;
}

function readKeeperAddress(envFile: string, lane: number): Address {
  const keys = (readEnvVar(envFile, "KEEPER_PRIVATE_KEYS") ?? "").split(",");
  return privateKeyToAccount(keys[lane] as Hex).address;
}

async function stopKeeper(name: string): Promise<void> {
  void name;
  for (const c of children.splice(0)) {
    if (c.exitCode === null) c.kill("SIGTERM");
  }
  await sleep(1_500);
}

// ---------------------------------------------------------------------------
// MOCK LEG (liquidations with the TEST MockPyth on a plain anvil)
// ---------------------------------------------------------------------------

async function mockLeg(args: Record<string, string | true>): Promise<void> {
  const port = Number(args["mock-port"] ?? 8947);
  const keeperPort = 8787 + port - 8545; // 9188
  const sinkPort = port + 100;
  const hermesPort = port + 101;
  assert(await portFree(port), `port ${port} is busy`);

  // artifacts from a shadow root (never races contracts/out)
  const shadow = shadowRoot("rehearsal");
  await step("mock", "forge build (shadow root) for MockPyth + MockAUSD artifacts", async () => {
    await new Promise<void>((resolve, reject) => {
      const c = spawn(foundryBin("forge"), ["build", "--root", shadow.root], { cwd: shadow.root, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      c.stdout.on("data", (d: Buffer) => (out += d));
      c.stderr.on("data", (d: Buffer) => (out += d));
      c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(out.slice(-500)))));
    });
    return "built";
  }, { fatal: true });
  const artifact = (file: string, name: string) => JSON.parse(readFileSync(join(shadow.root, "out", file, `${name}.json`), "utf8")) as { abi: Abi; bytecode: { object: Hex } };

  // 2 s blocks: the rescue top-up must land within the 3 blocks before the lane-2 pool takes.
  const anvil = await startAnvil({ port, chainId: 143, blockTime: 2, logFile: join(OUT, "anvil-mock.log") });
  children.push(anvil);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const chain = await connectMainnet(rpcUrl);
  report.mock.chain = { label: chain.label, network: chain.network, chainId: chain.chainId, pyth: "TEST MockPyth (contracts/test/prod/mocks)", ausd: "MockAUSD (6 dp)" };

  const admin = privateKeyToAccount(generatePrivateKey());
  await setBalance(chain.client, admin.address, parseEther("100000"));
  const wallet = createWalletClient({ account: admin, chain: chain.chain, transport: http(rpcUrl) });
  const deploy = async (file: string, name: string, ctorArgs: unknown[] = []) => {
    const a = artifact(file, name);
    const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args: ctorArgs, chain: chain.chain });
    const r = await chain.client.waitForTransactionReceipt({ hash });
    return { address: r.contractAddress!, abi: a.abi };
  };
  const mockAusd = await deploy("MockAUSD.sol", "MockAUSD", [admin.address]);
  const mockPyth = await deploy("MockPyth.sol", "MockPyth");
  // DeployProd requires a live supply (totalSupply > 0)
  await sendAs(chain, admin, mockAusd.address, encodeFunctionData({ abi: mockAusd.abi, functionName: "ownerMint", args: [admin.address, BigInt(10_000e6)] }));
  const now0 = await chainTime(chain.client);
  const startPx: Record<string, bigint> = { "MON/AUSD": BigInt(3e8), "SOL/AUSD": BigInt(180e8), "BTC/AUSD": BigInt(100_000e8) };
  for (const [sym, p] of Object.entries(startPx)) {
    await sendAs(chain, admin, mockPyth.address, encodeFunctionData({ abi: mockPyth.abi, functionName: "setStoredPrice", args: [KNOWN.feeds[sym], p, p / BigInt(10_000), -8, BigInt(now0)] }));
  }

  const sink = new WebhookSink(sinkPort);
  await sink.start();
  const hermes = new HermesReplay({ port: hermesPort, mode: "mock", now: () => chainTime(chain.client), apiKey: "rehearsal-key" });
  for (const [sym, p] of Object.entries(startPx)) hermes.prices.set(KNOWN.feeds[sym].toLowerCase(), { price: p, conf: p / BigInt(10_000), expo: -8 });
  await hermes.start();

  const envFile = join(OUT, "mock.env");
  const deployments = join(OUT, "mock-deployments-143.json");
  const ownerAcct = privateKeyToAccount(generatePrivateKey()); // EOA owner here (no Safe on a plain anvil)
  const owner = ownerAcct.address;
  await runCli("mock-keeper-init", "keeper/src/init-env.ts", ["--network", "mainnet", "--env", envFile]);
  appendFileSync(
    envFile,
    [
      "",
      "# ---- rehearsal overrides (plain anvil + TEST MockPyth + MockAUSD; throwaway keys) ----",
      `KEEPER_RPC_URL=${rpcUrl}`,
      `OWNER_MULTISIG_ADDRESS=${owner}`,
      "OWNER_IS_EOA=true",
      "TIMELOCK_MIN_DELAY_SECONDS=3600",
      `AUSD_ADDRESS=${mockAusd.address}`,
      `PYTH_ADDRESS=${mockPyth.address}`,
      `KEEPER_PORT=${keeperPort}`,
      "KEEPER_CORS_ORIGIN=http://localhost:3000",
      `DEPLOYMENTS_OUT=${deployments}`,
      `ALERT_WEBHOOK_URL=http://127.0.0.1:${sinkPort}/webhook`,
      `PYTH_HERMES_URL=${hermes.url}`,
      "PYTH_API_KEY=rehearsal-key",
      "MONITOR_INTERVAL_MS=3000",
      "SWEEPER_MIN_INTERVAL_MS=500",
      "",
    ].join("\n"),
  );
  for (const k of ["DEPLOYER_PRIVATE_KEY", "GUARDIAN_PRIVATE_KEY", "OPS_PRIVATE_KEY"]) {
    await setBalance(chain.client, privateKeyToAccount(readEnvVar(envFile, k) as Hex).address, parseEther("1000"));
  }
  for (const key of (readEnvVar(envFile, "KEEPER_PRIVATE_KEYS") ?? "").split(",")) await setBalance(chain.client, privateKeyToAccount(key as Hex).address, parseEther("1000"));

  await step("mock", "deploy:mainnet against MockAUSD + MockPyth (same DeployProd.s.sol, same verification; OWNER_IS_EOA=true here)", async () => {
    const hook = envStr("REHEARSAL_DEPLOY_HOOK");
    if (hook) {
      const m = (await import(hook)) as { deploy: (env: string, rpc: string, out: string) => Promise<string> };
      report.mock.deployPath = `custom hook ${hook} (NOT DeployProd.s.sol)`;
      return `custom deploy hook: ${await m.deploy(envFile, rpcUrl, deployments)}`;
    }
    report.mock.deployPath = "npm run deploy:mainnet (contracts/script/DeployProd.s.sol)";
    const out = await runCli("mock-deploy", "scripts/deploy-mainnet.ts", ["--network", "mainnet", "--env", envFile, "--rpc", rpcUrl]);
    assert(/all checks passed/.test(out.split("post-deploy verification")[1] ?? ""), "verification failed");
    return "deployed + verified";
  }, { fatal: true });
  const dep = readProdDeployment(deployments)!;
  const minExecDelay = Number(await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "minExecDelay" }));
  const minFee = await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "minExecutionFee" });
  const w: World = { chain, dep, keeperPort, minExecDelay };
  const markets = dep.markets;
  const read = <T>(fn: string, a: unknown[] = []) =>
    chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi as Abi, functionName: fn, args: a }) as Promise<T>;

  // Insurance: 200 per lane, but only 20 on lane 7 (its OI cap = 5 × 20 = 100 AUSD). The lane fund is
  // every position's counterparty, so a lane goes into DEFICIT when a trader's realised PROFIT exceeds
  // its insurance. Pools on lanes 0–6; lane 7 has none (its auction expires).
  await step("mock", "seed insurance (lanes 0–6 × 200, lane 7 × 20) and backstop pools (lanes 0–6 × 150; lane 7 none)", async () => {
    await approve(w, admin, mockAusd.address, BigInt(10_000e6));
    for (let lane = 0; lane < 8; lane++) await txAs(w, admin, "fundLane", [lane, lane === 7 ? BigInt(20e6) : BigInt(200e6)]);
    for (let lane = 0; lane < 7; lane++) await txAs(w, admin, "backstopDeposit", [lane, BigInt(150e6), []]);
    const cap7 = await read<bigint>("laneOiCap", [7, markets["BTC/AUSD"]]);
    return `seeded; lane-7 OI cap ${Number(cap7) / 1e6} AUSD (insurance × 5; pools don't count since v2)`;
  });

  const traders = Array.from({ length: 8 }, (_, lane) => laneAccount(lane).account);
  const curer = laneAccount(2).account;
  const bystander = laneAccount(7).account;
  const expiree = laneAccount(7).account;
  const reducer = laneAccount(7).account;
  await step("mock", "lanes 0–6 + a lane-2 curer open ~9.5x MON longs; lane 7: two 9.5x MON longs (no pool: one will expire, one will reduce-close in auction) and a 3x BTC SHORT; a lane-7 bystander only deposits", async () => {
    for (const t of [...traders, curer, bystander, expiree, reducer]) {
      await setBalance(chain.client, t.address, parseEther("100"));
      await sendAs(chain, admin, mockAusd.address, encodeFunctionData({ abi: mockAusd.abi, functionName: "ownerMint", args: [t.address, BigInt(100e6)] }));
      await approve(w, t, mockAusd.address, BigInt(100e6));
      const amt = t === curer ? BigInt(30e6) : t === bystander ? BigInt(40e6) : t === expiree || t === reducer ? BigInt(5_000_000) : BigInt(50e6);
      await txAs(w, t, "deposit", [amt]);
    }
    startKeeper("mock-keeper", envFile, rpcUrl);
    await waitHealth(keeperPort);
    const pMon = BigInt(3) * WAD;
    const pBtc = BigInt(100_000) * WAD;
    const c: Committed[] = [];
    for (const [label, t] of [["open-lane7-expiree", expiree], ["open-lane7-reducer", reducer]] as const) {
      // 45 AUSD notional on 4.75 AUSD margin (9.5x): two of them fit lane 7's 100 AUSD OI cap
      const h = await sendCommit(w, t, markets["MON/AUSD"], sizeFor(BigInt(45e6), pMon), BigInt(4_750_000), (pMon * BigInt(101)) / BigInt(100), minFee);
      c.push({ label, trader: -1, hash: h, expect: "executed" });
    }
    for (const [i, t] of [...traders, curer].entries()) {
      if (t === traders[7]) {
        const h = await sendCommit(w, t, markets["BTC/AUSD"], -sizeFor(BigInt(90e6), pBtc), BigInt(30e6), (pBtc * BigInt(99)) / BigInt(100), minFee);
        c.push({ label: "open-lane7-btc-short", trader: i, hash: h, expect: "executed" });
        continue;
      }
      const margin = t === curer ? BigInt(28e6) : BigInt(46e6);
      const notional = (margin * BigInt(95)) / BigInt(10);
      const h = await sendCommit(w, t, markets["MON/AUSD"], sizeFor(notional, pMon), margin, (pMon * BigInt(101)) / BigInt(100), minFee);
      c.push({ label: `open-${i}`, trader: i, hash: h, expect: "executed" });
    }
    await orderIdsFrom(w, c);
    await waitResolved(w, c, 60_000);
    return "11/11 positions open (mock Pyth via the same executor path)";
  }, { fatal: true });

  await step("mock", "guardian pause, THEN a −10% MON move (mock Hermes only) → 10 auctions start while paused", async () => {
    await runCli("mock-guardian-pause", "keeper/src/prod/guardian.ts", ["--network", "mainnet", "--env", envFile, "--rpc", rpcUrl]);
    const p = (startPx["MON/AUSD"] * BigInt(900)) / BigInt(1000);
    hermes.prices.set(KNOWN.feeds["MON/AUSD"].toLowerCase(), { price: p, conf: p / BigInt(10_000), expo: -8 });
    const deadline = Date.now() + 60_000;
    for (;;) {
      const started = await Promise.all(Array.from({ length: 8 }, (_, lane) => read<readonly bigint[]>("auctionStats", [lane])));
      const total = started.reduce((s, x) => s + Number(x[1]), 0);
      if (total >= 10) return `auctions started on ${total} accounts while paused`;
      if (Date.now() > deadline) throw new Error(`only ${total} auctions started`);
      await sleep(1_000);
    }
  });

  // The cure must come right after the auctions start: the lane-2 pool takes at 75 bps (3 blocks = 6 s here).
  // The lane-7 reduce-close can follow — lane 7 has no pool, its auctions run 20 blocks.
  await step("mock", "beyond-cap rescue top-up (v4): the curer (30 AUSD deposited, cap 50) deposits its whole topUpAllowance through depositWithPrice with a /hermes-style update → collateral above the cap → equity ≥ maintenance → the keeper cancels its auction (cure)", async () => {
    const ids = [KNOWN.feeds["MON/AUSD"]];
    const u = await getJson<{ binary: { data: string[] } }>(`${hermes.url}/v2/updates/price/latest?${ids.map((f) => `ids[]=${f}`).join("&")}`, { authorization: "Bearer rehearsal-key" });
    const data = u.body.binary.data.map((d) => `0x${d}` as Hex);
    // the exemption at FRESH prices = what depositWithPrice will compute (simulate it)
    const allowanceView = await read<bigint>("topUpAllowance", [curer.address]).catch(() => null);
    const before = await read<readonly [bigint, number, boolean, readonly Hex[], bigint, bigint]>("getAccount", [curer.address]);
    const h0 = await simulateHealth(w, curer.address, data);
    const im = h0[2];
    const target = im; // v4: TOP_UP_TARGET_BPS = 10000 → restore equity to 100 % of initial margin
    const amount = target - h0[0] - BigInt(10_000); // a hair below the exemption (no cap room used)
    assert(amount > BigInt(50e6) - before[0], `the rescue amount ${amount} would fit under the cap anyway`);
    const fee = await chain.client.readContract({ address: dep.pyth, abi: pythAbi, functionName: "getUpdateFee", args: [data] });
    await txAs(w, curer, "depositWithPrice", [amount, data], fee);
    const after = await read<readonly [bigint, number, boolean, readonly Hex[], bigint, bigint]>("getAccount", [curer.address]);
    assert(after[0] > BigInt(50e6), `collateral ${after[0]} not above the 50 AUSD cap`);
    const deadline = Date.now() + 40_000;
    for (;;) {
      const a = await read<readonly [boolean, bigint, number]>("auctionOf", [curer.address]);
      if (!a[0]) break;
      if (Date.now() > deadline) throw new Error("still in auction after the rescue top-up");
      await sleep(1_000);
    }
    report.mock.rescueTopUp = { allowanceViewStale: allowanceView?.toString() ?? null, deposited: amount.toString(), collateralAfter: after[0].toString() };
    return `deposited ${Number(amount) / 1e6} AUSD via depositWithPrice (topUpAllowance view at stale storage: ${allowanceView === null ? "n/a" : Number(allowanceView) / 1e6}); collateral ${Number(before[0]) / 1e6} → ${Number(after[0]) / 1e6} AUSD (> 50 cap); auction cancelled (cured at maintenance)`;
  });

  await step("mock", "v3: a reduce-only CLOSE by a lane-7 account in auction executes (keeper appends the current price) and ends its auction", async () => {
    const a0 = await read<readonly [boolean, bigint, number]>("auctionOf", [reducer.address]);
    assert(a0[0], "the reducer is not in auction");
    const pos = await read<{ size: bigint }>("getPosition", [reducer.address, markets["MON/AUSD"]]);
    const h = await sendCommit(w, reducer, markets["MON/AUSD"], -pos.size, BigInt(0), BigInt(1), minFee);
    const c: Committed[] = [{ label: "reduce-close-in-auction", trader: -1, hash: h, expect: "executed" }];
    await orderIdsFrom(w, c);
    await waitResolved(w, c, 60_000);
    const a1 = await read<readonly [boolean, bigint, number]>("auctionOf", [reducer.address]);
    assert(!a1[0], "auction still active after the reduce-only close");
    return "reduce-only close filled while in auction; auction ended (AuctionCancelled)";
  });

  await step("mock", "MON wave resolves: the 7 lane pools take (≥ 75 bps), lane 7 (no pool) expires at the max discount; nothing left in auction", async () => {
    const deadline = Date.now() + 120_000;
    for (;;) {
      const st = await Promise.all(Array.from({ length: 8 }, (_, lane) => read<readonly bigint[]>("auctionStats", [lane])));
      const active = st.reduce((s, x) => s + Number(x[0]), 0);
      const sum = (i: number) => st.reduce((s, x) => s + Number(x[i]), 0);
      if (active === 0 && sum(2) >= 7 && sum(4) >= 1 && sum(3) >= 2) return `started ${sum(1)} · taken ${sum(2)} · cancelled ${sum(3)} (cure + reduce-close) · expired ${sum(4)}`;
      if (Date.now() > deadline) throw new Error(`${active} auctions still active, taken ${sum(2)}`);
      await sleep(1_500);
    }
  });

  await step("mock", "deficit drill: BTC −90% (mock Hermes) → the lane-7 BTC short closes (reduce works while paused) with a profit larger than lane 7's insurance → bad debt → `solvency:lane7` alert", async () => {
    const p = (startPx["BTC/AUSD"] * BigInt(100)) / BigInt(1000);
    hermes.prices.set(KNOWN.feeds["BTC/AUSD"].toLowerCase(), { price: p, conf: p / BigInt(10_000), expo: -8 });
    const pos = await read<{ size: bigint }>("getPosition", [traders[7].address, markets["BTC/AUSD"]]);
    const h = await sendCommit(w, traders[7], markets["BTC/AUSD"], pos.size, BigInt(0), BigInt(10) ** BigInt(30), minFee);
    const c: Committed[] = [{ label: "close-lane7-btc-short", trader: 7, hash: h, expect: "executed" }];
    await orderIdsFrom(w, c);
    await waitResolved(w, c, 60_000);
    const ls = await read<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>("laneSolvency", [7]);
    assert(ls[2] < BigInt(0), `lane 7 surplus ${ls[2]} (expected a deficit)`);
    await sleep(5_000); // one monitor cycle
    const keys = sink.keys();
    assert(keys.includes("solvency:lane7"), `no solvency:lane7 alert (got ${keys.join(", ")})`);
    report.mock.laneDeficit = { surplus: ls[2].toString(), insurance: ls[3].toString(), badDebt: ls[4].toString(), haircutBps: Number(ls[5]) };
    return `lane 7 surplus ${Number(ls[2]) / 1e6} AUSD, bad debt ${Number(ls[4]) / 1e6}, haircut ${Number(ls[5]) / 100}%; alert solvency:lane7 fired`;
  });

  await step("mock", "haircut: the lane-7 bystander withdraws 40 AUSD (works while paused) and is paid previewWithdraw < 40 → LaneHaircut → `haircut:lane7` alert", async () => {
    const preview = await read<bigint>("previewWithdraw", [bystander.address, BigInt(40e6)]);
    const before = await chain.client.readContract({ address: mockAusd.address, abi: erc20Abi, functionName: "balanceOf", args: [bystander.address] });
    await txAs(w, bystander, "withdraw", [BigInt(40e6), []]);
    const after = await chain.client.readContract({ address: mockAusd.address, abi: erc20Abi, functionName: "balanceOf", args: [bystander.address] });
    assert(after - before === preview && preview < BigInt(40e6), `paid ${after - before}, preview ${preview}`);
    await sleep(4_000);
    assert(sink.keys().includes("haircut:lane7"), "no haircut:lane7 alert");
    return `paid ${Number(after - before) / 1e6} of 40 AUSD (= previewWithdraw); alert haircut:lane7 fired`;
  });

  await step("mock", "unpause through the timelock (EOA owner, 1 h delay warped); a FRESH deposit into lane 7 now reverts LaneInDeficit", async () => {
    const outDir = join(OUT, "timelock");
    await runCli("mock-timelock-schedule", "keeper/src/prod/timelock.ts", ["prepare", "--network", "mainnet", "--env", envFile, "--rpc", rpcUrl, "--call", "unpause()", "--out", outDir, "--impersonate", "schedule"]);
    await warpTo(chain.client, (await chainTime(chain.client)) + 3_605);
    await runCli("mock-timelock-execute", "keeper/src/prod/timelock.ts", ["prepare", "--network", "mainnet", "--env", envFile, "--rpc", rpcUrl, "--call", "unpause()", "--out", outDir, "--impersonate", "execute"]);
    assert(!(await read<boolean>("paused")), "still paused");
    const fresh = laneAccount(7).account;
    await setBalance(chain.client, fresh.address, parseEther("10"));
    await sendAs(chain, admin, mockAusd.address, encodeFunctionData({ abi: mockAusd.abi, functionName: "ownerMint", args: [fresh.address, BigInt(10e6)] }));
    await approve(w, fresh, mockAusd.address, BigInt(10e6));
    const r = await revertName(w, fresh.address, "deposit", [BigInt(5e6)]);
    assert(r === "LaneInDeficit", `fresh deposit into the deficit lane: ${r}`);
    report.mock.freshDepositor = fresh.address;
    return "unpaused; fresh deposit into lane 7 → LaneInDeficit";
  });

  await step("mock", "deficit repair (runbook 13b): the treasury Safe batch `timelock seed --lanes 7 --insurance <bad debt + 10>` repays it → surplus ≥ 0, `solvency:lane7` resolves, fresh deposits work again", async () => {
    const before = await read<readonly bigint[]>("laneSolvency", [7]);
    const need = Math.ceil(Number(before[4]) / 1e6) + 10; // whole AUSD: bad debt + 10 buffer
    const out = await runCli("mock-repair-batch", "keeper/src/prod/timelock.ts", ["seed", "--network", "mainnet", "--env", envFile, "--rpc", rpcUrl, "--insurance", String(need), "--lanes", "7", "--out", join(OUT, "timelock")]);
    const file = /Safe Transaction Builder file for the TREASURY Safe: (\S+)/.exec(out)?.[1];
    assert(file, "no repair batch file");
    const batch = JSON.parse(readFileSync(join(REPO_ROOT, file), "utf8")) as { transactions: Array<{ to: Address; data: Hex; value: string }> };
    for (const t of batch.transactions) await sendAs(chain, admin, t.to, t.data, BigInt(t.value));
    const ls = await read<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>("laneSolvency", [7]);
    assert(ls[2] >= BigInt(0) && ls[4] === BigInt(0), `surplus ${ls[2]} badDebt ${ls[4]}`);
    await sleep(5_000);
    assert(sink.keys().includes("resolved:solvency:lane7"), "solvency:lane7 never resolved");
    const fresh = report.mock.freshDepositor as Address;
    const r = await revertName(w, fresh, "deposit", [BigInt(5e6)]);
    assert(r === null, `fresh deposit after repair: ${r}`);
    return `lane 7 surplus ${Number(ls[2]) / 1e6} AUSD, bad debt 0; alert resolved; fresh deposits accepted`;
  });

  await step("mock", "solvency() (token level) and nativeSolvency() after liquidations + the deficit drill", async () => {
    const [sol, nat] = await Promise.all([read<readonly [bigint, bigint, bigint, boolean]>("solvency"), read<readonly [bigint, bigint, boolean]>("nativeSolvency")]);
    assert(sol[3] && nat[2], "insolvent");
    const st = await Promise.all(Array.from({ length: 8 }, (_, lane) => read<readonly bigint[]>("auctionStats", [lane])));
    const sum = (i: number) => st.reduce((s, x) => s + Number(x[i]), 0);
    report.mock.auctionStats = { started: sum(1), taken: sum(2), cancelled: sum(3), expired: sum(4) };
    return `AUSD held ${Number(sol[0]) / 1e6} vs Σ lane holdings ${Number(sol[1]) / 1e6}; MON ok; auctions started ${sum(1)} · taken ${sum(2)} · cancelled ${sum(3)} · expired ${sum(4)}`;
  });

  // Same probes as on the fork, with the MockPyth update (healthy account with a position, so the
  // health check runs): the difference to the real auction txs isolates per-account gas from Pyth
  // verification, which is then re-based on the fork's REAL-Pyth probes for the budget.
  await step("mock", "gas probes with the MockPyth update (to re-base auction gas on the fork's real-Pyth probes)", async () => {
    const k2 = privateKeyToAccount((readEnvVar(envFile, "KEEPER_PRIVATE_KEYS") ?? "").split(",")[2] as Hex).address;
    const u = await getJson<{ binary: { data: string[] } }>(`${hermes.url}/v2/updates/price/latest?${Object.values(KNOWN.feeds).map((f) => `ids[]=${f}`).join("&")}`, { authorization: "Bearer rehearsal-key" });
    const data = u.body.binary.data.map((d) => `0x${d}` as Hex);
    const est = async (fn: string, a: unknown[]) =>
      chain.client.estimateGas({ account: k2, to: dep.clearinghouse, data: encodeFunctionData({ abi: clearinghouseAbi as Abi, functionName: fn, args: a }) });
    const probes = {
      startAuctions: await est("startAuctions", [2, [curer.address], data]),
      backstopTakeBatch: await est("backstopTakeBatch", [2, [curer.address], data]),
      expireBatch: await est("expireBatch", [2, [curer.address], data]),
      cancelAuction: await est("cancelAuction", [curer.address, data]),
    };
    report.mock.mockPythProbeGas = probes;
    return { detail: Object.entries(probes).map(([k, v]) => `${k} ${v}`).join(" · "), probes };
  });
  await step("mock", "dead-feed drill (v3, runbook \"Dead feed\"): MON's feed stops → `oracle:stale:MON/AUSD`; `timelock feed-swap` to a backup feed through the timelock while `pyth:push` keeps it fresh → MarketFeedReplaced → the keeper switches live; a too-far feed reverts FeedSwapDeviation; a MON order then fills on the new feed", async () => {
    const oldFeed = KNOWN.feeds["MON/AUSD"].toLowerCase();
    const NEW = keccak256(toHex("paraclr.rehearsal.MON.backup-feed")).toLowerCase() as Hex;
    const BAD = keccak256(toHex("paraclr.rehearsal.MON.off-by-20pct")).toLowerCase() as Hex;
    const cur = hermes.prices.get(oldFeed)!;
    hermes.prices.set(NEW, { ...cur });
    hermes.prices.set(BAD, { ...cur, price: (cur.price * BigInt(12)) / BigInt(10) });
    hermes.frozen.set(oldFeed, (await chainTime(chain.client)) - 120); // the feed "dies"
    await sleep(6_000);
    assert(sink.keys().includes("oracle:stale:MON/AUSD"), `no oracle:stale:MON/AUSD alert (got ${sink.keys().join(", ")})`);
    const tl = ["--network", "mainnet", "--env", envFile, "--rpc", rpcUrl, "--market", "MON/AUSD", "--feed", NEW, "--max-deviation-bps", "500", "--out", join(OUT, "timelock")];
    await runCli("mock-feedswap-schedule", "keeper/src/prod/timelock.ts", ["feed-swap", ...tl, "--impersonate", "schedule"]);
    await warpTo(chain.client, (await chainTime(chain.client)) + 3_605);
    const push = await runCli("mock-pyth-push", "keeper/src/prod/push-cli.ts", ["--network", "mainnet", "--env", envFile, "--rpc", rpcUrl, "--feeds", `${NEW},${BAD}`, "--count", "1"]);
    const pushGas = /gas (\d+)\/(\d+)/.exec(push);
    const bad = await revertName(w, dep.timelock!, "replaceMarketFeed", [markets["MON/AUSD"], BAD, BigInt(500)]);
    assert(bad === "FeedSwapDeviation", `a 20 %-off feed: ${bad} (expected FeedSwapDeviation)`);
    await runCli("mock-feedswap-execute", "keeper/src/prod/timelock.ts", ["feed-swap", ...tl, "--impersonate", "execute"]);
    const onChain = await read<readonly [readonly Hex[], readonly string[], readonly Hex[]]>("getMarkets");
    assert(onChain[2][onChain[1].indexOf("MON/AUSD")].toLowerCase() === NEW, "the contract still uses the old MON feed");
    const deadline = Date.now() + 30_000;
    for (;;) {
      const h = await getJson<{ oracle: { feeds: Record<string, string> } }>(`http://127.0.0.1:${keeperPort}/health`);
      if (h.body.oracle.feeds["MON/AUSD"]?.toLowerCase() === NEW && sink.keys().includes("gov:feed")) break;
      if (Date.now() > deadline) throw new Error("the keeper did not switch to the new feed");
      await sleep(1_000);
    }
    // a MON order on the new feed: the curer closes its MON position through the executor
    const pos = await read<{ size: bigint }>("getPosition", [curer.address, markets["MON/AUSD"]]);
    const h = await sendCommit(w, curer, markets["MON/AUSD"], -pos.size, BigInt(0), BigInt(1), minFee);
    const c: Committed[] = [{ label: "close-on-new-feed", trader: -1, hash: h, expect: "executed" }];
    await orderIdsFrom(w, c);
    await waitResolved(w, c, 60_000);
    report.mock.feedSwap = { oldFeed, newFeed: NEW, pushGas: pushGas ? { used: pushGas[1], limit: pushGas[2] } : null };
    return `old feed stale → alert; schedule → 1 h → push (${pushGas ? pushGas[1] : "?"} gas) → FeedSwapDeviation for the 20 %-off feed → execute → keeper on the new feed (alert gov:feed); the curer's MON close filled on the new feed`;
  });

  const txs = await getJson<{ byKind: Record<string, Record<string, string | number>> }>(`http://127.0.0.1:${keeperPort}/txs`).catch(() => null);
  report.mock.keeperTxs = txs?.body;
  report.alerts.mock = sink.keys();
  for (const k of ["startAuctions", "backstopTakeBatch", "expireBatch", "cancelAuction"]) {
    const s = txs?.body.byKind[k];
    if (s) {
      report.gas.limits[`${k}:mockPyth`] = Number(s.maxGasLimit);
      report.gas.used[`${k}:mockPyth`] = Math.round(Number(s.gasUsed) / Math.max(1, Number(s.success)));
    }
  }
  if (!args.keep) {
    await stopKeeper("mock-keeper");
    await hermes.stop();
    await sink.stop();
  }
}


// ---------------------------------------------------------------------------
// SCALE LEG (R2-09): one oversized lane on a plain anvil with the TEST MockPyth. N accounts (600)
// in lane 3 crash together; every startAuctions / backstopTakeBatch must be split into chunks
// below Monad's 30M per-tx gas limit (target 30M × KEEPER_BATCH_HEADROOM = 24M).
// ---------------------------------------------------------------------------

interface Raw {
  from: LocalAccount;
  to: Address;
  data: Hex;
  value?: bigint;
  gas: bigint;
  nonce: number;
}

/** Sign locally (explicit nonces) and broadcast many txs at once, then wait for every receipt. */
async function blast(chain: ProdChain, txs: Raw[], label: string): Promise<{ ok: number; gasUsed: bigint }> {
  const fees = { maxFeePerGas: BigInt(50e9), maxPriorityFeePerGas: BigInt(1e9) };
  const signed = await Promise.all(
    txs.map((t) =>
      t.from.signTransaction!({ type: "eip1559", chainId: chain.chainId, nonce: t.nonce, to: t.to, data: t.data, value: t.value ?? BigInt(0), gas: t.gas, ...fees }),
    ),
  );
  const hashes: Hex[] = [];
  for (let i = 0; i < signed.length; i += 100) {
    hashes.push(...(await Promise.all(signed.slice(i, i + 100).map((raw) => chain.client.sendRawTransaction({ serializedTransaction: raw })))));
  }
  let ok = 0;
  let gasUsed = BigInt(0);
  for (let i = 0; i < hashes.length; i += 100) {
    const rs = await Promise.all(hashes.slice(i, i + 100).map((hash) => chain.client.waitForTransactionReceipt({ hash, pollingInterval: 250, timeout: 180_000 })));
    for (const r of rs) {
      if (r.status === "success") ok++;
      gasUsed += r.gasUsed;
    }
  }
  if (ok !== txs.length) throw new Error(`${label}: ${txs.length - ok} of ${txs.length} txs reverted`);
  return { ok, gasUsed };
}

async function scaleLeg(args: Record<string, string | true>): Promise<void> {
  const port = Number(args["scale-port"] ?? 8948);
  const N = Number(args["scale-accounts"] ?? 600);
  const LANE = 3;
  const keeperPort = 8787 + port - 8545;
  const sinkPort = port + 110;
  const hermesPort = port + 111;
  assert(await portFree(port), `port ${port} is busy`);
  const shadow = shadowRoot("rehearsal");
  const artifact = (file: string, name: string) => JSON.parse(readFileSync(join(shadow.root, "out", file, `${name}.json`), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  if (!existsSync(join(shadow.root, "out", "MockPyth.sol", "MockPyth.json"))) {
    await new Promise<void>((resolve, reject) => {
      const c = spawn(foundryBin("forge"), ["build", "--root", shadow.root], { cwd: shadow.root, stdio: "ignore" });
      c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("forge build failed"))));
    });
  }
  const anvil = await startAnvil({ port, chainId: 143, blockTime: 1, logFile: join(OUT, "anvil-scale.log") });
  children.push(anvil);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const chain = await connectMainnet(rpcUrl);
  const admin = privateKeyToAccount(generatePrivateKey());
  await setBalance(chain.client, admin.address, parseEther("100000"));
  const wallet = createWalletClient({ account: admin, chain: chain.chain, transport: http(rpcUrl) });
  const deploy = async (file: string, name: string, ctorArgs: unknown[] = []) => {
    const a = artifact(file, name);
    const r = await chain.client.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args: ctorArgs, chain: chain.chain }) });
    return { address: r.contractAddress!, abi: a.abi };
  };
  const mockAusd = await deploy("MockAUSD.sol", "MockAUSD", [admin.address]);
  const mockPyth = await deploy("MockPyth.sol", "MockPyth");
  await sendAs(chain, admin, mockAusd.address, encodeFunctionData({ abi: mockAusd.abi, functionName: "ownerMint", args: [admin.address, BigInt(1_000_000e6)] }));
  const now0 = await chainTime(chain.client);
  const startPx: Record<string, bigint> = { "MON/AUSD": BigInt(3e8), "SOL/AUSD": BigInt(180e8), "BTC/AUSD": BigInt(100_000e8) };
  for (const [sym, px] of Object.entries(startPx)) {
    await sendAs(chain, admin, mockPyth.address, encodeFunctionData({ abi: mockPyth.abi, functionName: "setStoredPrice", args: [KNOWN.feeds[sym], px, px / BigInt(10_000), -8, BigInt(now0)] }));
  }
  const sink = new WebhookSink(sinkPort);
  await sink.start();
  const hermes = new HermesReplay({ port: hermesPort, mode: "mock", now: () => chainTime(chain.client), apiKey: "rehearsal-key" });
  for (const [sym, px] of Object.entries(startPx)) hermes.prices.set(KNOWN.feeds[sym].toLowerCase(), { price: px, conf: px / BigInt(10_000), expo: -8 });
  await hermes.start();

  const envFile = join(OUT, "scale.env");
  const deployments = join(OUT, "scale-deployments-143.json");
  await runCli("scale-keeper-init", "keeper/src/init-env.ts", ["--network", "mainnet", "--env", envFile]);
  appendFileSync(
    envFile,
    [
      "",
      "# ---- rehearsal overrides (SCALE: plain anvil + TEST MockPyth; relaxed TVL cap so one lane can hold N accounts) ----",
      `KEEPER_RPC_URL=${rpcUrl}`,
      `OWNER_MULTISIG_ADDRESS=${privateKeyToAccount(generatePrivateKey()).address}`,
      "OWNER_IS_EOA=true",
      "TIMELOCK_MIN_DELAY_SECONDS=3600",
      "MAX_TVL_PER_LANE_AUSD=1000000",
      `AUSD_ADDRESS=${mockAusd.address}`,
      `PYTH_ADDRESS=${mockPyth.address}`,
      `KEEPER_PORT=${keeperPort}`,
      "KEEPER_CORS_ORIGIN=http://localhost:3000",
      `DEPLOYMENTS_OUT=${deployments}`,
      `ALERT_WEBHOOK_URL=http://127.0.0.1:${sinkPort}/webhook`,
      `PYTH_HERMES_URL=${hermes.url}`,
      "PYTH_API_KEY=rehearsal-key",
      "MONITOR_INTERVAL_MS=5000",
      "SWEEPER_MIN_INTERVAL_MS=1000",
      "FUNDING_MIN_CHANGE_BPS=1000000",
      "",
    ].join("\n"),
  );
  for (const k of ["DEPLOYER_PRIVATE_KEY", "GUARDIAN_PRIVATE_KEY", "OPS_PRIVATE_KEY"]) {
    await setBalance(chain.client, privateKeyToAccount(readEnvVar(envFile, k) as Hex).address, parseEther("1000"));
  }
  for (const key of (readEnvVar(envFile, "KEEPER_PRIVATE_KEYS") ?? "").split(",")) await setBalance(chain.client, privateKeyToAccount(key as Hex).address, parseEther("10000"));
  await step("scale", "deploy:mainnet (MockPyth + MockAUSD, lane TVL cap raised to 1M AUSD so one lane can hold the book)", async () => {
    const hook = envStr("REHEARSAL_DEPLOY_HOOK");
    if (hook) {
      const m = (await import(hook)) as { deploy: (env: string, rpc: string, out: string) => Promise<string> };
      report.scale.deployPath = `custom hook ${hook} (NOT DeployProd.s.sol)`;
      return `custom deploy hook: ${await m.deploy(envFile, rpcUrl, deployments)}`;
    }
    report.scale.deployPath = "npm run deploy:mainnet (contracts/script/DeployProd.s.sol)";
    const out = await runCli("scale-deploy", "scripts/deploy-mainnet.ts", ["--network", "mainnet", "--env", envFile, "--rpc", rpcUrl]);
    assert(/all checks passed/.test(out.split("post-deploy verification")[1] ?? ""), "verification failed");
    return "deployed + verified";
  }, { fatal: true });
  const dep = readProdDeployment(deployments)!;
  const minFee = await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "minExecutionFee" });
  const w: World = { chain, dep, keeperPort, minExecDelay: 3 };
  const read = <T>(fn: string, a: unknown[] = []) => chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi as Abi, functionName: fn, args: a }) as Promise<T>;

  await step("scale", `lane ${LANE}: insurance 20,000 AUSD (OI cap 100k) + backstop pool 40,000 AUSD`, async () => {
    await approve(w, admin, mockAusd.address, BigInt(60_000e6));
    await txAs(w, admin, "fundLane", [LANE, BigInt(20_000e6)]);
    await txAs(w, admin, "backstopDeposit", [LANE, BigInt(40_000e6), []]);
    return "seeded";
  }, { fatal: true });

  const accts = Array.from({ length: N }, () => laneAccount(LANE).account);
  await step("scale", `${N} accounts in lane ${LANE} each deposit 20 AUSD and commit a 7.5x MON long (blasted, many per block)`, async () => {
    await Promise.all(accts.map((a) => setBalance(chain.client, a.address, parseEther("10"))));
    const adminNonce = await chain.client.getTransactionCount({ address: admin.address });
    await blast(chain, accts.map((a, i) => ({ from: admin, to: mockAusd.address, data: encodeFunctionData({ abi: mockAusd.abi, functionName: "ownerMint", args: [a.address, BigInt(20e6)] }), gas: BigInt(120_000), nonce: adminNonce + i })), "mint");
    await blast(
      chain,
      accts.flatMap((a) => [
        { from: a, to: mockAusd.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [dep.clearinghouse, BigInt(20e6)] }), gas: BigInt(100_000), nonce: 0 },
        { from: a, to: dep.clearinghouse, data: encodeFunctionData({ abi: clearinghouseAbi, functionName: "deposit", args: [BigInt(20e6)] }), gas: BigInt(400_000), nonce: 1 },
      ]),
      "approve+deposit",
    );
    startKeeper("scale-keeper", envFile, rpcUrl);
    await waitHealth(keeperPort);
    const px = BigInt(3) * WAD;
    const size = sizeFor(BigInt(150e6), px);
    await blast(
      chain,
      accts.map((a) => ({ from: a, to: dep.clearinghouse, data: encodeFunctionData({ abi: clearinghouseAbi, functionName: "commitOrder", args: [dep.markets["MON/AUSD"], size, BigInt(20e6), (px * BigInt(101)) / BigInt(100)] }), value: minFee, gas: BigInt(600_000), nonce: 2 })),
      "commit",
    );
    const deadline = Date.now() + 600_000;
    for (;;) {
      const oi = await read<readonly [bigint, bigint]>("laneOpenInterest", [LANE, dep.markets["MON/AUSD"]]);
      if (oi[0] >= BigInt(N) * BigInt(150e6) * BigInt(99) / BigInt(100)) return `lane ${LANE} long OI ${Number(oi[0]) / 1e6} AUSD from ${N} accounts (executed by the lane keeper)`;
      if (Date.now() > deadline) throw new Error(`only ${Number(oi[0]) / 1e6} AUSD of OI after 10 min`);
      await sleep(3_000);
    }
  }, { fatal: true });

  await step("scale", `MON −12 % → ${N} accounts liquidatable at once → startAuctions chunked under 30M gas per tx`, async () => {
    const px = (startPx["MON/AUSD"] * BigInt(880)) / BigInt(1000);
    hermes.prices.set(KNOWN.feeds["MON/AUSD"].toLowerCase(), { price: px, conf: px / BigInt(10_000), expo: -8 });
    const deadline = Date.now() + 300_000;
    for (;;) {
      const st = await read<readonly bigint[]>("auctionStats", [LANE]);
      if (Number(st[1]) >= N) break;
      if (Date.now() > deadline) throw new Error(`only ${st[1]} of ${N} auctions started`);
      await sleep(2_000);
    }
    const tx = await getJson<{ recent: Array<{ kind: string; gasLimit: string; gasUsed: string | null; meta: { accounts?: number } }> }>(`http://127.0.0.1:${keeperPort}/txs`);
    const starts = tx.body.recent.filter((t) => t.kind === "startAuctions");
    const maxLimit = Math.max(...starts.map((t) => Number(t.gasLimit)));
    assert(starts.length >= 2, `expected ≥ 2 startAuctions chunks, saw ${starts.length}`);
    assert(maxLimit <= 30_000_000, `a startAuctions tx has gas limit ${maxLimit} > 30M`);
    report.scale.startAuctions = starts.map((t) => ({ accounts: t.meta.accounts, gasLimit: t.gasLimit, gasUsed: t.gasUsed }));
    return `${N} auctions started in ${starts.length} txs (accounts ${starts.map((t) => t.meta.accounts).join(" + ")}; max gas limit ${(maxLimit / 1e6).toFixed(2)}M; gas used ${starts.map((t) => (Number(t.gasUsed) / 1e6).toFixed(2) + "M").join(" / ")})`;
  }, { fatal: true });

  await step("scale", `pool takes all ${N} in backstopTakeBatch chunks under 30M gas each`, async () => {
    const deadline = Date.now() + 300_000;
    for (;;) {
      const st = await read<readonly bigint[]>("auctionStats", [LANE]);
      if (Number(st[0]) === 0) break;
      if (Date.now() > deadline) throw new Error(`${st[0]} auctions still active (taken ${st[2]}, expired ${st[4]})`);
      await sleep(2_000);
    }
    await sleep(2_000);
    const tx = await getJson<{ recent: Array<{ kind: string; gasLimit: string; gasUsed: string | null; status: string; meta: { accounts?: number } }> }>(`http://127.0.0.1:${keeperPort}/txs`);
    const takes = tx.body.recent.filter((t) => t.kind === "backstopTakeBatch" || t.kind === "expireBatch");
    const maxLimit = Math.max(...takes.map((t) => Number(t.gasLimit)));
    assert(maxLimit <= 30_000_000, `a take/expire tx has gas limit ${maxLimit} > 30M`);
    assert(takes.every((t) => t.status === "success"), "a take/expire chunk failed");
    const st = await read<readonly bigint[]>("auctionStats", [LANE]);
    const h = await getJson<{ sweeper: { chunking: { perAccountGas: Record<string, number>; targetGas: number } } }>(`http://127.0.0.1:${keeperPort}/health`);
    report.scale.takes = takes.map((t) => ({ kind: t.kind, accounts: t.meta.accounts, gasLimit: t.gasLimit, gasUsed: t.gasUsed }));
    report.scale.learntPerAccountGas = h.body.sweeper.chunking.perAccountGas;
    const [sol] = await Promise.all([read<readonly [bigint, bigint, bigint, boolean]>("solvency")]);
    assert(sol[3], "insolvent");
    return `taken ${st[2]} · expired ${st[4]} in ${takes.length} txs (accounts ${takes.map((t) => t.meta.accounts).join(" + ")}; max gas limit ${(maxLimit / 1e6).toFixed(2)}M); learnt per-account gas ${JSON.stringify(h.body.sweeper.chunking.perAccountGas)}; solvent`;
  });
  if (!args.keep) {
    await stopKeeper("scale-keeper");
    await hermes.stop();
    await sink.stop();
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  OUT = typeof args.out === "string" ? args.out : join(CONTRACTS_DIR, "cache", "rehearsal", stamp);
  mkdirSync(OUT, { recursive: true });
  log(`rehearsal → ${rel(OUT)} (local anvil only; nothing is sent to Monad mainnet)`);
  const legs = new Set(String(args.legs ?? "fork,mock,scale").split(","));
  try {
    if (legs.has("fork")) await forkLeg(args).catch((err: unknown) => log(`fork leg aborted: ${(err as Error).message}`));
    for (const c of children.splice(0)) if (c.exitCode === null && !args.keep) c.kill("SIGINT");
    if (legs.has("mock")) await mockLeg(args).catch((err: unknown) => log(`mock leg aborted: ${(err as Error).message}`));
    for (const c of children.splice(0)) if (c.exitCode === null && !args.keep) c.kill("SIGINT");
    if (legs.has("scale")) await scaleLeg(args).catch((err: unknown) => log(`scale leg aborted: ${(err as Error).message}`));
  } finally {
    if (!args.keep) for (const c of children) if (c.exitCode === null) c.kill("SIGINT");
    deriveBudgetGas();
    writeReport();
    const s = report.summary;
    log(`done: ${s.passed} passed · ${s.failed} failed · ${s.skipped} skipped → ${rel(join(OUT, "report.json"))}`);
    if (existsSync(join(OUT, "report.json"))) process.exitCode = s.failed ? 1 : 0;
    setTimeout(() => process.exit(process.exitCode ?? 0), 1_000);
  }
}

main().catch((err: unknown) => {
  console.error(`rehearse:mainnet failed: ${(err as Error)?.message ?? err}`);
  process.exit(1);
});
