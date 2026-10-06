// `npm run dev:chain` — local chain backend in one command:
//   1. start anvil (chain 31337, 1 s interval blocks, Monad-like 150M block gas), or reuse one
//      already listening on the port;
//   2. deploy the demo stack unless deployments/31337.json already points at live contracts;
//   3. start the keeper (price loop + HTTP API on :8787) unless one is already answering.
// Ctrl-C stops whatever this command started. Safe to re-run at any time.
//
// Flags:
//   --port 8545         anvil port
//   --keeper-port P     keeper HTTP port (default KEEPER_PORT, else 8787 + (port − 8545):
//                       8545→8787, 8645→8887, 8745→8987)
//   --deployments PATH  deployment JSON to write/read (= DEPLOYMENTS_OUT). Default: the canonical
//                       deployments/31337.json on port 8545, and
//                       contracts/cache/dev-chain/<port>/deployments.json on any other port, so a
//                       private stack never overwrites the file the app reads
//   --block-time 1      anvil interval-mining block time in seconds (Monad testnet is ~0.4 s;
//                       1 s keeps local logs readable and still lands all 8 lane batches in one block)
//   --no-keeper         only chain + contracts
//   --persist           keep chain state across restarts (<log dir>/anvil-state.json)
//   --redeploy          deploy again even if the deployment file is live
//
// Uses anvil's public dev keys. keeper/.env (Monad keys) is NOT read; put local overrides in
// keeper/.env.anvil if you need any.

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { CONTRACTS_DIR, envStr, KEEPER_ANVIL_ENV_FILE, loadKeeperEnv, parseArgs, REPO_ROOT, sleep } from "../keeper/src/env";
import {
  ANVIL_CHAIN_ID,
  ANVIL_ROLE_INDEX,
  anvilAccount,
  CANONICAL_ANVIL_PORT,
  CANONICAL_KEEPER_PORT,
  deploymentLabel,
  detectChain,
  privateDeploymentsFile,
  readDeployment,
  type ChainInfo,
} from "../keeper/src/network";
import { DEFAULT_MIN_DISCOUNT_BPS, deployStack, foundryBin, isDeployed, readMinDiscounts } from "./lib/deploy";

const children: ChildProcess[] = [];
let shuttingDown = false;

function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of [...children].reverse()) {
    if (c.exitCode === null && c.signalCode === null) c.kill("SIGINT"); // SIGINT: anvil dumps --state on it
  }
  setTimeout(() => process.exit(code), 500);
}

async function probe(rpcUrl: string): Promise<ChainInfo | null> {
  try {
    return await detectChain(rpcUrl);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (/Unsupported chain/.test(msg)) throw err;
    return null;
  }
}

