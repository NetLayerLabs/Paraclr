// `npm run sandbox` — a LOCAL production sandbox: the production contract and keeper on an anvil
// fork of Monad TESTNET, for clicking through the app before anything is deployed for real.
// Nothing here sends a transaction to Monad testnet or mainnet.
//
//   chain    anvil --fork-url https://testnet-rpc.monad.xyz on :8645 (chain id 10143, 1 s blocks,
//            --code-size-limit 131072). The real Agora testnet AUSD + faucet and the real Pyth.
//   deploy   ParaclrClearinghouseProd v5 through `deploy:testnet` (DeployProd.s.sol): SOL/AUSD +
//            BTC/AUSD, a 600 s timelock, owner = anvil dev account 0 (OWNER_IS_EOA=true; its key is
//            anvil's public dev key, so you can poke admin functions locally). Lane insurance (200)
//            and backstop pools (100) seeded with testnet AUSD from Agora's faucet / storage cheats.
//            Deployment file: deployments/sandbox/10143.json (gitignored), never deployments/10143.json.
//   keeper   the production keeper in testnet mode on :8887 (CORS http://localhost:3002) with the
//            sandbox-only POST /faucet (fork MON + testnet AUSD).
//   prices   --prices hermes (default when keeper/.env.sandbox has PYTH_API_KEY): LIVE Pyth updates
//            from Hermes for SOL/BTC, verified by the real Pyth contract on the fork.
//            --prices signed (default without a key): the trial-end fallback — KeeperSignedPyth is
//            deployed on the fork and switched in through the timelock (the 600 s delay is warped,
//            so the fork clock runs 10 min ahead), prices relayed live from Pyth's storage on Monad
//            mainnet and signed by the keeper. Labelled "keeper-signed" everywhere.
//
//   npm run sandbox                  start (foreground; Ctrl-C stops anvil + keeper)
//   npm run sandbox -- --detach      start and return (logs in contracts/cache/sandbox/)
//   npm run sandbox -- --stop        stop a detached sandbox (only the PIDs it recorded)
//   npm run sandbox -- --smoke       after start: faucet → deposit → a SOL order must fill
//   flags: --prices hermes|signed · --port 8645 · --keeper-port 8887 · --app-origin http://localhost:3002
//
// keeper/.env.sandbox (gitignored) is read for ONE line only: PYTH_API_KEY=… (copy it in yourself).
// The app: `npm run dev:sandbox` (printed at the end).

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, http, parseAbi, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CONTRACTS_DIR, DEPLOYMENTS_DIR, parseArgs, REPO_ROOT, rpcHost } from "../keeper/src/env";
import { foundryBin } from "../keeper/src/foundry";
import { clearinghouseAbi, erc20Abi, pythAbi } from "../keeper/src/prod/abi";
import { connectMainnet, KNOWN, KNOWN_TESTNET, MAINNET_RPC_URL, rel, selectProdNetwork, TESTNET_RPC_URL, type Client } from "../keeper/src/prod/config";
import { readProdDeployment } from "../keeper/src/prod/deployment";
import { subsetUpdate } from "../keeper/src/prod/pyth-wire";
import { harvestUpdates, updatesWith } from "./lib/pyth-replay";
import { dealToken, portFree, sendAs, setBalance, sleep } from "./lib/rehearsal";

selectProdNetwork("testnet");

const DIR = join(CONTRACTS_DIR, "cache", "sandbox");
const PIDS = join(DIR, "pids.json");
const ENV = join(DIR, "sandbox.env");
const SANDBOX_KEYFILE = join(REPO_ROOT, "keeper", ".env.sandbox");
const DEP_FILE = join(DEPLOYMENTS_DIR, "sandbox", "10143.json");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
/** anvil's well-known dev accounts (public keys; valid only on a local anvil). */
const DEV0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const DEV1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const SOL = KNOWN.feeds["SOL/AUSD"].toLowerCase() as Hex;
const BTC = KNOWN.feeds["BTC/AUSD"].toLowerCase() as Hex;

