// `npm run rehearse:testnet` — the production rehearsal for Monad TESTNET (docs/TESTNET_PLAN.md).
// Nothing touches the real testnet: every transaction goes to local anvil chains.
//
// FORK LEG (anvil fork of https://testnet-rpc.monad.xyz on :8955, --code-size-limit 131072, the REAL
// Agora testnet AUSD + Agora faucet and the REAL Pyth contract):
//   Hermes needs an API key (none here), and nobody pushes Pyth on testnet, so the rehearsal
//   harvests REAL Wormhole-signed Pyth updates (SOL + BTC) from Monad MAINNET transactions — the
//   testnet Pyth has the same guardian set and data source, so it verifies them (checked on chain)
//   — and serves them through a local Hermes-compatible replay. The fork starts at the testnet
//   block matching the harvest window's start. Then, through the real CLIs: keeper:init / keeper:fund
//   (--network testnet) → a real 2-of-2 Safe (canonical SafeProxyFactory 1.4.1 on testnet) as owner →
//   deploy:testnet (DeployProd.s.sol with PROD_MARKETS=SOL/AUSD,BTC/AUSD, 600 s timelock) → AUSD from
//   Agora's faucet (+ storage cheats) → the treasury Safe seeding batch → the production keeper
//   (--network testnet, Monad reserve-balance guard ON) → orders on SOL and BTC executed by the 8
//   lane keepers with real Pyth updates (multi-leg, reduce, slippage miss) → withdraw through the
//   keeper's /hermes proxy (a MON feed id is refused, and Hermes is never asked for MON or AUSD/USD)
//   → guardian pause semantics → Hermes outage drill → expired order + cancel → funding → LP
//   two-step exit → unpause through the 600 s timelock executed as the Safe → solvency.
// FALLBACK LEG (same fork, after the above): the trial-end fallback end to end — oracle:fallback
//   deploy (KeeperSignedPyth, owner = the timelock) → keeper restarted with the price signer →
//   `timelock set-pyth` scheduled as the Safe → 600 s → `pyth:push --signed` → execute → the
//   keeper switches live (gov:oracle, priceSource keeper-signed) → a SOL order fills on a
//   keeper-signed price → withdraw with a proxied signed update → record --live.
// MOCK LEG (plain anvil :8957, chain id 10143, the TEST MockPyth + MockAUSD; real prices don't move
//   enough to liquidate): SOL/BTC positions at 9.5x, pause, SOL −10 % → auctions start while paused,
//   lane pools take them; solvency; per-account auction gas for the budget.
//
// Output: contracts/cache/rehearsal-testnet/<UTC>/ (report.json, logs, throwaway env files) and the
// tracked evidence bench/rehearsal/10143-fork-<UTC>.json (with the contract's sha256). Never
// deployments/10143.json.
//
//   --legs fork,fallback,mock (default all)   --port 8955   --mock-port 8957   --lookback 4000 (mainnet blocks)
//   --keep   leave anvils + keepers running at the end

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  parseAbi,
  parseEther,
  type Abi,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CONTRACTS_DIR, parseArgs, REPO_ROOT, rpcHost } from "../keeper/src/env";
import { clearinghouseAbi, erc20Abi, pythAbi } from "../keeper/src/prod/abi";
import { connectMainnet, KNOWN, KNOWN_TESTNET, MAINNET_RPC_URL, rel, selectProdNetwork, TESTNET_RPC_URL, type Client, type ProdChain } from "../keeper/src/prod/config";
import { readProdDeployment, type ProdDeployment } from "../keeper/src/prod/deployment";
import { targetRate } from "../keeper/src/prod/funding";
import { buildArtifacts } from "./lib/artifacts";
import { harvestUpdates, HermesReplay, updatesWith, type HarvestedUpdate } from "./lib/pyth-replay";
import { chainTime, createSafe, dealToken, laneAccount, mineAt, portFree, sendAs, setBalance, sleep, startAnvil, warpTo, WebhookSink } from "./lib/rehearsal";

selectProdNetwork("testnet");

const SOL = KNOWN.feeds["SOL/AUSD"].toLowerCase() as Hex;
const BTC = KNOWN.feeds["BTC/AUSD"].toLowerCase() as Hex;
const MON = KNOWN.feeds["MON/AUSD"].toLowerCase() as Hex;
const AUSD_USD = "0xd9912df360b5b7f21a122f15bdd5e27f62ce5e72bd316c291f7c86620e07fb2a";
const FEEDS = [SOL, BTC];
const SYMS = ["SOL/AUSD", "BTC/AUSD"] as const;
const FEED_OF: Record<string, Hex> = { "SOL/AUSD": SOL, "BTC/AUSD": BTC };
const CONTRACT_FILE = join(CONTRACTS_DIR, "src", "prod", "ParaclrClearinghouseProd.sol");
const AGORA_FAUCET_ABI = parseAbi(["function requestFunds(address to)", "function faucetDripAmount() view returns (uint256)", "function maxDripFrequency() view returns (uint256)", "function maxAmountToOwn() view returns (uint256)"]);

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

interface Step {
  leg: "fork" | "fallback" | "mock";
  name: string;
  ok: boolean | null;
  ms: number;
  detail: string;
  data?: unknown;
}

const report = {
  kind: "paraclr-testnet-rehearsal",
  startedAt: new Date().toISOString(),
  finishedAt: "",
  notTestnet:
    "Every number here comes from local anvil chains (a fork of Monad testnet with the real testnet AUSD and Pyth, and a plain anvil with the TEST MockPyth). Nothing was sent to Monad testnet or mainnet.",
  contract: {
    name: "ParaclrClearinghouseProd",
    version: "v5",
    sourceSha256: createHash("sha256").update(readFileSync(CONTRACT_FILE)).digest("hex"),
    file: "contracts/src/prod/ParaclrClearinghouseProd.sol",
  },
  fork: {} as Record<string, unknown>,
  fallback: {} as Record<string, unknown>,
  mock: {} as Record<string, unknown>,
  steps: [] as Step[],
  gas: { limits: {} as Record<string, number>, used: {} as Record<string, number>, notes: [] as string[] },
  alerts: { fork: [] as string[], fallback: [] as string[], mock: [] as string[] },
  summary: { passed: 0, failed: 0, skipped: 0 },
};

