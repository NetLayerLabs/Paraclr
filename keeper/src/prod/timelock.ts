// `npm run timelock -- --network mainnet <prepare|status> …` — prepare and track owner changes that
// go through the TimelockController (the clearinghouse owner). The keeper NEVER holds the owner
// key: `prepare` writes Safe Transaction Builder JSON files (schedule, then execute after the
// delay) for the multisig / hardware wallet to sign. docs/RUNBOOK.md "Timelock change procedure".
//
//   prepare --call "unpause()"                                    # target = the clearinghouse
//   prepare --call "setCaps(uint256,uint256,uint256)" --args 100000000,1000000000,50000
//   prepare --call "setGuardian(address)" --args 0xNEW… [--target clearinghouse|timelock|0x…]
//           [--value WEI] [--salt TEXT|0x32bytes] [--delay S (default getMinDelay())] [--out DIR]
//   status  --call … --args … [--salt …]   or   status --id 0xOPERATION_ID
//   feed-swap --market MON/AUSD --feed 0xNEW --max-deviation-bps 500
//           dead-feed procedure (contract v3, docs/RUNBOOK.md "Dead feed"): prepares the timelock
//           operation replaceMarketFeed(market, newFeed, maxDeviationBps ≤ 1000; ≤ 5000 for a
//           provably dead old feed on v4) and prints the
//           steps (keep `npm run pyth:push -- --feeds 0xNEW` running when the Safe executes it)
//   seed    --insurance 200 --pool 100 [--lanes 0-7 | 7 | 1,3]
//           launch seeding batch for the TREASURY Safe (no timelock: fundLane / backstopDeposit are
//           permissionless): AUSD approve + fundLane(lane, insurance) + backstopDeposit(lane, pool)
//           for every lane, as one Safe Transaction Builder file. Amounts in whole AUSD.
//
// Rehearsal only (anvil fork): `--impersonate schedule|execute` sends the call from
// OWNER_MULTISIG_ADDRESS through anvil_impersonateAccount, to exercise the exact procedure.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  encodeFunctionData,
  getAddress,
  isAddress,
  isHex,
  keccak256,
  parseAbiItem,
  toHex,
  type AbiFunction,
  type Address,
  type Hex,
} from "viem";
import { envStr, parseArgs, REPO_ROOT } from "../env";
import { timelockAbi } from "./abi";
import { connectMainnet, loadMainnetEnv, mainnetRpcUrl, rel, type ProdChain } from "./config";
import { loadProdDeployment, type ProdDeployment } from "./deployment";
import { decodeRevert } from "./tx";

const ZERO32 = `0x${"0".repeat(64)}` as Hex;

function coerce(type: string, raw: string): unknown {
  if (/^u?int\d*$/.test(type)) return BigInt(raw);
  if (type === "address") {
    if (!isAddress(raw)) throw new Error(`"${raw}" is not an address`);
    return getAddress(raw);
  }
  if (type === "bool") return raw === "true" || raw === "1";
  if (/^bytes\d+$/.test(type) || type === "bytes") {
    if (!isHex(raw)) throw new Error(`"${raw}" is not hex`);
    return raw;
  }
  if (type === "string") return raw;
  throw new Error(`argument type ${type} not supported by this helper; encode the calldata yourself`);
}

export interface PreparedOp {
  target: Address;
  value: bigint;
  data: Hex;
  predecessor: Hex;
  salt: Hex;
  delay: bigint;
  id: Hex;
  scheduleData: Hex;
  executeData: Hex;
  description: string;
}