function say(m: string): void {
  const line = `[sandbox] ${m}`;
  console.log(line);
  appendFileSync(join(DIR, "sandbox.log"), `${new Date().toISOString()} ${line}\n`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stop the processes a previous sandbox recorded (and nothing else). */
async function stopRecorded(): Promise<number> {
  if (!existsSync(PIDS)) return 0;
  const pids = JSON.parse(readFileSync(PIDS, "utf8")) as Record<string, number>;
  let n = 0;
  for (const [name, pid] of Object.entries(pids)) {
    if (pid && alive(pid)) {
      process.kill(pid, "SIGTERM");
      n++;
      say(`stopped ${name} (pid ${pid})`);
    }
  }
  for (let i = 0; i < 20 && Object.values(pids).some((p) => p && alive(p)); i++) await sleep(250);
  for (const pid of Object.values(pids)) if (pid && alive(pid)) process.kill(pid, "SIGKILL");
  rmSync(PIDS, { force: true });
  return n;
}

function recordPid(name: string, pid: number | undefined): void {
  const cur = existsSync(PIDS) ? (JSON.parse(readFileSync(PIDS, "utf8")) as Record<string, number>) : {};
  cur[name] = pid ?? 0;
  writeFileSync(PIDS, JSON.stringify(cur, null, 2));
}

/** PYTH_API_KEY from keeper/.env.sandbox (only that line is read; the value is never printed). */
function sandboxPythKey(): string | null {
  if (process.env.PYTH_API_KEY?.trim()) return process.env.PYTH_API_KEY.trim();
  if (!existsSync(SANDBOX_KEYFILE)) return null;
  const line = readFileSync(SANDBOX_KEYFILE, "utf8").split("\n").find((l) => /^\s*PYTH_API_KEY\s*=/.test(l));
  const v = line?.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
  return v ? v : null;
}

function spawnLogged(name: string, cmd: string, args: string[], detach: boolean, env: NodeJS.ProcessEnv = process.env): ChildProcess {
  const fd = openSync(join(DIR, `${name}.log`), "w");
  const child = spawn(cmd, args, { cwd: REPO_ROOT, env, stdio: ["ignore", fd, fd], detached: detach });
  closeSync(fd);
  if (detach) child.unref();
  recordPid(name, child.pid);
  return child;
}

function runCli(name: string, script: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [join(REPO_ROOT, script), ...args], { cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("exit", (code) => {
      writeFileSync(join(DIR, `${name}.log`), out);
      if (code === 0) resolve(out);
      else reject(new Error(`${name} exited ${code}: ${out.trim().split("\n").slice(-3).join(" | ")} (log ${rel(join(DIR, `${name}.log`))})`));
    });
  });
}

async function waitRpc(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) return;
    } catch {
      /* not up */
    }
    if (Date.now() > deadline) throw new Error(`anvil did not come up on ${url}`);
    await sleep(200);
  }
}

async function waitHealth(port: number, child: ChildProcess, timeoutMs = 120_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null || (child.pid && !alive(child.pid))) {
      const tail = readFileSync(join(DIR, "keeper.log"), "utf8").trim().split("\n").slice(-2).join(" | ").replace(/0x[0-9a-fA-F]{64}/g, "<redacted>");
      throw new Error(`the keeper exited: ${tail}`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
      if (r.ok) return (await r.json()) as Record<string, unknown>;
    } catch {
      /* not up */
    }
    if (Date.now() > deadline) throw new Error(`keeper on :${port} did not answer /health within ${timeoutMs / 1000}s (log ${rel(join(DIR, "keeper.log"))})`);
    await sleep(500);
  }
}