/** Keepers (stopped between legs) and anvils (kept until the end: the fallback leg reuses the fork). */
const children: ChildProcess[] = [];
const anvils: ChildProcess[] = [];
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
  const line = `[rehearse:testnet ${new Date().toISOString().slice(11, 19)}] ${m}`;
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
  const child = spawn(TSX, [join(REPO_ROOT, "keeper/src/index.ts"), "--network", "testnet", "--env", envFile, "--rpc", rpcUrl], {
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

async function stopChildren(): Promise<void> {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGTERM");
  await sleep(2_000);
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

function readEnvVar(file: string, name: string): string | undefined {
  const line = readFileSync(file, "utf8").split("\n").find((l) => l.startsWith(`${name}=`));
  return line?.slice(name.length + 1).trim() || undefined;
}

function keeperAddress(envFile: string, lane: number): Address {
  return privateKeyToAccount((readEnvVar(envFile, "KEEPER_PRIVATE_KEYS") ?? "").split(",")[lane] as Hex).address;
}

// ---------------------------------------------------------------------------
// trading helpers
// ---------------------------------------------------------------------------

interface World {
  chain: ProdChain;
  dep: ProdDeployment;
  keeperPort: number;
  minExecDelay: number;
  minFee: bigint;
}

async function txAs(w: World, who: LocalAccount, fn: string, args: unknown[], value = BigInt(0)) {
  return sendAs(w.chain, who, w.dep.clearinghouse, encodeFunctionData({ abi: clearinghouseAbi as Abi, functionName: fn, args }), value);
}

async function approve(w: World, who: LocalAccount, token: Address, amount: bigint) {
  return sendAs(w.chain, who, token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [w.dep.clearinghouse, amount] }));
}

async function revertName(w: World, from: Address, fn: string, args: unknown[], value = BigInt(0)): Promise<string | null> {
  try {
    await w.chain.client.simulateContract({ address: w.dep.clearinghouse, abi: clearinghouseAbi as Abi, functionName: fn, args, account: from, value });
    return null;
  } catch (err) {
    const e = err as { cause?: { data?: { errorName?: string } }; shortMessage?: string };
    return e.cause?.data?.errorName ?? e.shortMessage ?? "reverted";
  }
}

async function sendCommit(w: World, who: LocalAccount, market: Hex, sizeDelta: bigint, margin: bigint, acceptable: bigint): Promise<Hex> {
  const wallet = createWalletClient({ account: who, chain: w.chain.chain, transport: http(w.chain.rpcUrl) });
  const data = encodeFunctionData({ abi: clearinghouseAbi, functionName: "commitOrder", args: [market, sizeDelta, margin, acceptable] });
  return wallet.sendTransaction({ to: w.dep.clearinghouse, data, value: w.minFee, gas: BigInt(600_000), chain: w.chain.chain });
}

interface Committed {
  label: string;
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

async function waitResolved(w: World, c: Committed[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  const out: Array<{ label: string; status: number; latencyS: number | null }> = [];
  for (const x of c) {
    for (;;) {
      const o = (await w.chain.client.readContract({ address: w.dep.clearinghouse, abi: clearinghouseAbi, functionName: "getOrder", args: [x.orderId!] })) as unknown as { status: number };
      if (o.status !== 1) {
        let k = null as { body: { latencyS: number | null } } | null;
        for (let i = 0; i < 10; i++) {
          k = await getJson<{ latencyS: number | null }>(`http://127.0.0.1:${w.keeperPort}/orders/${x.orderId}`).catch(() => null);
          if (k?.body?.latencyS !== null && k?.body?.latencyS !== undefined) break;
          await sleep(300);
        }
        out.push({ label: x.label, status: o.status, latencyS: k?.body?.latencyS ?? null });
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
const sizeFor = (notional6: bigint, price18: bigint) => (notional6 * BigInt(10) ** BigInt(30)) / price18;

/** The testnet block whose timestamp is the last one ≤ t (binary search, a dozen RPC calls). */
async function blockAtTime(client: Client, t: number): Promise<number> {
  let hi = Number(await client.getBlockNumber());
  let lo = Math.max(1, hi - 200_000);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const ts = Number((await client.getBlock({ blockNumber: BigInt(mid) })).timestamp);
    if (ts <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function countBy(xs: string[]): Record<string, number> {
  const o: Record<string, number> = {};
  for (const x of xs) o[x] = (o[x] ?? 0) + 1;
  return o;
}

// ---------------------------------------------------------------------------
// FORK LEG (+ FALLBACK LEG on the same fork)
// ---------------------------------------------------------------------------

async function forkLegs(args: Record<string, string | true>, legs: Set<string>): Promise<void> {
  const port = Number(args.port ?? 8955);
  const keeperPort = 8787 + port - 8545; // 9197
  const sinkPort = port + 100;
  const replayPort = port + 101;
  const lookback = Number(args.lookback ?? 4000);
  assert(await portFree(port), `port ${port} is busy (another anvil?)`);
  assert(await portFree(keeperPort), `keeper port ${keeperPort} is busy`);

  // 0. real signed Pyth updates (SOL + BTC) from Monad MAINNET txs; the testnet Pyth verifies them
  const mainnet = createPublicClient({ transport: http(MAINNET_RPC_URL, { retryCount: 4, retryDelay: 500 }) }) as unknown as Client;
  const testnet = createPublicClient({ transport: http(TESTNET_RPC_URL, { retryCount: 4, retryDelay: 500 }) }) as unknown as Client;
  const head = Number(await mainnet.getBlockNumber());
  const mFork = head - lookback;
  let usable: HarvestedUpdate[] = [];
  await step("fork", "harvest real Wormhole-signed Pyth updates (SOL + BTC) from Monad MAINNET txs (read-only)", async () => {
    const all = await harvestUpdates(mainnet, KNOWN.pyth, FEEDS, mFork, head, log);
    usable = updatesWith(all, FEEDS).filter((u) => FEEDS.every((f) => u.messages[f].prevPublishTime < u.messages[f].publishTime));
    writeFileSync(join(OUT, "harvest.json"), JSON.stringify({ mFork, head, updates: all }, null, 2));
    const times = usable.map((u) => u.messages[SOL].publishTime);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    report.fork.harvest = { mainnetHead: head, mainnetFrom: mFork, updates: all.length, usableSolBtc: usable.length, firstT: times[0], lastT: times[times.length - 1], gapS: { min: Math.min(...gaps), max: Math.max(...gaps) } };
    assert(usable.length >= 10, `only ${usable.length} usable updates; raise --lookback`);
    return `${all.length} signed updates from ${new Set(all.map((u) => u.txHash)).size} mainnet txs; ${usable.length} carry SOL+BTC (gaps ${Math.min(...gaps)}–${Math.max(...gaps)} s)`;
  }, { fatal: true });
  const firstT = usable[0].messages[SOL].publishTime;

  // 1. anvil fork of TESTNET at the block matching the harvest window's start
  const forkBlock = await blockAtTime(testnet, firstT - 90);
  await step("fork", `anvil --fork-url ${rpcHost(TESTNET_RPC_URL)} --fork-block-number ${forkBlock} (:${port}, chain 10143, 128 KB code limit)`, async () => {
    const a = await startAnvil({ port, forkUrl: TESTNET_RPC_URL, forkBlock, blockTime: 1, logFile: join(OUT, "anvil-fork.log") });
    anvils.push(a);
    return `fork at testnet block ${forkBlock}`;
  }, { fatal: true });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const chain = await connectMainnet(rpcUrl);
  assert(chain.chainId === 10143 && chain.network === "anvil-fork", `expected an anvil fork of chain 10143, got ${chain.chainId} ${chain.network}`);
  report.fork.chain = { label: chain.label, network: chain.network, chainId: chain.chainId, forkBlock, forkedFrom: rpcHost(TESTNET_RPC_URL) };

  await step("fork", "on-chain facts on the fork: testnet AUSD (6 dp, AUSD, not paused), Agora faucet, Pyth 1.4.6 (fee 1 wei/message), real mainnet-signed update verifies", async () => {
    const c = chain.client;
    const [dec, sym, paused, ver, fee1, drip, freq, maxOwn] = await Promise.all([
      c.readContract({ address: KNOWN_TESTNET.ausd, abi: erc20Abi, functionName: "decimals" }),
      c.readContract({ address: KNOWN_TESTNET.ausd, abi: erc20Abi, functionName: "symbol" }),
      c.readContract({ address: KNOWN_TESTNET.ausd, abi: parseAbi(["function isTransferPaused() view returns (bool)"]), functionName: "isTransferPaused" }),
      c.readContract({ address: KNOWN_TESTNET.pyth, abi: pythAbi, functionName: "version" }),
      c.readContract({ address: KNOWN_TESTNET.pyth, abi: parseAbi(["function singleUpdateFeeInWei() view returns (uint256)"]), functionName: "singleUpdateFeeInWei" }),
      c.readContract({ address: KNOWN_TESTNET.ausdFaucet, abi: AGORA_FAUCET_ABI, functionName: "faucetDripAmount" }),
      c.readContract({ address: KNOWN_TESTNET.ausdFaucet, abi: AGORA_FAUCET_ABI, functionName: "maxDripFrequency" }),
      c.readContract({ address: KNOWN_TESTNET.ausdFaucet, abi: AGORA_FAUCET_ABI, functionName: "maxAmountToOwn" }),
    ]);
    assert(dec === 6 && sym === "AUSD" && paused === false, `AUSD ${dec} ${sym} paused=${paused}`);
    report.fork.facts = { ausd: { decimals: dec, symbol: sym, transferPaused: paused }, pyth: { version: ver, singleUpdateFeeInWei: fee1.toString() }, agoraFaucet: { dripAusd: Number(drip) / 1e6, maxDripFrequencyS: Number(freq), maxAmountToOwnAusd: Number(maxOwn) / 1e6 } };
    return `AUSD ${dec} dp ${sym} · Pyth ${ver}, ${fee1} wei/message · Agora faucet ${Number(drip) / 1e6} AUSD per call, every ${freq} s, recipients ≤ ${Number(maxOwn) / 1e6} AUSD`;
  });

  // 2. webhook sink + Hermes replay (requires a bearer key: exercises PYTH_API_KEY)
  const sink = new WebhookSink(sinkPort);
  await sink.start();
  const replay = new HermesReplay({ port: replayPort, mode: "replay", updates: usable, now: () => chainTime(chain.client), apiKey: "rehearsal-key" });
  await replay.start();

  // 3. owner Safe + env via the real keeper:init --network testnet
  const envFile = join(OUT, "fork.env");
  const deployments = join(OUT, "fork-deployments-10143.json");
  const funderKey = generatePrivateKey();
  await setBalance(chain.client, privateKeyToAccount(funderKey).address, parseEther("100000"));
  const safeSigners = [privateKeyToAccount(generatePrivateKey()).address, privateKeyToAccount(generatePrivateKey()).address];
  const owner = (await step("fork", "owner = a real Safe (2-of-2) through the canonical SafeProxyFactory 1.4.1 deployed on Monad testnet", async () => {
    const safe = await createSafe(chain, privateKeyToAccount(funderKey), safeSigners, 2);
    report.fork.ownerSafe = { safe, signers: safeSigners, threshold: 2 };
    return { detail: `Safe ${safe} (2 owners, threshold 2)`, safe };
  }, { fatal: true }))!.safe as Address;
  await step("fork", "keeper:init --network testnet (hot keys + price signer → rehearsal env, mode 600; addresses only)", async () => {
    const out = await runCli("fork-keeper-init", "keeper/src/init-env.ts", ["--network", "testnet", "--env", envFile]);
    assert(/signer\s+0x/.test(out), "no price signer generated");
    appendFileSync(
      envFile,
      [
        "",
        "# ---- rehearsal overrides (anvil fork of Monad testnet; throwaway keys) ----",
        `KEEPER_RPC_URL=${rpcUrl}`,
        `OWNER_MULTISIG_ADDRESS=${owner}`,
        `KEEPER_PORT=${keeperPort}`,
        "KEEPER_CORS_ORIGIN=http://localhost:3002",
        `DEPLOYMENTS_OUT=${deployments}`,
        `ALERT_WEBHOOK_URL=http://127.0.0.1:${sinkPort}/webhook`,
        `PYTH_HERMES_URL=${replay.url}`,
        "PYTH_API_KEY=rehearsal-key",
        "HERMES_OUTAGE_ALERT_MS=8000",
        "MONITOR_INTERVAL_MS=3000",
        "ALERT_REPEAT_MS=600000",
        "ALERT_PRICE_AGE_WARN_S=150",
        "ALERT_PRICE_AGE_CRITICAL_S=600",
        // exercise the Monad reserve-balance guard on the fork (anvil does not enforce the rule)
        "MONAD_RESERVE_GUARD=1",
        `SIGNER_STATE_FILE=${join(OUT, "signer-state.json")}`,
        "",
      ].join("\n"),
    );
    chmodSync(envFile, 0o600);
    return "keys + price signer in the rehearsal env (never printed)";
  }, { fatal: true });

  await step("fork", "keeper:fund --network testnet (preview from measured gas with the testnet budget, then --send from a funder)", async () => {
    const preview = await runCli("fork-keeper-fund-preview", "keeper/src/fund-roles.ts", ["--network", "testnet", "--env", envFile, "--roles", "deployer,guardian,ops,keepers"]);
    assert(/preview only/.test(preview) && /--yes-testnet/.test(preview), "preview did not stop before sending");
    const total = /total to send: ([\d.]+) testnet MON/.exec(preview)?.[1];
    report.fork.fundPreview = preview.split("\n").filter((l) => /^\s+(deployer|guardian|ops|keeper\[)|total to send|expected spend/.test(l));
    const sent = await runCli("fork-keeper-fund-send", "keeper/src/fund-roles.ts", ["--network", "testnet", "--env", envFile, "--roles", "deployer,guardian,ops,keepers", "--send", "--funder-env", "REHEARSAL_FUNDER_KEY"], { REHEARSAL_FUNDER_KEY: funderKey });
    const n = (sent.match(/success/g) ?? []).length;
    assert(n === 11, `expected 11 transfers, saw ${n}`);
    return `preview: ${total} testnet MON for 11 keys; 11 transfers sent (3-block spacing)`;
  });

  // DeployProd needs SOL + BTC pushed within 1 h on THIS chain (SOL was 8 days old on testnet):
  // put the clock right after a harvested update so the wrapper pushes it from the replay.
  {
    const now = await chainTime(chain.client);
    const u = usable.find((x) => x.messages[SOL].publishTime > now + 1);
    if (u) await warpTo(chain.client, u.messages[SOL].publishTime + 1);
  }
  await step("fork", "deploy:testnet (DeployProd.s.sol: PROD_MARKETS=SOL/AUSD,BTC/AUSD, 600 s timelock, Safe owner; preflight + on-chain verification)", async () => {
    const out = await runCli("fork-deploy", "scripts/deploy-mainnet.ts", ["--network", "testnet", "--env", envFile, "--rpc", rpcUrl]);
    assert(/all checks passed/.test(out.split("post-deploy verification")[1] ?? ""), "post-deploy verification did not pass");
    const g = /forge: (\d+) txs · ([\d.]+)M gas used · ([\d.]+)M gas limit/.exec(out);
    if (g) {
      report.gas.limits.deploy = Math.round(Number(g[3]) * 1e6);
      report.gas.used.deploy = Math.round(Number(g[2]) * 1e6);
    }
    const refreshed = /Pyth stored prices refreshed[^\n]*/.exec(out)?.[0];
    return `deployed + verified (${g ? `${g[1]} txs, ${g[2]}M gas used / ${g[3]}M limit` : "gas n/a"})${refreshed ? `; ${refreshed.slice(0, 120)}` : ""}`;
  }, { fatal: true });
  const dep = readProdDeployment(deployments);
  assert(dep, "no rehearsal deployment file");
  report.fork.deployment = dep.raw;
  await step("fork", 'deployment file: "production": true, "network": "monad-testnet", markets + pythFeeds = SOL/BTC only, params, realPyth, ausdFaucet', async () => {
    const raw = JSON.parse(readFileSync(deployments, "utf8")) as Record<string, unknown>;
    assert(raw.production === true && raw.network === "monad-testnet", `production ${raw.production} network ${raw.network}`);
    const mk = Object.keys(raw.markets as Record<string, unknown>).sort().join(",");
    const pf = Object.keys(raw.pythFeeds as Record<string, unknown>).sort().join(",");
    assert(mk === "BTC/AUSD,SOL/AUSD" && pf === "BTC/AUSD,SOL/AUSD", `markets ${mk} feeds ${pf}`);
    const params = raw.params as Record<string, number>;
    assert(params.timelockMinDelaySeconds === 600 && params.maxDepositPerAccountAusd === 50 && params.maxTvlPerLaneAusd === 500 && params.maxLeverage === 10, "params");
    assert(String(raw.ausd).toLowerCase() === KNOWN_TESTNET.ausd.toLowerCase(), "ausd");
    return `markets ${mk}; timelock 600 s; caps 50/500/10x; ausd ${raw.ausd}; priceSource ${raw.priceSource}`;
  });
  const minExecDelay = Number(await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "minExecDelay" }));
  const minFee = await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "minExecutionFee" });
  const w: World = { chain, dep, keeperPort, minExecDelay, minFee };

  // 4. testnet AUSD: Agora's real faucet on the fork, storage cheats for the rest
  const treasury = privateKeyToAccount(generatePrivateKey());
  const traders = Array.from({ length: 8 }, (_, lane) => laneAccount(lane).account);
  await step("fork", "testnet AUSD from Agora's faucet (requestFunds) on the fork: who may call it, limits; storage cheats for the rest", async () => {
    const payer = privateKeyToAccount(funderKey);
    const req = (to: Address) => encodeFunctionData({ abi: AGORA_FAUCET_ABI, functionName: "requestFunds", args: [to] });
    const before = await chain.client.readContract({ address: KNOWN_TESTNET.ausd, abi: erc20Abi, functionName: "balanceOf", args: [treasury.address] });
    const r1 = await sendAs(chain, payer, KNOWN_TESTNET.ausdFaucet, req(treasury.address)); // a third party pays gas for the recipient
    const after = await chain.client.readContract({ address: KNOWN_TESTNET.ausd, abi: erc20Abi, functionName: "balanceOf", args: [treasury.address] });
    assert(r1.status === "success" && after - before === BigInt(10_000e6), `faucet gave ${after - before}`);
    // a second recipient right away: is the 60 s frequency global or per recipient?
    let second: string;
    try {
      await chain.client.estimateGas({ account: payer.address, to: KNOWN_TESTNET.ausdFaucet, data: req(traders[0].address) });
      second = "per recipient (another address could claim at once)";
    } catch (err) {
      second = `global (another address within 60 s reverts: ${((err as Error).message.match(/MaxFrequencyExceeded|reverted[^.]*/) ?? ["reverted"])[0]})`;
    }
    let sameAgain: string;
    await warpTo(chain.client, (await chainTime(chain.client)) + 61);
    try {
      await chain.client.estimateGas({ account: payer.address, to: KNOWN_TESTNET.ausdFaucet, data: req(treasury.address) });
      sameAgain = "the same recipient may claim again after 60 s";
    } catch {
      sameAgain = "the same recipient cannot claim again after 60 s";
    }
    report.fork.agoraFaucet = { gasUsed: r1.gasUsed, frequency: second, sameRecipient: sameAgain };
    for (const t of traders) {
      await setBalance(chain.client, t.address, parseEther("100"));
      await dealToken(chain.client, dep.ausd, t.address, BigInt(60e6));
    }
    return `requestFunds(treasury) by a third party: +10,000 AUSD (${r1.gasUsed} gas); frequency ${second}; ${sameAgain}; traders funded by storage cheat`;
  });

  await step("fork", "treasury Safe batch (`timelock -- --network testnet seed`): 8 × fundLane 200 + 8 × backstopDeposit 100 AUSD", async () => {
    await setBalance(chain.client, treasury.address, parseEther("1000"));
    const out = await runCli("fork-seed-batch", "keeper/src/prod/timelock.ts", ["seed", "--network", "testnet", "--env", envFile, "--rpc", rpcUrl, "--insurance", "200", "--pool", "100", "--out", join(OUT, "timelock")]);
    const file = /Safe Transaction Builder file for the TREASURY Safe: (\S+)/.exec(out)?.[1];
    assert(file, "no seed batch file");
    const batch = JSON.parse(readFileSync(join(REPO_ROOT, file), "utf8")) as { chainId: string; transactions: Array<{ to: Address; data: Hex; value: string }> };
    assert(batch.chainId === "10143", `batch chainId ${batch.chainId}`);
    for (const t of batch.transactions) await sendAs(chain, treasury, t.to, t.data, BigInt(t.value));
    const sol = await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "solvency" });
    assert(sol[3], "insolvent after seeding");
    return `${batch.transactions.length} calls (Safe Builder JSON, chainId 10143); solvency() held ${Number(sol[0]) / 1e6} AUSD`;
  });

  await step("fork", "8 traders (one per lane) deposit the 50 AUSD cap; the 51st reverts DepositCapExceeded", async () => {
    for (const t of traders) {
      await approve(w, t, dep.ausd, BigInt(60e6));
      await txAs(w, t, "deposit", [BigInt(50e6)]);
    }
    const r = await revertName(w, traders[0].address, "deposit", [BigInt(1e6)]);
    assert(r === "DepositCapExceeded", `51st AUSD: ${r}`);
    return "8 × 50 AUSD; cap enforced";
  });

  // 5. the production keeper in testnet mode
  await step("fork", "start the production keeper (--network testnet): /health mode monad-testnet, priceSource pyth, reserve guard on; demo endpoints 403", async () => {
    startKeeper("fork-keeper", envFile, rpcUrl);
    const h = await waitHealth(keeperPort);
    assert(h.production === true && h.priceSource === "pyth" && h.mode === "monad-testnet" && h.testnet === true, `health ${h.mode} ${h.priceSource}`);
    assert((h.reserveGuard as { enabled: boolean }).enabled, "reserve guard off");
    const fau = await fetch(`http://127.0.0.1:${keeperPort}/faucet`, { method: "POST" });
    assert(fau.status === 403, `/faucet ${fau.status}`);
    report.fork.healthAtStart = h;
    return `mode ${h.mode} · network ${h.network} · priceSource ${h.priceSource} · markets ${Object.keys(h.markets as object).join(",")} · /faucet 403`;
  }, { fatal: true });

  const price18 = (u: HarvestedUpdate, sym: string) => {
    const m = u.messages[FEED_OF[sym]];
    return (BigInt(m.price) * WAD) / BigInt(10) ** BigInt(-m.expo);
  };
  let cursor = 0;
  const nextUpdate = async (margin = 4): Promise<HarvestedUpdate | null> => {
    const now = await chainTime(chain.client);
    while (cursor < usable.length && usable[cursor].messages[SOL].publishTime - minExecDelay <= now + margin) cursor++;
    return cursor < usable.length ? usable[cursor++] : null;
  };
  const orderRounds: unknown[] = [];
  const round = async (label: string, build: (u: HarvestedUpdate) => Array<{ trader: number; market: string; size: bigint; margin: bigint; acceptable: bigint; expect: "executed" | "failed"; tag: string }>) => {
    const u = await nextUpdate();
    if (!u) throw new Error("no harvested update left in the window (raise --lookback)");
    const T = u.messages[SOL].publishTime;
    const specs = build(u);
    const committed: Committed[] = [];
    await mineAt(chain.client, T - minExecDelay, async () => {
      const hashes: Hex[] = [];
      for (const s of specs) {
        const h = await sendCommit(w, traders[s.trader], dep.markets[s.market], s.size, s.margin, s.acceptable);
        committed.push({ label: `${label}:${s.tag}`, hash: h, expect: s.expect });
        hashes.push(h);
      }
      return hashes;
    });
    await orderIdsFrom(w, committed);
    assert(committed.every((c) => c.execAfter === T), `execAfter ≠ the harvested publish time ${T}`);
    const res = await waitResolved(w, committed, 90_000);
    orderRounds.push({ label, publishTime: T, harvestedTx: u.txHash, orders: res });
    return { T, res };
  };

  await step("fork", "round A: 8 lanes open SOL/BTC positions (long/short, 2–5x), executed by 8 lane keepers with REAL Pyth updates (testnet fee paid as msg.value)", async () => {
    const { res, T } = await round("A", (u) =>
      traders.map((_, i) => {
        const sym = SYMS[i % 2];
        const long = Math.floor(i / 2) % 2 === 0;
        const p = price18(u, sym);
        const notional = BigInt((40 + 10 * (i % 4)) * 1e6);
        return { trader: i, market: sym, size: long ? sizeFor(notional, p) : -sizeFor(notional, p), margin: BigInt(20e6), acceptable: long ? (p * BigInt(102)) / BigInt(100) : (p * BigInt(98)) / BigInt(100), expect: "executed" as const, tag: `lane${i}-${sym}-${long ? "long" : "short"}` };
      }),
    );
    const lat = res.map((r) => r.latencyS).filter((x): x is number => x !== null);
    return { detail: `8/8 executed at the first update ≥ execAfter (${T}); latency ${Math.min(...lat)}–${Math.max(...lat)} s`, res };
  });

  await step("fork", "round B: second leg (appended update), partial reduce, slippage miss → OrderFailed (executor paid)", async () => {
    const { res } = await round("B", (u) => {
      const pSol = price18(u, "SOL/AUSD");
      const pBtc = price18(u, "BTC/AUSD");
      return [
        // trader 0 (SOL long) adds a BTC short: the other leg's price is appended
        { trader: 0, market: "BTC/AUSD", size: -sizeFor(BigInt(20e6), pBtc), margin: BigInt(10e6), acceptable: (pBtc * BigInt(98)) / BigInt(100), expect: "executed" as const, tag: "lane0-second-leg" },
        // trader 1 (BTC long): reduce by half
        { trader: 1, market: "BTC/AUSD", size: -sizeFor(BigInt(25e6), pBtc), margin: BigInt(0), acceptable: (pBtc * BigInt(97)) / BigInt(100), expect: "executed" as const, tag: "lane1-reduce" },
        // trader 4 (SOL long): acceptable far below the fill → OrderFailed
        { trader: 4, market: "SOL/AUSD", size: sizeFor(BigInt(15e6), pSol), margin: BigInt(5e6), acceptable: (pSol * BigInt(90)) / BigInt(100), expect: "failed" as const, tag: "lane4-slippage" },
      ];
    });
    const owed = await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "executionFeesOwed", args: [keeperAddress(envFile, 4)] });
    assert(owed > BigInt(0), "lane-4 keeper was not credited for the failed order");
    const txs = await getJson<{ recent: Array<{ kind: string; gasLimit: string; value: string; meta: { otherLegs?: number } }> }>(`http://127.0.0.1:${keeperPort}/txs`);
    const ex = txs.body.recent.filter((t) => t.kind === "executeOrder");
    const multi = ex.filter((t) => (t.meta.otherLegs ?? 0) > 0).map((t) => Number(t.gasLimit));
    const values = [...new Set(ex.map((t) => t.value))];
    assert(multi.length >= 1, "no multi-leg execution");
    report.fork.executeOrderGas = { singleLegMaxLimit: Math.max(...ex.filter((t) => !t.meta.otherLegs).map((t) => Number(t.gasLimit))), multiLegLimits: multi, valuesWei: values };
    return { detail: `second leg executed with the appended update (gas ${multi.join("/")}); reduce executed; slippage → Failed; executeOrder msg.value ${values.join("/")} wei (testnet Pyth fee)`, res };
  });

  await step("fork", "withdraw with an update fetched through the keeper's /hermes proxy; the proxy refuses MON and AUSD/USD feed ids", async () => {
    const r = await getJson<{ binary: { data: string[] } }>(`http://127.0.0.1:${keeperPort}/hermes/v2/updates/price/latest?ids[]=${SOL}&ids[]=${BTC}`);
    assert(r.status === 200 && r.body.binary.data.length > 0, `proxy ${r.status}`);
    const data = r.body.binary.data.map((d) => `0x${d}` as Hex);
    const fee = await chain.client.readContract({ address: dep.pyth, abi: pythAbi, functionName: "getUpdateFee", args: [data] });
    const g = await txAs(w, traders[2], "withdraw", [BigInt(1e6), data], fee);
    const mon = await fetch(`http://127.0.0.1:${keeperPort}/hermes/v2/updates/price/latest?ids[]=${MON}`);
    const ausd = await fetch(`http://127.0.0.1:${keeperPort}/hermes/v2/updates/price/latest?ids[]=${AUSD_USD}`);
    assert(mon.status === 400 && ausd.status === 400, `MON ${mon.status} AUSD/USD ${ausd.status}`);
    return `trader 2 withdrew 1 AUSD with the proxied real update (fee ${fee} wei, ${g.gasUsed} gas); MON → 400, AUSD/USD → 400`;
  });

  await step("fork", "gas probes with a REAL 2-feed testnet update: startAuctions / backstopTakeBatch / expireBatch / cancelAuction / pyth.updatePriceFeeds", async () => {
    const u = await getJson<{ binary: { data: string[] } }>(`http://127.0.0.1:${keeperPort}/hermes/v2/updates/price/latest?ids[]=${SOL}&ids[]=${BTC}`);
    const data = u.body.binary.data.map((d) => `0x${d}` as Hex);
    const fee = await chain.client.readContract({ address: dep.pyth, abi: pythAbi, functionName: "getUpdateFee", args: [data] });
    const k3 = keeperAddress(envFile, 3);
    const est = (fn: string, a: unknown[]) => chain.client.estimateGas({ account: k3, to: dep.clearinghouse, value: fee, data: encodeFunctionData({ abi: clearinghouseAbi as Abi, functionName: fn, args: a }) });
    const probes = {
      startAuctions: await est("startAuctions", [3, [traders[3].address], data]),
      backstopTakeBatch: await est("backstopTakeBatch", [3, [traders[3].address], data]),
      expireBatch: await est("expireBatch", [3, [traders[3].address], data]),
      cancelAuction: await est("cancelAuction", [traders[3].address, data]),
    };
    const u1 = await getJson<{ binary: { data: string[] } }>(`http://127.0.0.1:${keeperPort}/hermes/v2/updates/price/latest?ids[]=${SOL}`);
    const d1 = u1.body.binary.data.map((d) => `0x${d}` as Hex);
    const push = (blobs: Hex[], v: bigint) => chain.client.estimateGas({ account: k3, to: dep.pyth, value: v, data: encodeFunctionData({ abi: pythAbi, functionName: "updatePriceFeeds", args: [blobs] }) });
    const push1 = await push(d1, BigInt(1));
    const push2 = await push(data, fee);
    report.fork.realPythProbeGas = probes;
    report.fork.pythPushGas = { oneFeed: push1, twoFeeds: push2 };
    return `${Object.entries(probes).map(([k, v]) => `${k} ${v}`).join(" · ")} · push 1 feed ${push1} / 2 feeds ${push2}`;
  });

  await step("fork", "guardian:pause --network testnet → paused; deposit and increase orders revert IsPaused; withdraw still works", async () => {
    const out = await runCli("fork-guardian-pause", "keeper/src/prod/guardian.ts", ["--network", "testnet", "--env", envFile, "--rpc", rpcUrl]);
    const pg = /gas used (\d+) \/ limit (\d+)/.exec(out);
    if (pg) {
      report.gas.used.pause = Number(pg[1]);
      report.gas.limits.pause = Number(pg[2]);
    }
    assert(await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "paused" }), "not paused");
    const fresh = laneAccount(5).account;
    await setBalance(chain.client, fresh.address, parseEther("10"));
    await dealToken(chain.client, dep.ausd, fresh.address, BigInt(10e6));
    await approve(w, fresh, dep.ausd, BigInt(10e6));
    const d1 = await revertName(w, fresh.address, "deposit", [BigInt(5e6)]);
    assert(d1 === "IsPaused", `deposit while paused: ${d1}`);
    // trader 7 holds only BTC: a SOL buy is a NEW position (an increase)
    const inc = await revertName(w, traders[7].address, "commitOrder", [dep.markets["SOL/AUSD"], BigInt(1), BigInt(1e6), BigInt(1)], minFee);
    assert(inc === "IsPaused", `increase while paused: ${inc}`);
    const r = await getJson<{ binary: { data: string[] } }>(`http://127.0.0.1:${keeperPort}/hermes/v2/updates/price/latest?ids[]=${SOL}&ids[]=${BTC}`);
    const data = r.body.binary.data.map((d) => `0x${d}` as Hex);
    await txAs(w, traders[3], "withdraw", [BigInt(1e6), data], await chain.client.readContract({ address: dep.pyth, abi: pythAbi, functionName: "getUpdateFee", args: [data] }));
    return "paused; deposit → IsPaused; increase → IsPaused; withdraw OK";
  });

  await step("fork", "while paused: a reduce order still commits and executes", async () => {
    const { res } = await round("C-paused", (u) => {
      const p = price18(u, "SOL/AUSD");
      // trader 2 is short SOL (lane 2: SOL, Math.floor(2/2)%2=1 → short): reduce = buy
      return [{ trader: 2, market: "SOL/AUSD", size: sizeFor(BigInt(10e6), p), margin: BigInt(0), acceptable: (p * BigInt(103)) / BigInt(100), expect: "executed" as const, tag: "lane2-reduce-while-paused" }];
    });
    return { detail: "reduce executed while paused", res };
  });

  await step("fork", "Hermes outage drill: 25 s of 503s → backoff + `hermes:down`, recovery, late execution", async () => {
    replay.outage(25_000);
    const { res } = await round("D-outage", (u) => {
      const p = price18(u, "BTC/AUSD");
      // trader 3 is short BTC (lane 3: BTC, short): reduce = buy
      return [{ trader: 3, market: "BTC/AUSD", size: sizeFor(BigInt(10e6), p), margin: BigInt(0), acceptable: (p * BigInt(103)) / BigInt(100), expect: "executed" as const, tag: "lane3-reduce-during-outage" }];
    });
    await sleep(4_000);
    const keys = sink.keys();
    assert(keys.includes("hermes:down") && keys.includes("resolved:hermes:down"), `alerts ${keys.join(", ")}`);
    return { detail: `executed after the outage (latency ${res[0].latencyS} s); alerts ${keys.filter((k) => /hermes|exec:late/.test(k)).join(", ")}`, res };
  });

  await step("fork", "expired order: no update in [execAfter, deadline] → `exec:expired`; the user cancels and gets the fee back", async () => {
    const last = usable[usable.length - 1];
    const t0 = Math.max((await chainTime(chain.client)) + 2, last.messages[SOL].publishTime + 5);
    const c: Committed[] = [];
    await mineAt(chain.client, t0, async () => {
      // trader 0 is long SOL: a tiny reduce (allowed while paused) that can never get a price
      const h = await sendCommit(w, traders[0], dep.markets["SOL/AUSD"], BigInt(-1), BigInt(0), BigInt(1));
      c.push({ label: "E-expire", hash: h, expect: "executed" });
      return [h];
    });
    await orderIdsFrom(w, c);
    const o = (await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "getOrder", args: [c[0].orderId!] })) as unknown as { deadline: bigint };
    await warpTo(chain.client, Number(o.deadline) + 2);
    await sleep(6_000);
    assert(sink.keys().some((k) => k.startsWith("exec:expired")), `no exec:expired (${sink.keys().join(", ")})`);
    await txAs(w, traders[0], "cancelOrder", [c[0].orderId!]);
    const st = ((await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "getOrder", args: [c[0].orderId!] })) as unknown as { status: number }).status;
    assert(st === 4, `status ${st}`);
    return "alerted; cancelOrder → Cancelled (escrow + fee refunded)";
  });

  await step("fork", "funding: updateFunding landed for both markets; every FundingUpdated rate equals the keeper's formula", async () => {
    const tx = await getJson<{ byKind: Record<string, { success: number; avgGasLimit: string }> }>(`http://127.0.0.1:${keeperPort}/txs`);
    const f = tx.body.byKind.updateFunding;
    assert(f && f.success >= 2, `updateFunding successes ${f?.success ?? 0}`);
    const logs = await chain.client.getLogs({ address: dep.clearinghouse, fromBlock: BigInt(dep.deployBlock), toBlock: "latest" } as never);
    let checked = 0;
    for (const l of logs as Array<{ data: Hex; topics: [Hex, ...Hex[]] }>) {
      let e;
      try {
        e = decodeEventLog({ abi: clearinghouseAbi, data: l.data, topics: l.topics });
      } catch {
        continue;
      }
      if (e.eventName !== "FundingUpdated") continue;
      const a = e.args as unknown as { market: Hex; ratePerSec: bigint; skewNotional: bigint };
      const m = (await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "getMarket", args: [a.market] })) as readonly [boolean, string, Hex, bigint, bigint, bigint];
      assert(targetRate(a.skewNotional, m[3], m[5]) === a.ratePerSec, `${m[1]} formula mismatch`);
      checked++;
    }
    return `${f.success} updateFunding txs (avg gas limit ${f.avgGasLimit}); ${checked} FundingUpdated rates match`;
  });

  await step("fork", "LP two-step exit: request → WithdrawNotReady → 1 h (warped) → withdraw in the window → single-use", async () => {
    const shares = await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "backstopSharesOf", args: [0, treasury.address] });
    const half = shares / BigInt(2);
    await txAs(w, treasury, "backstopRequestWithdraw", [0, half]);
    const early = await revertName(w, treasury.address, "backstopWithdraw", [0, half, []]);
    assert(early === "WithdrawNotReady", `early: ${early}`);
    const req = await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "backstopWithdrawRequest", args: [0, treasury.address] });
    await warpTo(chain.client, Number(req[1]) + 5);
    const b0 = await chain.client.readContract({ address: dep.ausd, abi: erc20Abi, functionName: "balanceOf", args: [treasury.address] });
    await txAs(w, treasury, "backstopWithdraw", [0, half / BigInt(2), []]);
    const b1 = await chain.client.readContract({ address: dep.ausd, abi: erc20Abi, functionName: "balanceOf", args: [treasury.address] });
    const again = await revertName(w, treasury.address, "backstopWithdraw", [0, half / BigInt(2), []]);
    assert(again === "NoWithdrawRequest", `reuse: ${again}`);
    return `withdrew ${Number(b1 - b0) / 1e6} AUSD after the delay; reuse → NoWithdrawRequest`;
  });

  await step("fork", "unpause through the 600 s timelock: Safe Builder JSON, the Safe impersonated, delay warped", async () => {
    const outDir = join(OUT, "timelock");
    const sched = await runCli("fork-timelock-schedule", "keeper/src/prod/timelock.ts", ["prepare", "--network", "testnet", "--env", envFile, "--rpc", rpcUrl, "--call", "unpause()", "--out", outDir, "--impersonate", "schedule"]);
    assert(/delay\s+600 s/.test(sched), "delay is not 600 s");
    const early = await runCli("fork-timelock-status", "keeper/src/prod/timelock.ts", ["status", "--network", "testnet", "--env", envFile, "--rpc", rpcUrl, "--call", "unpause()"]);
    assert(/scheduled, ready at/.test(early), "not scheduled");
    await warpTo(chain.client, (await chainTime(chain.client)) + 605);
    await runCli("fork-timelock-execute", "keeper/src/prod/timelock.ts", ["prepare", "--network", "testnet", "--env", envFile, "--rpc", rpcUrl, "--call", "unpause()", "--out", outDir, "--impersonate", "execute"]);
    assert(!(await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "paused" })), "still paused");
    return "scheduled → 605 s → executed as the Safe; paused=false";
  });

  await step("fork", "Hermes was never asked for MON or AUSD/USD (the trial key covers SOL/BTC only); solvency holds", async () => {
    const asked = new Set(replay.requests.flatMap((r) => r.ids));
    assert(!asked.has(MON) && !asked.has(AUSD_USD), `replay saw ${[...asked].join(",")}`);
    const [sol, nat] = await Promise.all([
      chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "solvency" }),
      chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "nativeSolvency" }),
    ]);
    assert(sol[3] && nat[2], "insolvent");
    report.fork.hermes = { requests: replay.requests.length, statuses: countBy(replay.requests.map((r) => String(r.status))), feedsRequested: [...asked] };
    return `${replay.requests.length} Hermes requests, feeds ${[...asked].map((f) => (f === SOL ? "SOL" : f === BTC ? "BTC" : f)).join("+")} only; AUSD held ${Number(sol[0]) / 1e6} ≥ liabilities ${Number(sol[1]) / 1e6}`;
  });

  const health = await getJson<Record<string, unknown>>(`http://127.0.0.1:${keeperPort}/health`).catch(() => null);
  const txs = await getJson<{ byKind: Record<string, Record<string, string | number>> }>(`http://127.0.0.1:${keeperPort}/txs`).catch(() => null);
  report.fork.healthAtEnd = health?.body;
  report.fork.reserveGuard = (health?.body as { reserveGuard?: unknown } | undefined)?.reserveGuard;
  report.fork.keeperTxs = txs?.body;
  report.fork.orders = orderRounds;
  report.alerts.fork = sink.keys();
  for (const k of ["executeOrder", "updateFunding"]) {
    const b = txs?.body.byKind[k];
    if (b) {
      report.gas.limits[k] = Number(b.maxGasLimit);
      report.gas.limits[`${k}Avg`] = Number(b.avgGasLimit);
      report.gas.used[k] = Math.round(Number(b.gasUsed) / Math.max(1, Number(b.success)));
    }
  }
  await stopChildren(); // keepers only; the fork anvil keeps its state for the fallback leg
  if (!legs.has("fallback")) {
    await replay.stop();
    await sink.stop();
    return;
  }
  await fallbackLeg({ port, keeperPort, forkBlock, chainRpc: rpcUrl, envFile, deployments, owner, w, traders, sink });
  await replay.stop();
  await sink.stop();
}