export async function prepareOp(
  chain: ProdChain,
  dep: ProdDeployment,
  opts: { call: string; args?: string; target?: string; value?: string; salt?: string; delay?: string },
): Promise<PreparedOp> {
  if (!dep.timelock) throw new Error("the deployment file has no timelock address");
  const fn = parseAbiItem(`function ${opts.call}`) as AbiFunction;
  const rawArgs = opts.args ? opts.args.split(",").map((s) => s.trim()) : [];
  if (rawArgs.length !== fn.inputs.length) throw new Error(`${fn.name} takes ${fn.inputs.length} argument(s), got ${rawArgs.length}`);
  const args = fn.inputs.map((inp, i) => coerce(inp.type, rawArgs[i]));
  const data = encodeFunctionData({ abi: [fn], functionName: fn.name, args });
  const target =
    !opts.target || opts.target === "clearinghouse"
      ? dep.clearinghouse
      : opts.target === "timelock"
        ? dep.timelock
        : isAddress(opts.target)
          ? getAddress(opts.target)
          : (() => {
              throw new Error("--target must be clearinghouse, timelock or an address");
            })();
  const salt = !opts.salt ? keccak256(toHex(`paraclr:${opts.call}:${opts.args ?? ""}`)) : isHex(opts.salt) && opts.salt.length === 66 ? (opts.salt as Hex) : keccak256(toHex(opts.salt));
  const minDelay = await chain.client.readContract({ address: dep.timelock, abi: timelockAbi, functionName: "getMinDelay" });
  const delay = opts.delay ? BigInt(opts.delay) : minDelay;
  if (delay < minDelay) throw new Error(`--delay ${delay} is below the timelock's minimum ${minDelay}`);
  const value = BigInt(opts.value ?? "0");
  const id = await chain.client.readContract({
    address: dep.timelock,
    abi: timelockAbi,
    functionName: "hashOperation",
    args: [target, value, data, ZERO32, salt],
  });
  return {
    target,
    value,
    data,
    predecessor: ZERO32,
    salt,
    delay,
    id,
    scheduleData: encodeFunctionData({ abi: timelockAbi, functionName: "schedule", args: [target, value, data, ZERO32, salt, delay] }),
    executeData: encodeFunctionData({ abi: timelockAbi, functionName: "execute", args: [target, value, data, ZERO32, salt] }),
    description: `${fn.name}(${rawArgs.join(", ")}) on ${target}`,
  };
}

export async function opStatus(chain: ProdChain, timelock: Address, id: Hex) {
  const read = (functionName: "isOperationPending" | "isOperationReady" | "isOperationDone" | "getTimestamp") =>
    chain.client.readContract({ address: timelock, abi: TL_STATUS_ABI, functionName, args: [id] });
  const [pending, ready, done, ts] = await Promise.all([read("isOperationPending"), read("isOperationReady"), read("isOperationDone"), read("getTimestamp")]);
  return { pending: pending as boolean, ready: ready as boolean, done: done as boolean, readyAt: Number(ts as bigint) };
}

const TL_STATUS_ABI = [
  { type: "function", name: "isOperationPending", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "isOperationReady", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "isOperationDone", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "getTimestamp", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "uint256" }] },
] as const;

function safeBatch(chainId: number, name: string, description: string, to: Address, data: Hex) {
  return {
    version: "1.0",
    chainId: String(chainId),
    createdAt: Date.now(),
    meta: { name, description, txBuilderVersion: "1.16.5" },
    transactions: [{ to, value: "0", data, contractMethod: null, contractInputsValues: null }],
  };
}