/** No API key: put the newest REAL signed SOL+BTC update pushed on Monad mainnet into the fork's Pyth. */
async function pushHarvestedUpdate(client: Client, chainRpc: string): Promise<string> {
  const mainnet = createPublicClient({ transport: http(MAINNET_RPC_URL, { retryCount: 6, retryDelay: 800, timeout: 20_000 }) }) as unknown as Client;
  let all: Awaited<ReturnType<typeof harvestUpdates>> = [];
  for (let attempt = 1; ; attempt++) {
    try {
      const head = Number(await mainnet.getBlockNumber());
      all = updatesWith(await harvestUpdates(mainnet, KNOWN.pyth, [SOL, BTC], head - 600, head), [SOL, BTC]);
      break;
    } catch (err) {
      if (attempt >= 4) throw new Error(`reading recent Pyth updates from Monad mainnet failed: ${(err as Error).message.split("\n")[0]}`);
      say(`mainnet RPC hiccup (${(err as Error).message.split("\n")[0].slice(0, 80)}); retrying`);
      await sleep(2_000 * attempt);
    }
  }
  const u = all[all.length - 1];
  if (!u) throw new Error("no recent SOL+BTC Pyth update on Monad mainnet to seed the fork with");
  const blob = subsetUpdate(u.blob, [SOL, BTC]);
  const payer = privateKeyToAccount(DEV1);
  const fee = await client.readContract({ address: KNOWN_TESTNET.pyth, abi: pythAbi, functionName: "getUpdateFee", args: [[blob]] });
  const wallet = createWalletClient({ account: payer, transport: http(chainRpc) });
  const data = encodeFunctionData({ abi: pythAbi, functionName: "updatePriceFeeds", args: [[blob]] });
  const hash = await wallet.sendTransaction({ to: KNOWN_TESTNET.pyth, data, value: fee, gas: BigInt(400_000), chain: null });
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error("pushing the harvested update reverted");
  return `pushed a real signed SOL+BTC update from mainnet tx ${u.txHash.slice(0, 12)}… (publish ${u.messages[SOL].publishTime})`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(DIR, { recursive: true });
  if (args.stop === true) {
    const n = await stopRecorded();
    console.log(n ? `[sandbox] stopped ${n} process(es)` : "[sandbox] nothing recorded as running");
    return;
  }
  const port = Number(args.port ?? 8645);
  const keeperPort = Number(args["keeper-port"] ?? 8887);
  const appOrigin = typeof args["app-origin"] === "string" ? args["app-origin"] : "http://localhost:3002";
  const detach = args.detach === true;
  const key = sandboxPythKey();
  const prices = typeof args.prices === "string" ? args.prices : key ? "hermes" : "signed";
  if (prices !== "hermes" && prices !== "signed") throw new Error("--prices must be hermes or signed");
  if (prices === "hermes" && !key) throw new Error(`--prices hermes needs PYTH_API_KEY in ${rel(SANDBOX_KEYFILE)} (one line: PYTH_API_KEY=…)`);

  // restartable: stop only what a previous sandbox recorded, then insist the ports are ours to take
  const stopped = await stopRecorded();
  if (stopped) await sleep(500);
  for (const p of [port, keeperPort]) if (!(await portFree(p))) throw new Error(`port ${p} is busy and not a recorded sandbox process; stop it yourself or pass --port / --keeper-port`);
  writeFileSync(join(DIR, "sandbox.log"), "");
  say(`starting: anvil fork of Monad testnet on :${port} · keeper :${keeperPort} · prices ${prices}${prices === "hermes" ? " (live Hermes, key from keeper/.env.sandbox)" : " (keeper-signed fallback)"}`);

  // 1. chain
  const anvilArgs = ["--port", String(port), "--fork-url", TESTNET_RPC_URL, "--code-size-limit", "131072", "--gas-limit", "150000000", "--hardfork", "prague", "--block-time", "1", "--no-rate-limit", "--fork-retry-backoff", "500", "--retries", "8", "--timeout", "45000"];
  const anvil = spawnLogged("anvil", foundryBin("anvil"), anvilArgs, detach);
  const rpcUrl = `http://127.0.0.1:${port}`;
  await waitRpc(rpcUrl);
  const chain = await connectMainnet(rpcUrl);
  if (chain.chainId !== 10143 || chain.network !== "anvil-fork") throw new Error(`expected an anvil fork of 10143, got ${chain.chainId}/${chain.network}`);
  say(`anvil fork of ${rpcHost(TESTNET_RPC_URL)} at block ${await chain.client.getBlockNumber()} (pid ${anvil.pid})`);

  // anvil's public dev accounts are EIP-7702-delegated on Monad testnet (to a sweeper-style
  // contract): clear that on the fork so the owner and the treasury are plain EOAs here.
  for (const k of [DEV0, DEV1]) {
    const a = privateKeyToAccount(k).address;
    await chain.client.request({ method: "anvil_setCode" as never, params: [a, "0x"] as never });
    await setBalance(chain.client, a, parseEther("10000"));
  }

  // 2. env: throwaway hot keys (keeper:init), sandbox overrides
  rmSync(ENV, { force: true });
  rmSync(DEP_FILE, { force: true });
  mkdirSync(join(DEPLOYMENTS_DIR, "sandbox"), { recursive: true });
  await runCli("keeper-init", "keeper/src/init-env.ts", ["--network", "testnet", "--env", ENV]);
  const owner = privateKeyToAccount(DEV0).address;
  appendFileSync(
    ENV,
    [
      "",
      "# ---- LOCAL SANDBOX (anvil fork of Monad testnet; throwaway keys; never a real chain) ----",
      `KEEPER_RPC_URL=${rpcUrl}`,
      `OWNER_MULTISIG_ADDRESS=${owner}`,
      "OWNER_IS_EOA=true",
      `KEEPER_PORT=${keeperPort}`,
      `KEEPER_CORS_ORIGIN=${appOrigin}`,
      `DEPLOYMENTS_OUT=${DEP_FILE}`,
      "SANDBOX_FAUCET=1",
      "MONAD_RESERVE_GUARD=0",
      `SIGNER_STATE_FILE=${join(DIR, "signer-state.json")}`,
      ...(key ? [`PYTH_API_KEY=${key}`] : ["PYTH_API_KEY="]),
      "",
    ].join("\n"),
  );
  chmodSync(ENV, 0o600);
  const env = (n: string) => readFileSync(ENV, "utf8").split("\n").find((l) => l.startsWith(`${n}=`))?.slice(n.length + 1).trim();
  for (const k of ["DEPLOYER_PRIVATE_KEY", "GUARDIAN_PRIVATE_KEY", "OPS_PRIVATE_KEY"]) await setBalance(chain.client, privateKeyToAccount(env(k) as Hex).address, parseEther("1000"));
  for (const k of (env("KEEPER_PRIVATE_KEYS") ?? "").split(",")) await setBalance(chain.client, privateKeyToAccount(k as Hex).address, parseEther("1000"));
  say(`env ${rel(ENV)} (mode 600, throwaway keys); owner = anvil dev account 0 ${owner} (OWNER_IS_EOA)`);

  // 3. Pyth: SOL was last pushed on testnet days ago; DeployProd needs ≤ 1 h
  // (pushed in both modes, so the deploy never depends on Hermes; the keeper then uses live Hermes in hermes mode)
  say(await pushHarvestedUpdate(chain.client, rpcUrl));
  const cli = ["--network", "testnet", "--env", ENV, "--rpc", rpcUrl];
  // forge runs from a shadow root on a fork and may only write under contracts/cache: deploy there,
  // then copy to deployments/sandbox/ (what the keeper, the CLIs and the app read).
  const forgeOut = join(DIR, "deployments", "10143.json");
  rmSync(forgeOut, { force: true });
  const dout = await runCli("deploy", "scripts/deploy-mainnet.ts", cli, { DEPLOYMENTS_OUT: forgeOut });
  if (!/all checks passed/.test(dout.split("post-deploy verification")[1] ?? "")) throw new Error("post-deploy verification failed (see deploy.log)");
  copyFileSync(forgeOut, DEP_FILE);
  const dep = readProdDeployment(DEP_FILE);
  if (!dep) throw new Error("no deployment file");
  say(`deployed ParaclrClearinghouseProd ${dep.clearinghouse} · timelock ${dep.timelock} · markets ${Object.keys(dep.markets).join(", ")} → ${rel(DEP_FILE)}`);

  // 4. seed lanes with testnet AUSD (Agora's faucet once, storage cheat as needed)
  const treasury = privateKeyToAccount(DEV1);
  const faucetData = encodeFunctionData({ abi: parseAbi(["function requestFunds(address to)"]), functionName: "requestFunds", args: [treasury.address] });
  const viaFaucet = await sendAs(chain, treasury, KNOWN_TESTNET.ausdFaucet, faucetData).then((r) => r.status === "success", () => false);
  const need = BigInt(8 * 300 * 1e6);
  const bal = await chain.client.readContract({ address: dep.ausd, abi: erc20Abi, functionName: "balanceOf", args: [treasury.address] });
  if (bal < need) await dealToken(chain.client, dep.ausd, treasury.address, need);
  await sendAs(chain, treasury, dep.ausd, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [dep.clearinghouse, need] }));
  for (let lane = 0; lane < 8; lane++) {
    await sendAs(chain, treasury, dep.clearinghouse, encodeFunctionData({ abi: clearinghouseAbi, functionName: "fundLane", args: [lane, BigInt(200e6)] }));
    await sendAs(chain, treasury, dep.clearinghouse, encodeFunctionData({ abi: clearinghouseAbi, functionName: "backstopDeposit", args: [lane, BigInt(100e6), []] }));
  }
  say(`seeded 8 lanes: insurance 200 + backstop pool 100 AUSD each (treasury = anvil dev account 1; ${viaFaucet ? "10,000 AUSD from Agora's faucet" : "AUSD by storage cheat"})`);

  // 5. signed prices: the trial-end fallback through the timelock (delay warped)
  if (prices === "signed") {
    const out = await runCli("oracle-deploy", "scripts/testnet-oracle.ts", ["deploy", ...cli]);
    const oracle = /deployed (0x[0-9a-fA-F]{40})/.exec(out)?.[1] as Address | undefined;
    if (!oracle) throw new Error("fallback oracle not deployed (oracle-deploy.log)");
    await runCli("setpyth-schedule", "keeper/src/prod/timelock.ts", ["set-pyth", "--to", oracle, ...cli, "--out", join(DIR, "timelock"), "--impersonate", "schedule"]);
    await chain.client.request({ method: "evm_increaseTime" as never, params: [601] as never });
    await chain.client.request({ method: "evm_mine" as never, params: [] as never });
    await runCli("oracle-push", "keeper/src/prod/push-cli.ts", ["--signed", "--count", "1", ...cli]);
    await runCli("setpyth-execute", "keeper/src/prod/timelock.ts", ["set-pyth", "--to", oracle, ...cli, "--out", join(DIR, "timelock"), "--impersonate", "execute"]);
    await runCli("oracle-record", "scripts/testnet-oracle.ts", ["record", "--live", ...cli]);
    say(`clearinghouse switched to the KEEPER-SIGNED fallback ${oracle} through the timelock (600 s warped: the fork clock runs ~10 min ahead of the wall clock)`);
  }

  // 6. keeper
  const keeper = spawnLogged("keeper", TSX, [join(REPO_ROOT, "keeper/src/index.ts"), "--network", "testnet", "--env", ENV, "--rpc", rpcUrl], detach);
  const h = await waitHealth(keeperPort, keeper);
  say(`keeper up (pid ${keeper.pid}): mode ${h.mode} · priceSource ${h.priceSource} · sandbox ${h.sandbox} · markets ${Object.keys(h.markets as object).join(", ")}`);

  if (args.smoke === true) {
    const live = await chain.client.readContract({ address: dep.clearinghouse, abi: parseAbi(["function pyth() view returns (address)"]), functionName: "pyth" });
    await smoke(chain.client, rpcUrl, keeperPort, dep.clearinghouse, dep.ausd, dep.markets["SOL/AUSD"], live);
  }

  console.log(`
────────────────────────────────────────────────────────────────────────────────
 LOCAL SANDBOX — anvil fork of Monad testnet (chain 10143). Not live; no real value.
   RPC        ${rpcUrl}
   keeper     http://127.0.0.1:${keeperPort}  (/health · /hermes · POST /faucet {"address":"0x…"} = fork MON + testnet AUSD)
   deployment ${rel(DEP_FILE)}   prices: ${h.priceSource}${prices === "signed" ? " (keeper-signed fallback)" : " (live Pyth via Hermes)"}
   owner      anvil dev account 0 ${owner} (timelock proposer/executor, 600 s; key = anvil's public dev key)
   logs       ${rel(DIR)}/{anvil,keeper,deploy}.log

 App (frontend monad-testnet mode against the sandbox):
   npm run dev:sandbox
 which is:
   NEXT_PUBLIC_CHAIN_MODE=monad-testnet NEXT_PUBLIC_MONAD_TESTNET_RPC_URL=${rpcUrl} NEXT_PUBLIC_KEEPER_URL=http://127.0.0.1:${keeperPort} PARACLR_DEPLOYMENTS_DIR=deployments/sandbox npx next dev -p ${new URL(appOrigin).port || 3002}
   (wallet network: chain id 10143, RPC ${rpcUrl})
 Stop: ${detach ? "npm run sandbox -- --stop" : "Ctrl-C"}
────────────────────────────────────────────────────────────────────────────────`);

  if (detach) {
    process.exit(0);
  }
  const stop = async () => {
    say("stopping");
    await stopRecorded();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  anvil.on("exit", (c) => say(`anvil exited (${c})`));
  keeper.on("exit", (c) => say(`keeper exited (${c}); see ${rel(join(DIR, "keeper.log"))}`));
  await new Promise(() => undefined);
}