// ---------------------------------------------------------------------------
// FALLBACK LEG: KeeperSignedPyth through the timelock (same fork state)
// ---------------------------------------------------------------------------

async function fallbackLeg(o: {
  port: number;
  keeperPort: number;
  forkBlock: number;
  chainRpc: string;
  envFile: string;
  deployments: string;
  owner: Address;
  w: World;
  traders: LocalAccount[];
  sink: WebhookSink;
}): Promise<void> {
  const { w, envFile, chainRpc: rpcUrl, keeperPort, sink, traders } = o;
  const { chain } = w;
  const cli = ["--network", "testnet", "--env", envFile, "--rpc", rpcUrl];
  const sinkFrom = sink.received.length;
  const legKeys = () => sink.keys().slice(sinkFrom);
  let oracle: Address | null = null;

  oracle = (await step("fallback", "oracle:fallback deploy: KeeperSignedPyth (owner = the timelock, signer = PRICE_SIGNER), seeded with keeper-signed SOL/BTC, recorded in the deployment file", async () => {
    const out = await runCli("fallback-deploy", "scripts/testnet-oracle.ts", ["deploy", ...cli]);
    const addr = /deployed (0x[0-9a-fA-F]{40})/.exec(out)?.[1] as Address | undefined;
    assert(addr, "no oracle address in the output");
    const raw = JSON.parse(readFileSync(o.deployments, "utf8")) as Record<string, unknown>;
    assert(String(raw.fallbackOracle).toLowerCase() === addr.toLowerCase(), "fallbackOracle not recorded");
    const owner = await chain.client.readContract({ address: addr, abi: parseAbi(["function owner() view returns (address)"]), functionName: "owner" });
    assert(owner.toLowerCase() === w.dep.timelock!.toLowerCase(), `owner ${owner} is not the timelock`);
    const gasLine = /deployed 0x[0-9a-fA-F]{40} \(tx 0x[0-9a-f]+, gas (\d+)\)/.exec(out);
    const seedLine = /seeded [^\n]*gas (\d+)\)/.exec(out);
    if (gasLine) report.gas.limits.fallbackDeploy = Number(gasLine[1]);
    if (seedLine) report.gas.used.fallbackSeedPush = Number(seedLine[1]);
    report.fallback.oracle = addr;
    return { detail: `KeeperSignedPyth ${addr} (owner = timelock ${owner}); seed push ${seedLine?.[1] ?? "?"} gas`, addr };
  }, { fatal: true }))!.addr as Address;

  await step("fallback", "restart the keeper with the price signer: still on Pyth, signing ahead of the switch (/health.oracle)", async () => {
    startKeeper("fallback-keeper", envFile, rpcUrl);
    const h = await waitHealth(keeperPort);
    const or = h.oracle as { mode: string; fallbackOracle: string; signer: { healthy: boolean; source: string } | null; prepush: { active: boolean } | null };
    assert(or.mode === "pyth" && or.fallbackOracle?.toLowerCase() === oracle!.toLowerCase(), `oracle ${or.mode} ${or.fallbackOracle}`);
    for (let i = 0; i < 20 && !(await getJson<{ oracle: { signer: { healthy: boolean } } }>(`http://127.0.0.1:${keeperPort}/health`)).body.oracle.signer?.healthy; i++) await sleep(500);
    const h2 = (await getJson<{ oracle: { signer: { healthy: boolean; source: string; signed: number }; prepush: { active: boolean } } }>(`http://127.0.0.1:${keeperPort}/health`)).body;
    assert(h2.oracle.signer?.healthy && h2.oracle.prepush?.active, "signer not healthy / prepush inactive");
    const st = await runCli("fallback-status", "scripts/testnet-oracle.ts", ["status", ...cli]);
    assert(/\(the timelock\)/.test(st) && /allowed/.test(st), "oracle:fallback status");
    return `priceSource pyth; signer healthy (source ${h2.oracle.signer.source}, ${h2.oracle.signer.signed} messages); prepush armed`;
  }, { fatal: true });

  let readyAt = 0;
  await step("fallback", "timelock set-pyth (Safe files; scheduled as the Safe) → the keeper pushes signed prices into the fallback from 120 s before it is ready", async () => {
    const out = await runCli("fallback-setpyth-schedule", "keeper/src/prod/timelock.ts", ["set-pyth", "--to", oracle!, ...cli, "--out", join(OUT, "timelock"), "--impersonate", "schedule"]);
    assert(/KEEPER-SIGNED fallback oracle/.test(out), "set-pyth did not describe the switch");
    const st = await runCli("fallback-setpyth-status", "keeper/src/prod/timelock.ts", ["status", "--call", "setPyth(address)", "--args", oracle!, ...cli]);
    const m = /scheduled, ready at (\S+)/.exec(st);
    assert(m, "not scheduled");
    readyAt = Math.floor(new Date(m[1]).getTime() / 1000);
    // before the window nothing is pushed; inside it the keeper pushes
    await warpTo(chain.client, readyAt - 100);
    const deadline = Date.now() + 40_000;
    for (;;) {
      const h = (await getJson<{ oracle: { prepush: { pushes: number; readyAt: number | null } } }>(`http://127.0.0.1:${keeperPort}/health`)).body;
      if (h.oracle.prepush.pushes >= 1) break;
      if (Date.now() > deadline) throw new Error(`no prepush (readyAt seen ${h.oracle.prepush.readyAt})`);
      await sleep(1_000);
    }
    const now = await chainTime(chain.client);
    const ages = await Promise.all([SOL, BTC].map((f) => chain.client.readContract({ address: oracle!, abi: pythAbi, functionName: "getPriceUnsafe", args: [f] }).then((p) => now - Number(p.publishTime))));
    return `scheduled (ready at ${m[1]}, 600 s); keeper pushed signed SOL/BTC into the fallback (stored ages ${ages.join("/")} s)`;
  }, { fatal: true });

  await step("fallback", "execute setPyth as the Safe → PythUpdated → the keeper switches live (gov:oracle, priceSource keeper-signed)", async () => {
    await warpTo(chain.client, readyAt + 1);
    await sleep(4_000); // the keeper refreshes the fallback's storage inside the window
    await runCli("fallback-setpyth-execute", "keeper/src/prod/timelock.ts", ["set-pyth", "--to", oracle!, ...cli, "--out", join(OUT, "timelock"), "--impersonate", "execute"]);
    const live = await chain.client.readContract({ address: w.dep.clearinghouse, abi: parseAbi(["function pyth() view returns (address)"]), functionName: "pyth" });
    assert(live.toLowerCase() === oracle!.toLowerCase(), `pyth() ${live}`);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const h = (await getJson<{ priceSource: string }>(`http://127.0.0.1:${keeperPort}/health`)).body;
      if (h.priceSource === "keeper-signed") break;
      if (Date.now() > deadline) throw new Error(`keeper still reports priceSource ${h.priceSource}`);
      await sleep(1_000);
    }
    await sleep(2_000);
    assert(legKeys().includes("gov:oracle"), `no gov:oracle alert (${legKeys().join(", ")})`);
    return `pyth() = ${live}; keeper priceSource keeper-signed; alert gov:oracle`;
  }, { fatal: true });

  await step("fallback", "orders fill on KEEPER-SIGNED prices (first signed message ≥ execAfter, unique parse): a SOL reduce and a BTC increase", async () => {
    const r = await getJson<{ parsed: Array<{ id: string; price: { price: string; expo: number } }>; binary: { data: string[] } }>(`http://127.0.0.1:${keeperPort}/hermes/v2/updates/price/latest?ids[]=${SOL}&ids[]=${BTC}`);
    assert(r.status === 200 && r.body.binary.data[0].startsWith("504b5331"), "the proxy does not serve PKS1 (keeper-signed) blobs");
    const px = (id: Hex) => {
      const p = r.body.parsed.find((x) => `0x${x.id.replace(/^0x/, "")}`.toLowerCase() === id)!;
      return (BigInt(p.price.price) * WAD) / BigInt(10) ** BigInt(-p.price.expo);
    };
    const pSol = px(SOL);
    const pBtc = px(BTC);
    const c: Committed[] = [];
    // trader 6 is short SOL (lane 6): reduce = buy · trader 7 is short BTC (lane 7): add to the short
    c.push({ label: "F:lane6-sol-reduce", hash: await sendCommit(w, traders[6], w.dep.markets["SOL/AUSD"], sizeFor(BigInt(10e6), pSol), BigInt(0), (pSol * BigInt(103)) / BigInt(100)), expect: "executed" });
    c.push({ label: "F:lane7-btc-increase", hash: await sendCommit(w, traders[7], w.dep.markets["BTC/AUSD"], -sizeFor(BigInt(10e6), pBtc), BigInt(5e6), (pBtc * BigInt(97)) / BigInt(100)), expect: "executed" });
    await orderIdsFrom(w, c);
    const res = await waitResolved(w, c, 90_000);
    report.fallback.orders = res;
    return { detail: `2/2 executed on keeper-signed prices (latency ${res.map((x) => x.latencyS).join("/")} s); proxy serves PKS1 blobs`, res };
  });

  await step("fallback", "withdraw with a keeper-signed update from the /hermes proxy (fee 0); record --live updates the deployment file", async () => {
    const r = await getJson<{ binary: { data: string[] } }>(`http://127.0.0.1:${keeperPort}/hermes/v2/updates/price/latest?ids[]=${SOL}&ids[]=${BTC}`);
    const data = r.body.binary.data.map((d) => `0x${d}` as Hex);
    const fee = await chain.client.readContract({ address: oracle!, abi: pythAbi, functionName: "getUpdateFee", args: [data] });
    assert(fee === BigInt(0), `fee ${fee}`);
    const g = await txAs(w, traders[1], "withdraw", [BigInt(1e6), data]);
    await runCli("fallback-record", "scripts/testnet-oracle.ts", ["record", "--live", ...cli]);
    const raw = JSON.parse(readFileSync(o.deployments, "utf8")) as Record<string, unknown>;
    assert(raw.priceSource === "keeper-signed" && String(raw.pyth).toLowerCase() === oracle!.toLowerCase() && String(raw.realPyth).toLowerCase() === KNOWN.pyth.toLowerCase(), "record --live");
    const [sol] = await Promise.all([chain.client.readContract({ address: w.dep.clearinghouse, abi: clearinghouseAbi, functionName: "solvency" })]);
    assert(sol[3], "insolvent");
    return `withdrew 1 AUSD (${g.gasUsed} gas, fee 0); file: pyth = fallback, priceSource keeper-signed, realPyth kept; solvent`;
  });

  const h = await getJson<Record<string, unknown>>(`http://127.0.0.1:${keeperPort}/health`).catch(() => null);
  const txs = await getJson<{ byKind: Record<string, Record<string, string | number>>; recent: Array<{ kind: string; gasLimit: string; meta: { why?: string } }> }>(`http://127.0.0.1:${keeperPort}/txs`).catch(() => null);
  report.fallback.healthAtEnd = h?.body;
  const pushes = txs?.body.recent.filter((t) => t.kind === "pythPush" && t.meta.why === "fallback pre-switch push").map((t) => Number(t.gasLimit)) ?? [];
  if (pushes.length) report.gas.limits.fallbackPush = Math.max(...pushes);
  const ex = txs?.body.byKind.executeOrder;
  if (ex) report.fallback.executeOrderAvgGasLimit = Number(ex.avgGasLimit);
  report.alerts.fallback = legKeys();
  await stopChildren();
}