async function keeperUp(port: number): Promise<number | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_500) });
    if (!res.ok) return null;
    return ((await res.json()) as { chainId: number }).chainId;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadKeeperEnv(KEEPER_ANVIL_ENV_FILE);
  const port = Number(args.port ?? 8545);
  if (!Number.isInteger(port) || port <= 0) throw new Error("--port must be a port number");
  const canonical = port === CANONICAL_ANVIL_PORT;
  const blockTime = String(args["block-time"] ?? "1");
  const rpcUrl = `http://127.0.0.1:${port}`;
  const keeperPort = Number(
    args["keeper-port"] ?? envStr("KEEPER_PORT") ?? CANONICAL_KEEPER_PORT + (port - CANONICAL_ANVIL_PORT),
  );
  if (!Number.isInteger(keeperPort) || keeperPort <= 0) throw new Error("--keeper-port must be a port number");
  const logDir = canonical ? join(CONTRACTS_DIR, "cache", "dev-chain") : join(CONTRACTS_DIR, "cache", "dev-chain", String(port));
  mkdirSync(logDir, { recursive: true });
  // Private stacks get their own deployment file: deployments/31337.json belongs to the :8545 stack.
  const depOut =
    typeof args.deployments === "string"
      ? args.deployments
      : (envStr("DEPLOYMENTS_OUT") ?? (canonical ? undefined : privateDeploymentsFile(port)));
  if (depOut) process.env.DEPLOYMENTS_OUT = depOut;
  else delete process.env.DEPLOYMENTS_OUT;

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  // 1. Chain.
  let info = await probe(rpcUrl);
  if (info) {
    if (info.network !== "anvil") throw new Error(`${rpcUrl} is not anvil (${info.clientVersion})`);
    console.log(`[dev:chain] reusing anvil already running on ${rpcUrl} (chain ${info.chainId})`);
  } else {
    const anvilArgs = [
      "--port", String(port),
      "--chain-id", String(ANVIL_CHAIN_ID),
      "--block-time", blockTime,
      // Monad's documented block gas limit is 150M and per-tx limit 30M (docs.monad.xyz,
      // gas-pricing). Anvil only enforces the block limit; the keeper enforces the per-tx cap.
      "--gas-limit", "150000000",
      // Prague, not anvil's newer default: Osaka's EIP-7825 caps txs at 2^24 gas, which Monad doesn't.
      "--hardfork", "prague",
      "--accounts", "12",
    ];
    if (args.persist) anvilArgs.push("--state", join(logDir, "anvil-state.json"));
    const logFile = join(logDir, "anvil.log");
    const fd = openSync(logFile, "w");
    const anvil = spawn(foundryBin("anvil"), anvilArgs, { stdio: ["ignore", fd, fd] });
    closeSync(fd);
    children.push(anvil);
    anvil.on("exit", (code, signal) => {
      if (!shuttingDown) {
        console.error(`[dev:chain] anvil exited (${code ?? signal}); see ${logFile}`);
        shutdown(1);
      }
    });
    for (let i = 0; i < 100 && !info; i++) {
      await sleep(150);
      info = await probe(rpcUrl);
    }
    if (!info) throw new Error(`anvil did not come up on ${rpcUrl}; see ${logFile}`);
    console.log(`[dev:chain] anvil up on ${rpcUrl} · chain ${info.chainId} · ${blockTime}s blocks · log ${logFile}`);
  }

  // 2. Contracts.
  const operator = anvilAccount(ANVIL_ROLE_INDEX.operator).address;
  if (!args.redeploy && (await isDeployed(rpcUrl, info, operator))) {
    console.log(`[dev:chain] contracts already live (${deploymentLabel(info.chainId)}); skipping deploy`);
    try {
      const want = Number(envStr("BACKSTOP_MIN_DISCOUNT_BPS") ?? DEFAULT_MIN_DISCOUNT_BPS);
      const dep = readDeployment(info.chainId);
      const mins = dep ? await readMinDiscounts(rpcUrl, dep) : {};
      const off = Object.entries(mins).filter(([, lanes]) => lanes.some((b) => b !== want));
      if (off.length) {
        console.warn(
          `[dev:chain] WARNING backstopMinDiscountBps ${off.map(([n, l]) => `${n}=[${l.join(",")}]`).join(" ")} ≠ ${want}: ` +
            "these contracts predate the current defaults — run with --redeploy.",
        );
      }
    } catch {
      /* pre-auction contracts: nothing to check */
    }
  } else {
    await deployStack({ network: "anvil", rpcUrl, verbose: false });
  }

  // 3. Keeper.
  if (!args["no-keeper"]) {
    const existing = await keeperUp(keeperPort);
    if (existing !== null) {
      console.log(`[dev:chain] keeper already answering on :${keeperPort} (chain ${existing}); not starting another`);
    } else {
      const tsx = join(REPO_ROOT, "node_modules", ".bin", "tsx");
      const keeper = spawn(tsx, [join(REPO_ROOT, "keeper", "src", "index.ts")], {
        cwd: REPO_ROOT,
        stdio: "inherit",
        env: {
          ...process.env,
          KEEPER_ENV_FILE: KEEPER_ANVIL_ENV_FILE,
          KEEPER_RPC_URL: rpcUrl,
          KEEPER_PORT: String(keeperPort),
        },
      });
      children.push(keeper);
      keeper.on("exit", (code, signal) => {
        if (shuttingDown) return;
        children.splice(children.indexOf(keeper), 1);
        if (children.length === 0) {
          console.error(`[dev:chain] keeper exited (${code ?? signal}); nothing left to supervise`);
          shutdown(code ?? 1);
          return;
        }
        // Keep the chain up (the app stays connected); re-running dev:chain restarts just the keeper.
        console.error(
          `[dev:chain] keeper exited (${code ?? signal}). Chain still running — run \`npm run dev:chain\` again ` +
            "in another terminal to restart only the keeper, or Ctrl-C here to stop the chain.",
        );
      });
    }
  }

  if (children.length === 0) {
    console.log("[dev:chain] everything was already running; nothing to supervise. Done.");
    process.exit(0);
  }
  console.log("[dev:chain] ready. Ctrl-C to stop.");
}

main().catch((err: unknown) => {
  console.error(`[dev:chain] failed: ${(err as Error)?.message ?? err}`);
  shutdown(1);
});