/** Rehearsal only: send `data` to `to` from the multisig address via anvil impersonation. */
export async function impersonateSend(chain: ProdChain, from: Address, to: Address, data: Hex): Promise<Hex> {
  if (!chain.fork) throw new Error("--impersonate works only on an anvil fork");
  await chain.client.request({ method: "anvil_impersonateAccount" as never, params: [from] as never });
  await chain.client.request({ method: "anvil_setBalance" as never, params: [from, "0x56bc75e2d63100000"] as never });
  try {
    await chain.client.call({ account: from, to, data });
  } catch (err) {
    throw new Error(`impersonated call would revert: ${decodeRevert(err).message}`);
  }
  const gas = ((await chain.client.estimateGas({ account: from, to, data })) * BigInt(13)) / BigInt(10);
  const hash = (await chain.client.request({ method: "eth_sendTransaction" as never, params: [{ from, to, data, gas: `0x${gas.toString(16)}` }] as never })) as Hex;
  const r = await chain.client.waitForTransactionReceipt({ hash, pollingInterval: 250, timeout: 60_000 });
  await chain.client.request({ method: "anvil_stopImpersonatingAccount" as never, params: [from] as never });
  if (r.status !== "success") {
    // Rehearsal diagnostics: the revert reason from the node's call tracer.
    const trace = (await chain.client
      .request({ method: "debug_traceTransaction" as never, params: [hash, { tracer: "callTracer" }] as never })
      .catch(() => null)) as { output?: Hex; error?: string; revertReason?: string; calls?: Array<{ output?: Hex; error?: string }> } | null;
    const out = trace?.calls?.find((c) => c.error)?.output ?? trace?.output;
    const why = out && out.length >= 10 ? decodeRevert(Object.assign(new Error("revert"), { data: out })).message : (trace?.revertReason ?? trace?.error ?? "unknown");
    throw new Error(`impersonated tx ${hash} reverted (${why}; gas used ${r.gasUsed} of ${gas})`);
  }
  return hash;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = argv.find((a) => !a.startsWith("--") && ["prepare", "status", "seed", "feed-swap"].includes(a));
  if (args.network !== "mainnet" || !cmd) throw new Error("usage: npm run timelock -- --network mainnet <prepare|status|seed> --call \"fn(types)\" [--args a,b] …");
  loadMainnetEnv(args, { required: false });
  const chain = await connectMainnet(mainnetRpcUrl(args));
  const dep = await loadProdDeployment(chain);
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
  console.log(`timelock ${cmd} · ${chain.label} · ${rel(dep.file)} · timelock ${dep.timelock}`);

  if (cmd === "seed") return seedBatch(chain, dep, { insurance: Number(str("insurance") ?? 0), pool: Number(str("pool") ?? 0), out: str("out"), lanes: parseLanes(str("lanes")) });
  if (cmd === "feed-swap") {
    const sym = str("market");
    const feed = str("feed");
    const dev = Number(str("max-deviation-bps") ?? 500);
    if (!sym || !dep.markets[sym]) throw new Error(`--market must be one of ${Object.keys(dep.markets).join(", ")}`);
    if (!feed || !isHex(feed) || feed.length !== 66) throw new Error("--feed 0x<32-byte new Pyth feed id> required");
    if (!(dev > 0 && dev <= 5000)) throw new Error("--max-deviation-bps must be in 1..5000 (≤ 1000 while the old feed is live; up to 5000 once it is provably dead on chain, v4; 500 recommended)");
    if (dev > 1000) {
      console.log("  NOTE: > 1000 bps is accepted only if the OLD feed is provably dead on chain when the operation EXECUTES");
      console.log("        (Pyth has no stored price for it, or it is older than DEAD_FEED_AGE = 1 h; v4 MAX_DEAD_FEED_SWAP_DEVIATION_BPS = 5000).");
      console.log("        Anyone can refute a false \"dead\" during the 24 h delay by pushing the old feed: the execute then reverts FeedSwapDeviation.");
    }
    args.call = "replaceMarketFeed(bytes32,bytes32,uint256)";
    args.args = `${dep.markets[sym]},${feed},${dev}`;
    console.log(`  dead-feed swap for ${sym}: ${dep.feeds[sym] ?? "?"} → ${feed} (each lane with OI must be within ${dev / 100}% of its last price)`);
    console.log("  procedure (docs/RUNBOOK.md \"Dead feed\"):");
    console.log("    1. sign + execute the SCHEDULE file below with the multisig (24 h delay starts)");
    console.log(`    2. after the delay: start \`npm run pyth:push -- --network mainnet --feeds ${feed} --every 10 --yes-mainnet\` (nobody else pushes a new feed)`);
    console.log("    3. sign + execute the EXECUTE file while the pusher runs (the new feed's stored price must be ≤ 15 s old)");
    console.log("    4. the keeper sees MarketFeedReplaced and switches feeds live (alert gov:feed); stop the pusher");
  }
  if (cmd === "status" && str("id")) {
    const st = await opStatus(chain, dep.timelock!, str("id") as Hex);
    console.log(JSON.stringify({ id: str("id"), ...st, readyAtIso: st.readyAt > 1 ? new Date(st.readyAt * 1000).toISOString() : null }, null, 2));
    return;
  }
  const call = str("call");
  if (!call) throw new Error("--call \"fn(types)\" is required");
  const op = await prepareOp(chain, dep, { call, args: str("args"), target: str("target"), value: str("value"), salt: str("salt"), delay: str("delay") });
  const st = await opStatus(chain, dep.timelock!, op.id);
  console.log(`  operation   ${op.description}`);
  console.log(`  id          ${op.id}`);
  console.log(`  delay       ${op.delay} s · status ${st.done ? "DONE" : st.ready ? "READY to execute" : st.pending ? `scheduled, ready at ${new Date(st.readyAt * 1000).toISOString()}` : "not scheduled"}`);
  if (cmd === "status") return;

  const outDir = resolve(REPO_ROOT, str("out") ?? join("contracts", "cache", "timelock"));
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = join(outDir, `${chain.chainId}-${stamp}-${op.id.slice(2, 10)}`);
  writeFileSync(`${base}-1-schedule.json`, JSON.stringify(safeBatch(chain.chainId, `Paraclr timelock: schedule ${op.description}`, `delay ${op.delay}s, id ${op.id}`, dep.timelock!, op.scheduleData), null, 2));
  writeFileSync(`${base}-2-execute.json`, JSON.stringify(safeBatch(chain.chainId, `Paraclr timelock: execute ${op.description}`, `after the delay; id ${op.id}`, dep.timelock!, op.executeData), null, 2));
  console.log(`  Safe Transaction Builder files (sign with the multisig; import in the Safe app → Transaction Builder):`);
  console.log(`    1. ${rel(`${base}-1-schedule.json`)}   now`);
  console.log(`    2. ${rel(`${base}-2-execute.json`)}    after ${op.delay} s`);
  console.log(`  raw: to ${dep.timelock} · schedule data ${op.scheduleData.slice(0, 42)}… · execute data ${op.executeData.slice(0, 42)}…`);

  const imp = str("impersonate");
  if (imp) {
    const ms = envStr("OWNER_MULTISIG_ADDRESS");
    if (!ms || !isAddress(ms)) throw new Error("--impersonate needs OWNER_MULTISIG_ADDRESS");
    const hash = await impersonateSend(chain, getAddress(ms), dep.timelock!, imp === "execute" ? op.executeData : op.scheduleData);
    console.log(`  [fork] ${imp} sent as ${ms}: ${hash}`);
  }
}