// ---------------------------------------------------------------------------
// MOCK LEG: liquidations with the TEST MockPyth on a plain anvil (chain id 10143)
// ---------------------------------------------------------------------------

async function mockLeg(args: Record<string, string | true>): Promise<void> {
  const port = Number(args["mock-port"] ?? 8957);
  const keeperPort = 8787 + port - 8545; // 9199
  const sinkPort = port + 100;
  const hermesPort = port + 101;
  assert(await portFree(port), `port ${port} is busy`);
  const art = await buildArtifacts("rehearsal-testnet");
  const anvil = await startAnvil({ port, chainId: 10143, blockTime: 2, logFile: join(OUT, "anvil-mock.log") });
  anvils.push(anvil);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const chain = await connectMainnet(rpcUrl);
  report.mock.chain = { label: chain.label, network: chain.network, chainId: chain.chainId, pyth: "TEST MockPyth", ausd: "MockAUSD (6 dp)" };

  const admin = privateKeyToAccount(generatePrivateKey());
  await setBalance(chain.client, admin.address, parseEther("100000"));
  const wallet = createWalletClient({ account: admin, chain: chain.chain, transport: http(rpcUrl) });
  const deploy = async (file: string, name: string, ctorArgs: unknown[] = []) => {
    const a = art(file, name);
    const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args: ctorArgs, chain: chain.chain });
    const r = await chain.client.waitForTransactionReceipt({ hash });
    return { address: r.contractAddress!, abi: a.abi };
  };
  const mockAusd = await deploy("MockAUSD.sol", "MockAUSD", [admin.address]);
  const mockPyth = await deploy("MockPyth.sol", "MockPyth");
  await sendAs(chain, admin, mockAusd.address, encodeFunctionData({ abi: mockAusd.abi, functionName: "ownerMint", args: [admin.address, BigInt(20_000e6)] }));
  const startPx: Record<string, bigint> = { "SOL/AUSD": BigInt(180e8), "BTC/AUSD": BigInt(100_000e8) };
  const now0 = await chainTime(chain.client);
  for (const [sym, p] of Object.entries(startPx)) {
    await sendAs(chain, admin, mockPyth.address, encodeFunctionData({ abi: mockPyth.abi, functionName: "setStoredPrice", args: [FEED_OF[sym], p, p / BigInt(10_000), -8, BigInt(now0)] }));
  }
  const sink = new WebhookSink(sinkPort);
  await sink.start();
  const hermes = new HermesReplay({ port: hermesPort, mode: "mock", now: () => chainTime(chain.client), apiKey: "rehearsal-key" });
  for (const [sym, p] of Object.entries(startPx)) hermes.prices.set(FEED_OF[sym], { price: p, conf: p / BigInt(10_000), expo: -8 });
  await hermes.start();

  const envFile = join(OUT, "mock.env");
  const deployments = join(OUT, "mock-deployments-10143.json");
  const ownerAcct = privateKeyToAccount(generatePrivateKey());
  await runCli("mock-keeper-init", "keeper/src/init-env.ts", ["--network", "testnet", "--env", envFile]);
  appendFileSync(
    envFile,
    [
      "",
      "# ---- rehearsal overrides (plain anvil chain 10143 + TEST MockPyth + MockAUSD; throwaway keys) ----",
      `KEEPER_RPC_URL=${rpcUrl}`,
      `OWNER_MULTISIG_ADDRESS=${ownerAcct.address}`,
      "OWNER_IS_EOA=true",
      `AUSD_ADDRESS=${mockAusd.address}`,
      `PYTH_ADDRESS=${mockPyth.address}`,
      `KEEPER_PORT=${keeperPort}`,
      "KEEPER_CORS_ORIGIN=http://localhost:3002",
      `DEPLOYMENTS_OUT=${deployments}`,
      `ALERT_WEBHOOK_URL=http://127.0.0.1:${sinkPort}/webhook`,
      `PYTH_HERMES_URL=${hermes.url}`,
      "PYTH_API_KEY=rehearsal-key",
      "MONITOR_INTERVAL_MS=3000",
      "SWEEPER_MIN_INTERVAL_MS=500",
      "",
    ].join("\n"),
  );
  for (const k of ["DEPLOYER_PRIVATE_KEY", "GUARDIAN_PRIVATE_KEY", "OPS_PRIVATE_KEY"]) await setBalance(chain.client, privateKeyToAccount(readEnvVar(envFile, k) as Hex).address, parseEther("1000"));
  for (const key of (readEnvVar(envFile, "KEEPER_PRIVATE_KEYS") ?? "").split(",")) await setBalance(chain.client, privateKeyToAccount(key as Hex).address, parseEther("1000"));

  await step("mock", "deploy:testnet against MockAUSD + MockPyth (same DeployProd + verification; SOL/BTC, 600 s timelock, OWNER_IS_EOA)", async () => {
    const out = await runCli("mock-deploy", "scripts/deploy-mainnet.ts", ["--network", "testnet", "--env", envFile, "--rpc", rpcUrl]);
    assert(/all checks passed/.test(out.split("post-deploy verification")[1] ?? ""), "verification failed");
    return "deployed + verified";
  }, { fatal: true });
  const dep = readProdDeployment(deployments)!;
  const minExecDelay = Number(await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "minExecDelay" }));
  const minFee = await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "minExecutionFee" });
  const w: World = { chain, dep, keeperPort, minExecDelay, minFee };
  const read = <T>(fn: string, a: unknown[] = []) => chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi as Abi, functionName: fn, args: a }) as Promise<T>;

  await step("mock", "seed insurance 200 + backstop pool 150 on every lane", async () => {
    await approve(w, admin, mockAusd.address, BigInt(20_000e6));
    for (let lane = 0; lane < 8; lane++) {
      await txAs(w, admin, "fundLane", [lane, BigInt(200e6)]);
      await txAs(w, admin, "backstopDeposit", [lane, BigInt(150e6), []]);
    }
    return "seeded";
  });

  const traders = Array.from({ length: 8 }, (_, lane) => laneAccount(lane).account);
  await step("mock", "8 lanes open ~9.5x longs (SOL on lanes 0–6, BTC on lane 7) through the keeper's executor", async () => {
    for (const t of traders) {
      await setBalance(chain.client, t.address, parseEther("100"));
      await sendAs(chain, admin, mockAusd.address, encodeFunctionData({ abi: mockAusd.abi, functionName: "ownerMint", args: [t.address, BigInt(100e6)] }));
      await approve(w, t, mockAusd.address, BigInt(100e6));
      await txAs(w, t, "deposit", [BigInt(50e6)]);
    }
    startKeeper("mock-keeper", envFile, rpcUrl);
    await waitHealth(keeperPort);
    const c: Committed[] = [];
    for (const [i, t] of traders.entries()) {
      const sym = i === 7 ? "BTC/AUSD" : "SOL/AUSD";
      const p = (startPx[sym] * WAD) / BigInt(1e8);
      const margin = BigInt(46e6);
      c.push({ label: `open-${i}-${sym}`, hash: await sendCommit(w, t, dep.markets[sym], sizeFor((margin * BigInt(95)) / BigInt(10), p), margin, (p * BigInt(101)) / BigInt(100)), expect: "executed" });
    }
    await orderIdsFrom(w, c);
    await waitResolved(w, c, 90_000);
    return "8/8 positions open";
  }, { fatal: true });

  await step("mock", "gas probes with a MockPyth update on a healthy account (the per-account part of the auction budget)", async () => {
    const u = await getJson<{ binary: { data: string[] } }>(`${hermes.url}/v2/updates/price/latest?ids[]=${SOL}&ids[]=${BTC}`, { authorization: "Bearer rehearsal-key" });
    const data = u.body.binary.data.map((d) => `0x${d}` as Hex);
    const k3 = keeperAddress(envFile, 3);
    const est = (fn: string, a: unknown[]) => chain.client.estimateGas({ account: k3, to: dep.clearinghouse, data: encodeFunctionData({ abi: clearinghouseAbi as Abi, functionName: fn, args: a }) });
    const probes = {
      startAuctions: await est("startAuctions", [3, [traders[3].address], data]),
      backstopTakeBatch: await est("backstopTakeBatch", [3, [traders[3].address], data]),
      expireBatch: await est("expireBatch", [3, [traders[3].address], data]),
      cancelAuction: await est("cancelAuction", [traders[3].address, data]),
    };
    report.mock.mockPythProbeGas = probes;
    return Object.entries(probes).map(([k, v]) => `${k} ${v}`).join(" · ");
  });

  await step("mock", "guardian pause, THEN SOL and BTC −10 % (mock Hermes) → the sweeper starts 8 auctions while paused; lane pools take them", async () => {
    await runCli("mock-guardian-pause", "keeper/src/prod/guardian.ts", ["--network", "testnet", "--env", envFile, "--rpc", rpcUrl]);
    for (const [sym, p0] of Object.entries(startPx)) {
      const p = (p0 * BigInt(900)) / BigInt(1000);
      hermes.prices.set(FEED_OF[sym], { price: p, conf: p / BigInt(10_000), expo: -8 });
    }
    const deadline = Date.now() + 120_000;
    for (;;) {
      const st = await Promise.all(Array.from({ length: 8 }, (_, lane) => read<readonly bigint[]>("auctionStats", [lane])));
      const started = st.reduce((x, y) => x + Number(y[1]), 0);
      const active = st.reduce((x, y) => x + Number(y[0]), 0);
      const taken = st.reduce((x, y) => x + Number(y[2]), 0);
      if (started >= 8 && active === 0) {
        report.mock.auctions = { started, taken, expired: st.reduce((x, y) => x + Number(y[4]), 0) };
        break;
      }
      if (Date.now() > deadline) throw new Error(`auctions started ${started}, active ${active}, taken ${taken}`);
      await sleep(1_500);
    }
    assert(await read<boolean>("paused"), "not paused any more?");
    const txs = await getJson<{ recent: Array<{ kind: string; gasLimit: string; status: string; meta: { accounts?: number } }> }>(`http://127.0.0.1:${keeperPort}/txs`);
    for (const kind of ["startAuctions", "backstopTakeBatch", "expireBatch", "cancelAuction"]) {
      const g = txs.body.recent.filter((t) => t.kind === kind && t.status === "success" && (t.meta.accounts ?? 1) === 1).map((t) => Number(t.gasLimit));
      if (g.length) report.gas.limits[`${kind}:mockPyth`] = Math.max(...g);
    }
    const a = report.mock.auctions as { started: number; taken: number; expired: number };
    return `auctions started ${a.started} while paused · taken by lane pools ${a.taken} · expired ${a.expired}`;
  });

  await step("mock", "solvency holds; unpause through the 600 s timelock (owner EOA impersonated)", async () => {
    const [sol, nat] = await Promise.all([read<readonly [bigint, bigint, bigint, boolean]>("solvency"), read<readonly [bigint, bigint, boolean]>("nativeSolvency")]);
    assert(sol[3] && nat[2], "insolvent");
    const outDir = join(OUT, "timelock-mock");
    await runCli("mock-timelock-schedule", "keeper/src/prod/timelock.ts", ["prepare", "--network", "testnet", "--env", envFile, "--rpc", rpcUrl, "--call", "unpause()", "--out", outDir, "--impersonate", "schedule"]);
    await warpTo(chain.client, (await chainTime(chain.client)) + 605);
    await runCli("mock-timelock-execute", "keeper/src/prod/timelock.ts", ["prepare", "--network", "testnet", "--env", envFile, "--rpc", rpcUrl, "--call", "unpause()", "--out", outDir, "--impersonate", "execute"]);
    assert(!(await read<boolean>("paused")), "still paused");
    return `solvent (AUSD ${Number(sol[0]) / 1e6} ≥ ${Number(sol[1]) / 1e6}); unpaused after 605 s`;
  });
  report.alerts.mock = sink.keys();
  await stopChildren();
  await hermes.stop();
  await sink.stop();
}