/** faucet → deposit → a SOL order through the keeper must fill (the sandbox's acceptance test). */
async function smoke(client: Client, rpcUrl: string, keeperPort: number, ch: Address, ausd: Address, sol: Hex, oracle: Address): Promise<void> {
  const trader = privateKeyToAccount(generatePrivateKey());
  const f = await fetch(`http://127.0.0.1:${keeperPort}/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: trader.address }) });
  const fj = (await f.json()) as { method?: string; error?: string };
  if (f.status !== 200) throw new Error(`smoke: /faucet ${f.status} ${fj.error}`);
  const wallet = createWalletClient({ account: trader, transport: http(rpcUrl) });
  const send = async (to: Address, data: Hex, value = BigInt(0)) => {
    const hash = await wallet.sendTransaction({ to, data, value, gas: BigInt(800_000), chain: null });
    const r = await client.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`smoke: tx ${hash} reverted`);
    return r;
  };
  await send(ausd, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ch, BigInt(50e6)] }));
  await send(ch, encodeFunctionData({ abi: clearinghouseAbi, functionName: "deposit", args: [BigInt(50e6)] }));
  const r = await fetch(`http://127.0.0.1:${keeperPort}/hermes/v2/updates/price/latest?ids[]=${SOL}`);
  const body = (await r.json()) as { parsed: Array<{ price: { price: string; expo: number; publish_time: number } }> };
  const p = body.parsed[0].price;
  const px = (BigInt(p.price) * BigInt(10) ** BigInt(18)) / BigInt(10) ** BigInt(-p.expo);
  const size = (BigInt(60e6) * BigInt(10) ** BigInt(30)) / px;
  const fee = await client.readContract({ address: ch, abi: clearinghouseAbi, functionName: "minExecutionFee" });
  const rc = await send(ch, encodeFunctionData({ abi: clearinghouseAbi, functionName: "commitOrder", args: [sol, size, BigInt(20e6), (px * BigInt(102)) / BigInt(100)] }), fee);
  const logs = rc.logs.filter((l) => l.address.toLowerCase() === ch.toLowerCase());
  let id: bigint | undefined;
  for (const l of logs) {
    try {
      const e = decodeEventLog({ abi: clearinghouseAbi, data: l.data, topics: l.topics });
      if (e.eventName === "OrderCommitted") id = (e.args as unknown as { orderId: bigint }).orderId;
    } catch {
      /* other event */
    }
  }
  if (id === undefined) throw new Error("smoke: no OrderCommitted");
  const deadline = Date.now() + 120_000;
  for (;;) {
    const o = (await client.readContract({ address: ch, abi: clearinghouseAbi, functionName: "getOrder", args: [id] })) as unknown as { status: number };
    if (o.status === 2) break;
    if (o.status !== 1) throw new Error(`smoke: order ${id} ended with status ${o.status}`);
    if (Date.now() > deadline) throw new Error(`smoke: order ${id} still pending after 120 s`);
    await sleep(500);
  }
  const k = (await (await fetch(`http://127.0.0.1:${keeperPort}/orders/${id}`)).json()) as { latencyS?: number; fillPrice?: string };
  say(`SMOKE OK: faucet (${fj.method}) → deposit 50 AUSD → SOL long ${Number(size) / 1e18} filled by the keeper (latency ${k.latencyS ?? "?"} s, fill ${k.fillPrice ?? "?"}, oracle ${oracle})`);
}

main().catch(async (err: unknown) => {
  console.error(`[sandbox] failed: ${(err as Error)?.message ?? err}`);
  await stopRecorded().catch(() => undefined);
  process.exit(1);
});