/** Safe batch: approve + fundLane + backstopDeposit for every lane (treasury Safe signs it directly). */
function parseLanes(spec: string | undefined): number[] {
  if (!spec) return [0, 1, 2, 3, 4, 5, 6, 7];
  const out = new Set<number>();
  for (const part of spec.split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d)(?:-(\d))?$/.exec(part);
    if (!m) throw new Error(`--lanes: bad spec "${part}" (e.g. 7, 0-7, 1,3)`);
    for (let l = Number(m[1]); l <= Number(m[2] ?? m[1]); l++) if (l < 8) out.add(l);
  }
  return [...out].sort();
}

async function seedBatch(chain: ProdChain, dep: ProdDeployment, o: { insurance: number; pool: number; out?: string; lanes: number[] }): Promise<void> {
  if (!(o.insurance >= 0 && o.pool >= 0) || o.insurance + o.pool === 0) throw new Error("--insurance and/or --pool (whole AUSD per lane) required");
  const ins = BigInt(Math.round(o.insurance * 1e6));
  const pool = BigInt(Math.round(o.pool * 1e6));
  const total = (ins + pool) * BigInt(o.lanes.length); // approve covers every lane even if a pool deposit is skipped
  const erc20 = parseAbiItem("function approve(address spender, uint256 amount) returns (bool)") as AbiFunction;
  const fundLane = parseAbiItem("function fundLane(uint8 lane, uint256 amount)") as AbiFunction;
  const poolDep = parseAbiItem("function backstopDeposit(uint8 lane, uint256 amount, bytes[] priceUpdate) payable returns (uint256)") as AbiFunction;
  const txs: Array<{ to: Address; value: string; data: Hex; contractMethod: null; contractInputsValues: null }> = [];
  const push = (to: Address, data: Hex) => txs.push({ to, value: "0", data, contractMethod: null, contractInputsValues: null });
  push(dep.ausd, encodeFunctionData({ abi: [erc20], functionName: "approve", args: [dep.clearinghouse, total] }));
  // v4: pool deposits are refused while the pool is owed a receivable or its gain cap binds.
  const closed: string[] = [];
  const poolOpen = new Map<number, boolean>();
  if (pool > BigInt(0)) {
    const statusAbi = parseAbiItem("function backstopDepositStatus(uint8 lane) view returns (bool open, uint256 receivable, int256 unrealizedUncapped, uint256 insurance)") as AbiFunction;
    for (const lane of o.lanes) {
      const st = (await chain.client
        .readContract({ address: dep.clearinghouse, abi: [statusAbi], functionName: "backstopDepositStatus", args: [lane] })
        .catch(() => null)) as readonly [boolean, bigint, bigint, bigint] | null;
      const open = st === null ? true : st[0]; // pre-v4 contracts have no such view: deposits open
      poolOpen.set(lane, open);
      if (!open && st) {
        closed.push(`lane ${lane}: ${st[1] > BigInt(0) ? `the lane owes the pool ${Number(st[1]) / 1e6} AUSD (BackstopReceivableOutstanding)` : `pool gain ${Number(st[2]) / 1e6} > lane insurance ${Number(st[3]) / 1e6} (BackstopGainCapBinding)`}`);
      }
    }
  }
  for (const lane of o.lanes) {
    if (ins > BigInt(0)) push(dep.clearinghouse, encodeFunctionData({ abi: [fundLane], functionName: "fundLane", args: [lane, ins] }));
    // An empty pool needs no price update (the contract only ingests one when the pool holds positions).
    if (pool > BigInt(0) && poolOpen.get(lane) !== false) push(dep.clearinghouse, encodeFunctionData({ abi: [poolDep], functionName: "backstopDeposit", args: [lane, pool, []] }));
  }
  const outDir = resolve(REPO_ROOT, o.out ?? join("contracts", "cache", "timelock"));
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${chain.chainId}-${new Date().toISOString().replace(/[:.]/g, "-")}-seed-lanes-${o.lanes.join("")}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        version: "1.0",
        chainId: String(chain.chainId),
        createdAt: Date.now(),
        meta: { name: "Paraclr lane seeding / repair", description: `lanes ${o.lanes.join(",")}: insurance ${o.insurance} AUSD, backstop pool ${o.pool} AUSD each; total ${Number(total) / 1e6} AUSD`, txBuilderVersion: "1.16.5" },
        transactions: txs,
      },
      null,
      2,
    ),
  );
  if (closed.length) console.log(`  SKIPPED pool deposits (v4 refusals; retry when backstopDepositStatus(lane).open):\n    ${closed.join("\n    ")}`);
  console.log(`  ${txs.length} calls, ${Number(total) / 1e6} AUSD approved (pool deposits count toward each lane's TVL cap)`);
  console.log(`  Safe Transaction Builder file for the TREASURY Safe: ${rel(file)}`);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(`timelock failed: ${(err as Error)?.message ?? err}`);
    process.exit(1);
  });
}