/** Budget gas (keeper/src/prod/budget.ts TESTNET_MEASURED_GAS): auctions = fork real-Pyth probe + (mock tx − mock probe). */
function deriveBudgetGas(): void {
  const L = report.gas.limits;
  const real = report.fork.realPythProbeGas as Record<string, bigint> | undefined;
  const mock = report.mock.mockPythProbeGas as Record<string, bigint> | undefined;
  const margin = (g: number) => Math.ceil(g * 1.1);
  if (real && mock) {
    for (const [k, kind] of [["startAuction", "startAuctions"], ["backstopTake", "backstopTakeBatch"], ["expire", "expireBatch"], ["cancelAuction", "cancelAuction"]] as const) {
      const tx = L[`${kind}:mockPyth`];
      L[k] = tx === undefined ? margin(Number(real[kind])) : Math.max(margin(Number(real[kind])), tx - margin(Number(mock[kind])) + margin(Number(real[kind])));
    }
    report.gas.notes.push("startAuction/backstopTake/expire/cancelAuction = fork real-Pyth probe + (MockPyth-leg tx − MockPyth probe), gas LIMITs with the keeper's 10% margin");
  }
  const pg = report.fork.pythPushGas as { oneFeed: bigint; twoFeeds: bigint } | undefined;
  if (pg) {
    L.pythPush = margin(Number(pg.twoFeeds));
    L.pythPush1 = margin(Number(pg.oneFeed));
  }
  L.transfer = 21_000;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  OUT = typeof args.out === "string" ? args.out : join(CONTRACTS_DIR, "cache", "rehearsal-testnet", stamp);
  mkdirSync(OUT, { recursive: true });
  log(`rehearsal → ${rel(OUT)} (local anvil only; nothing is sent to Monad testnet or mainnet)`);
  const legs = new Set(String(args.legs ?? "fork,fallback,mock").split(","));
  try {
    if (legs.has("fork")) await forkLegs(args, legs).catch((err: unknown) => log(`fork leg aborted: ${(err as Error).message}`));
    await stopChildren();
    if (legs.has("mock")) await mockLeg(args).catch((err: unknown) => log(`mock leg aborted: ${(err as Error).message}`));
    await stopChildren();
  } finally {
    if (!args.keep) for (const c of [...children, ...anvils]) if (c.exitCode === null) c.kill("SIGINT");
    deriveBudgetGas();
    writeReport();
    const s = report.summary;
    log(`done: ${s.passed} passed · ${s.failed} failed · ${s.skipped} skipped → ${rel(join(OUT, "report.json"))}`);
    if (existsSync(join(OUT, "report.json")) && args["no-bench"] !== true) {
      const dest = join(REPO_ROOT, "bench", "rehearsal", `10143-fork-${stamp.replace(/-\d{3}Z$/, "Z")}.json`);
      copyFileSync(join(OUT, "report.json"), dest);
      log(`tracked evidence: ${rel(dest)}`);
    }
    process.exitCode = s.failed ? 1 : 0;
    setTimeout(() => process.exit(process.exitCode ?? 0), 1_000);
  }
}

main().catch((err: unknown) => {
  console.error(`rehearse:testnet failed: ${(err as Error)?.message ?? err}`);
  process.exit(1);
});
