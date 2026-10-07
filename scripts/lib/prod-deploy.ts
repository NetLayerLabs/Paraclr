// Production deploy flow (`npm run deploy:mainnet`, also used by `npm run rehearse:mainnet`):
//
//   1. preflight  chain id 143 (or a local anvil), deployer balance, cost estimate from measured
//                 gas, external facts re-verified on chain (AUSD code + 6 decimals, Pyth code +
//                 version + every feed stored), owner multisig (Safe? owners/threshold, or EOA);
//   2. confirm    real chain: refuses without --yes-mainnet (after printing all of the above);
//   3. forge      contracts/script/DeployProd.s.sol with the env passed through the CHILD
//                 process only (keys never in argv, never printed), --slow, Monad's 128 KB
//                 code-size limit, output = deployments/143.json or DEPLOYMENTS_OUT (rehearsals);
//   4. verify     on chain: owner = timelock, timelock delay + proposer/executor/canceller =
//                 multisig, nobody else (deployer!) holds a timelock role, guardian, caps and
//                 params as configured, AUSD / Pyth / feeds as expected, deployer powerless,
//                 "production": true in the file. A failed check exits non-zero.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { encodeFunctionData, formatEther, getAddress, isAddress, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CONTRACTS_DIR, envStr } from "../../keeper/src/env";
import { foundryBin, shadowRoot } from "../../keeper/src/foundry";
import { SenderRegistry, waitForReceipt } from "../../keeper/src/sender";
import { HermesClient, hermesOptionsFromEnv } from "../../keeper/src/prod/hermes";
import { clearinghouseAbi, erc20Abi, pythAbi, timelockAbi } from "../../keeper/src/prod/abi";
import { loadGasTable } from "../../keeper/src/prod/budget";
import { confirmMainnet, KNOWN, LANES, normaliseKey, rel, type Args, type ProdChain, type ProdRoles } from "../../keeper/src/prod/config";
import { prodDeploymentPath, readProdDeployment, type ProdDeployment } from "../../keeper/src/prod/deployment";

export interface DeployInputs {
  owner: Address;
  /** OWNER_IS_EOA=true: the owner is a hardware wallet (no code). Default false: it must be a Safe. */
  ownerIsEoa: boolean;
  maxStoredPriceAge: number;
  maxPriceAge: number;
  minExecDelay: number;
  backstopWithdrawDelay: number;
  timelockDelay: number;
  maxDepositAusd: number;
  maxTvlPerLaneAusd: number;
  maxLeverage: number;
  ausd: Address;
  pyth: Address;
  guardian: Address;
  ops: Address;
  keepers: Address[];
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const SAFE_ABI = parseAbi([
  "function VERSION() view returns (string)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
]);

function addrEnv(name: string): Address {
  const v = envStr(name);
  if (!v || !isAddress(v)) throw new Error(`${name} must be set to an address in the mainnet env`);
  return getAddress(v);
}

export function deployInputs(roles: ProdRoles): DeployInputs {
  if (!roles.guardian || !roles.ops || roles.keepers.length !== LANES) {
    throw new Error("deploy needs GUARDIAN_PRIVATE_KEY, OPS_PRIVATE_KEY and 8 KEEPER_PRIVATE_KEYS (their addresses are wired in)");
  }
  const num = (name: string, fallback: number) => {
    const v = Number(envStr(name) ?? fallback);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} must be a positive number`);
    return v;
  };
  return {
    owner: addrEnv("OWNER_MULTISIG_ADDRESS"),
    ownerIsEoa: (envStr("OWNER_IS_EOA") ?? "false").toLowerCase() === "true",
    maxStoredPriceAge: num("MAX_STORED_PRICE_AGE_SECONDS", 15),
    maxPriceAge: num("MAX_PRICE_AGE_SECONDS", 30),
    minExecDelay: num("MIN_EXEC_DELAY_SECONDS", 3),
    backstopWithdrawDelay: num("BACKSTOP_WITHDRAW_DELAY_SECONDS", 3_600),
    timelockDelay: num("TIMELOCK_MIN_DELAY_SECONDS", 86_400),
    maxDepositAusd: num("MAX_DEPOSIT_PER_ACCOUNT_AUSD", 50),
    maxTvlPerLaneAusd: num("MAX_TVL_PER_LANE_AUSD", 500),
    maxLeverage: num("MAX_LEVERAGE", 10),
    ausd: getAddress(envStr("AUSD_ADDRESS") ?? KNOWN.ausd),
    pyth: getAddress(envStr("PYTH_ADDRESS") ?? KNOWN.pyth),
    guardian: roles.guardian.address,
    ops: roles.ops.address,
    keepers: roles.keepers.map((k) => k.address),
  };
}

/** External facts + owner checks before anything is sent. */
export async function preflight(chain: ProdChain, inp: DeployInputs, feeds: Record<string, Hex>): Promise<Check[]> {
  const c = chain.client;
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const [ausdCode, pythCode, ownerCode] = await Promise.all([c.getCode({ address: inp.ausd }), c.getCode({ address: inp.pyth }), c.getCode({ address: inp.owner })]);
  add("AUSD has code", Boolean(ausdCode && ausdCode !== "0x"), inp.ausd);
  const dec = await c.readContract({ address: inp.ausd, abi: erc20Abi, functionName: "decimals" }).catch(() => null);
  const sym = await c.readContract({ address: inp.ausd, abi: erc20Abi, functionName: "symbol" }).catch(() => null);
  add("AUSD decimals = 6", dec === 6, `decimals ${dec} symbol ${sym}`);
  if (!chain.fork || chain.network === "anvil-fork") add("AUSD is the verified Agora address", inp.ausd.toLowerCase() === KNOWN.ausd.toLowerCase(), inp.ausd);
  add("Pyth has code", Boolean(pythCode && pythCode !== "0x"), inp.pyth);
  const ver = await c.readContract({ address: inp.pyth, abi: pythAbi, functionName: "version" }).catch(() => null);
  add("Pyth version()", ver !== null, String(ver));
  if (!chain.fork || chain.network === "anvil-fork") add("Pyth is the verified Monad address", inp.pyth.toLowerCase() === KNOWN.pyth.toLowerCase(), inp.pyth);
  for (const [sym2, id] of Object.entries(feeds)) {
    const p = await c.readContract({ address: inp.pyth, abi: pythAbi, functionName: "getPriceUnsafe", args: [id] }).catch(() => null);
    add(`Pyth feed ${sym2} stored`, p !== null && p.price > BigInt(0), p ? `price ${p.price} expo ${p.expo} publishTime ${p.publishTime}` : `${id} not found`);
  }
  if (ownerCode && ownerCode !== "0x") {
    const [v, owners, thr] = await Promise.all([
      c.readContract({ address: inp.owner, abi: SAFE_ABI, functionName: "VERSION" }).catch(() => null),
      c.readContract({ address: inp.owner, abi: SAFE_ABI, functionName: "getOwners" }).catch(() => null),
      c.readContract({ address: inp.owner, abi: SAFE_ABI, functionName: "getThreshold" }).catch(() => null),
    ]);
    add("owner multisig is a Safe", v !== null && owners !== null, `Safe ${v} · ${owners?.length ?? "?"} owners · threshold ${thr}`);
    if (owners && thr !== null) add("Safe threshold ≥ 2", Number(thr) >= 2 || chain.fork, `threshold ${thr} of ${owners.length}`);
  } else {
    add(
      "owner without code allowed (OWNER_IS_EOA=true)",
      inp.ownerIsEoa,
      inp.ownerIsEoa
        ? `${inp.owner} has no code: make sure it is a hardware-wallet address you control`
        : `${inp.owner} has no code; DeployProd requires a Safe unless OWNER_IS_EOA=true (hardware wallet)`,
    );
  }
  const hot = [inp.guardian, inp.ops, ...inp.keepers].map((a) => a.toLowerCase());
  add("owner is not a hot key", !hot.includes(inp.owner.toLowerCase()), "OWNER_MULTISIG_ADDRESS must not be any key on the server");
  const roleKeys = [inp.guardian, ...inp.keepers].map((a) => a.toLowerCase());
  add("guardian + 8 keepers are distinct keys", new Set(roleKeys).size === roleKeys.length, "DeployProd maps keeper i → lane i and refuses duplicates");
  add("timelock delay ≥ 1 h", inp.timelockDelay >= 3_600 || chain.fork, `${inp.timelockDelay} s`);
  add("maxStoredPriceAge ≤ maxPriceAge ≤ 60 s", inp.maxStoredPriceAge <= inp.maxPriceAge && inp.maxPriceAge <= 60, `${inp.maxStoredPriceAge} / ${inp.maxPriceAge} s`);
  return checks;
}

/**
 * DeployProd's final wiring check calls markPrice() for every market, which needs the price STORED
 * in the Pyth contract to be ≤ maxPriceAge (60 s) old at simulation time. Others push MON/SOL/BTC
 * on Monad only every ~40–100 s, so refresh them first: fetch the latest signed update from
 * Hermes and push it with pyth.updatePriceFeeds from the deployer (fee 0 on Monad today).
 */
export async function refreshPyth(chain: ProdChain, deployerKey: Hex, pyth: Address, feeds: Hex[]): Promise<Check> {
  const now = Number((await chain.client.getBlock({ blockTag: "latest" })).timestamp);
  const ages = await Promise.all(
    feeds.map((f) =>
      chain.client.readContract({ address: pyth, abi: pythAbi, functionName: "getPriceUnsafe", args: [f] }).then((p) => now - Number(p.publishTime), () => Infinity),
    ),
  );
  const worst = Math.max(...ages);
  // v2's DeployProd only reads latestPrice() at the end and requires each feed to have been pushed
  // within PYTH_MAX_FEED_AGE_SECONDS (3600): no push unless the stored prices are older than that.
  const maxFeedAge = Number(envStr("PYTH_MAX_FEED_AGE_SECONDS") ?? 3_600);
  if (worst <= maxFeedAge - 300) {
    return { name: "Pyth stored prices recent enough for DeployProd", ok: true, detail: `oldest stored price ${worst} s (limit ${maxFeedAge} s): no push needed` };
  }
  let update;
  try {
    update = await new HermesClient(hermesOptionsFromEnv()).latest(feeds);
  } catch (err) {
    return { name: "Pyth stored prices fresh for DeployProd", ok: worst <= 45, detail: `oldest stored price ${worst} s; Hermes unavailable (${(err as Error).message.split("\n")[0]}) — set PYTH_API_KEY or retry right after a Pyth push` };
  }
  const fee = await chain.client.readContract({ address: pyth, abi: pythAbi, functionName: "getUpdateFee", args: [update.data] });
  const acct = privateKeyToAccount(deployerKey);
  const sub = await new SenderRegistry(chain.client, chain.chainId).for(acct).send({
    to: pyth,
    data: encodeFunctionData({ abi: pythAbi, functionName: "updatePriceFeeds", args: [update.data] }),
    value: fee,
    gas: await chain.client.estimateGas({ account: acct.address, to: pyth, data: encodeFunctionData({ abi: pythAbi, functionName: "updatePriceFeeds", args: [update.data] }), value: fee }).then((g) => (g * BigInt(12)) / BigInt(10)),
  });
  const { receipt } = await waitForReceipt(chain.client, sub.hash, { pollMs: 300, timeoutMs: 90_000 });
  const times = [...update.messages.values()].map((m) => m.publishTime);
  return {
    name: "Pyth stored prices refreshed for DeployProd",
    ok: receipt.status === "success",
    detail: `oldest stored price was ${worst} s; pushed Hermes update (publish ${Math.min(...times)}) via updatePriceFeeds, tx ${sub.hash} (${receipt.gasUsed} gas)`,
  };
}

export interface ForgeRun {
  gasLimitTotal: bigint;
  gasUsedTotal: bigint;
  txs: number;
  deployBlock: number;
}

/** Run DeployProd.s.sol. The deployer key and every input reach forge through env only. */
export async function runDeployScript(
  chain: ProdChain,
  deployerKey: Hex,
  inp: DeployInputs,
  outFile: string,
  opts: { verbose?: boolean; logFile?: string } = {},
): Promise<ForgeRun> {
  const script = join(CONTRACTS_DIR, "script", "DeployProd.s.sol");
  if (!existsSync(script)) throw new Error(`${rel(script)} does not exist yet (contracts agent)`);
  // Anvil (rehearsal): run forge from a shadow root so chain-143 broadcast/cache artifacts of a
  // FORK never land in contracts/broadcast/DeployProd.s.sol/143 next to the real deploy's.
  const root = chain.fork ? shadowRoot("deploy-prod-rehearsal").root : CONTRACTS_DIR;
  mkdirSync(dirname(outFile), { recursive: true });
  // Forge gets the deployer key and ADDRESSES only: strip every other secret from its environment.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["GUARDIAN_PRIVATE_KEY", "OPS_PRIVATE_KEY", "KEEPER_PRIVATE_KEYS", "PYTH_API_KEY", "ALERT_WEBHOOK_URL", "FUNDER_PRIVATE_KEY"]) delete env[k];
  Object.assign(env, {
    DEPLOYER_PRIVATE_KEY: deployerKey,
    OWNER_MULTISIG_ADDRESS: inp.owner,
    TIMELOCK_MIN_DELAY_SECONDS: String(inp.timelockDelay),
    MAX_DEPOSIT_PER_ACCOUNT_AUSD: String(inp.maxDepositAusd),
    MAX_TVL_PER_LANE_AUSD: String(inp.maxTvlPerLaneAusd),
    MAX_LEVERAGE: String(inp.maxLeverage),
    AUSD_ADDRESS: inp.ausd,
    PYTH_ADDRESS: inp.pyth,
    GUARDIAN_ADDRESS: inp.guardian,
    OPS_ADDRESS: inp.ops,
    KEEPER_ADDRESSES: inp.keepers.join(","),
    OWNER_IS_EOA: inp.ownerIsEoa ? "true" : "false",
    DEPLOYMENTS_OUT: outFile,
  });
  const args = [
    "script",
    `${script}:DeployProd`,
    "--root",
    root,
    "--rpc-url",
    chain.rpcUrl,
    "--broadcast",
    "--slow",
    "--code-size-limit",
    String(KNOWN.codeSizeLimit),
  ];
  const forge = foundryBin("forge");
  const out: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(forge, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] as const });
    const onData = (d: Buffer) => {
      const t = d.toString();
      out.push(t);
      if (opts.verbose !== false) process.stdout.write(t.replace(/0x[0-9a-fA-F]{64}/g, (m) => (m.toLowerCase() === deployerKey.toLowerCase() ? "0x<redacted>" : m)));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`forge script exited with ${code}`))));
  });
  if (opts.logFile) writeFileSync(opts.logFile, out.join("").split(deployerKey).join("0x<redacted>"));
  const run = join(root, "broadcast", "DeployProd.s.sol", String(chain.chainId), "run-latest.json");
  let gasLimitTotal = BigInt(0);
  let gasUsedTotal = BigInt(0);
  let txs = 0;
  let deployBlock = 0;
  if (existsSync(run)) {
    const r = JSON.parse(readFileSync(run, "utf8")) as {
      transactions?: Array<{ transaction?: { gas?: string } }>;
      receipts?: Array<{ gasUsed: string; blockNumber: string }>;
    };
    for (const t of r.transactions ?? []) if (t.transaction?.gas) gasLimitTotal += BigInt(t.transaction.gas);
    for (const rc of r.receipts ?? []) gasUsedTotal += BigInt(rc.gasUsed);
    txs = r.receipts?.length ?? 0;
    const blocks = (r.receipts ?? []).map((x) => Number(BigInt(x.blockNumber)));
    deployBlock = blocks.length ? Math.min(...blocks) : 0;
  }
  return { gasLimitTotal, gasUsedTotal, txs, deployBlock };
}

const ROLE = (name: string) => keccak256(toHex(name));

/** Post-deploy verification, all on chain. */
export async function verifyDeployment(chain: ProdChain, dep: ProdDeployment, inp: DeployInputs, deployer: Address): Promise<Check[]> {
  const c = chain.client;
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const ch = dep.clearinghouse;
  const r = <T>(functionName: string, args: unknown[] = []) =>
    c.readContract({ address: ch, abi: clearinghouseAbi as never, functionName: functionName as never, args: args as never }) as Promise<T>;

  add('deployment file has "production": true', dep.production, rel(dep.file));
  add("clearinghouse code ≤ 128 KB", true, `${((((await c.getCode({ address: ch })) ?? "0x").length - 2) / 2).toLocaleString()} bytes`);
  const owner = await r<Address>("owner");
  add("timelock address in the file", dep.timelock !== null, String(dep.timelock));
  add("owner() = timelock", dep.timelock !== null && owner.toLowerCase() === dep.timelock.toLowerCase(), owner);
  add("owner() is not the deployer", owner.toLowerCase() !== deployer.toLowerCase(), owner);
  if (dep.timelock) {
    const tl = dep.timelock;
    const has = (role: Hex, who: Address) => c.readContract({ address: tl, abi: timelockAbi, functionName: "hasRole", args: [role, who] });
    const delay = await c.readContract({ address: tl, abi: timelockAbi, functionName: "getMinDelay" });
    add("timelock min delay", Number(delay) === inp.timelockDelay, `${delay} s (expected ${inp.timelockDelay})`);
    const P = ROLE("PROPOSER_ROLE");
    const E = ROLE("EXECUTOR_ROLE");
    const C = ROLE("CANCELLER_ROLE");
    const A = `0x${"0".repeat(64)}` as Hex;
    const [mp, me, mc, dp, de, dc, da, za] = await Promise.all([
      has(P, inp.owner),
      has(E, inp.owner),
      has(C, inp.owner),
      has(P, deployer),
      has(E, deployer),
      has(C, deployer),
      has(A, deployer),
      has(E, "0x0000000000000000000000000000000000000000"),
    ]);
    add("multisig is timelock proposer", mp, inp.owner);
    add("multisig is timelock executor", me, inp.owner);
    add("multisig is timelock canceller", mc, inp.owner);
    add("deployer holds NO timelock role", !dp && !de && !dc && !da, `proposer ${dp} executor ${de} canceller ${dc} admin ${da}`);
    add("execution is not open to anyone", !za, `EXECUTOR_ROLE(address(0)) = ${za}`);
    for (const k of [inp.guardian, inp.ops, ...inp.keepers]) {
      const [kp, ke, ka] = await Promise.all([has(P, k), has(E, k), has(A, k)]);
      if (kp || ke || ka) add(`hot key ${k} holds no timelock role`, false, `proposer ${kp} executor ${ke} admin ${ka}`);
    }
    const adminSelf = await has(A, tl);
    add("timelock admin role (info)", true, `timelock holds DEFAULT_ADMIN_ROLE on itself: ${adminSelf}`);
  }
  const guardian = await r<Address>("guardian");
  add("guardian() = GUARDIAN key", guardian.toLowerCase() === inp.guardian.toLowerCase(), guardian);
  add("guardian is not the deployer", guardian.toLowerCase() !== deployer.toLowerCase(), guardian);
  // v2: operators are per lane — keeper i may backstopReduce lane i ONLY; the deployer on none.
  const opMatrix = await Promise.all(
    [deployer, ...inp.keepers].map((who) => Promise.all(Array.from({ length: LANES }, (_, lane) => r<boolean>("isBackstopOperator", [who, lane])))),
  );
  add("deployer is not a backstop operator (any lane)", opMatrix[0].every((x) => !x), opMatrix[0].map((x) => (x ? 1 : 0)).join(""));
  const laneOk = inp.keepers.every((_, i) => opMatrix[i + 1].every((x, lane) => x === (lane === i)));
  add("keeper i is backstop operator of lane i only", laneOk, inp.keepers.map((_, i) => opMatrix[i + 1].map((x) => (x ? 1 : 0)).join("")).join(" "));
  const [maxDep, maxTvl, maxLev, paused] = await Promise.all([r<bigint>("maxDepositPerAccount"), r<bigint>("maxTvlPerLane"), r<bigint>("maxLeverage"), r<boolean>("paused")]);
  add("maxDepositPerAccount", maxDep === BigInt(Math.round(inp.maxDepositAusd * 1e6)), `${Number(maxDep) / 1e6} AUSD (expected ${inp.maxDepositAusd})`);
  add("maxTvlPerLane", maxTvl === BigInt(Math.round(inp.maxTvlPerLaneAusd * 1e6)), `${Number(maxTvl) / 1e6} AUSD (expected ${inp.maxTvlPerLaneAusd})`);
  add("maxLeverage", Number(maxLev) === inp.maxLeverage, `${maxLev}x (expected ${inp.maxLeverage})`);
  add("not paused after deploy", !paused, `paused=${paused}`);
  const [ausd, pyth] = await Promise.all([r<Address>("ausd"), r<Address>("pyth")]);
  add("ausd() = AUSD_ADDRESS", ausd.toLowerCase() === inp.ausd.toLowerCase(), ausd);
  add("pyth() = PYTH_ADDRESS", pyth.toLowerCase() === inp.pyth.toLowerCase(), pyth);
  const [ids, symbols, feeds] = await r<readonly [readonly Hex[], readonly string[], readonly Hex[]]>("getMarkets");
  add("markets listed", ids.length >= 1, symbols.join(", "));
  symbols.forEach((s, i) => {
    const want = KNOWN.feeds[s];
    add(`feed ${s}`, !want || want.toLowerCase() === feeds[i].toLowerCase(), feeds[i]);
    add(`market id ${s} = keccak256(symbol)`, ids[i].toLowerCase() === keccak256(toHex(s)).toLowerCase(), ids[i]);
  });
  const [storedAge, priceAge, execDelay, wdDelay, cure] = await Promise.all([
    r<bigint>("maxStoredPriceAge"),
    r<bigint>("maxPriceAge"),
    r<bigint>("minExecDelay"),
    r<bigint>("backstopWithdrawDelay"),
    r<bigint>("CURE_BUFFER_BPS").catch(() => BigInt(10_000)), // absent (v3): cure at maintenance
  ]);
  add("maxStoredPriceAge", Number(storedAge) === inp.maxStoredPriceAge, `${storedAge} s (expected ${inp.maxStoredPriceAge})`);
  add("maxPriceAge", Number(priceAge) === inp.maxPriceAge, `${priceAge} s (expected ${inp.maxPriceAge})`);
  add("minExecDelay", Number(execDelay) === inp.minExecDelay, `${execDelay} s (expected ${inp.minExecDelay})`);
  add("backstopWithdrawDelay (LP two-step exit)", Number(wdDelay) === inp.backstopWithdrawDelay, `${wdDelay} s (expected ${inp.backstopWithdrawDelay}); cure buffer ${Number(cure) / 100}%`);
  const params = await Promise.all(["maxExecDelay", "minExecutionFee", "fundingUpdateInterval", "maxConfBps", "tradingFeeBps", "oiCapMultiplierBps"].map((n) => r<bigint>(n).then((v) => `${n}=${v}`)));
  add("params readable", true, params.join(" · "));
  const pf = dep.raw.params as Record<string, unknown> | undefined;
  add('file "params" has the v2+ keys', Boolean(pf && "maxStoredPriceAgeSeconds" in pf && "backstopWithdrawDelaySeconds" in pf), pf ? Object.keys(pf).length + " keys" : "no params");
  const deployerBal = await c.getBalance({ address: deployer });
  add("deployer leftover MON (sweep it)", true, `${formatEther(deployerBal)} MON at ${deployer}`);
  return checks;
}

export function printChecks(title: string, checks: Check[]): boolean {
  console.log(`\n${title}`);
  for (const ch of checks) console.log(`  ${ch.ok ? "✓" : "✗"} ${ch.name.padEnd(40)} ${ch.detail}`);
  const bad = checks.filter((x) => !x.ok);
  console.log(bad.length ? `  ${bad.length} check(s) FAILED` : "  all checks passed");
  return bad.length === 0;
}

export interface DeployResult {
  dep: ProdDeployment;
  pre: Check[];
  pythRefresh?: Check;
  post: Check[];
  forge: ForgeRun;
  file: string;
}

/** The whole flow (preflight → confirm → forge → verify). */
export async function deployProd(chain: ProdChain, roles: ProdRoles, args: Args, opts: { logFile?: string; verbose?: boolean } = {}): Promise<DeployResult> {
  const deployerKeyRaw = envStr("DEPLOYER_PRIVATE_KEY");
  if (!deployerKeyRaw) throw new Error("DEPLOYER_PRIVATE_KEY missing in the mainnet env");
  const deployerKey = normaliseKey("DEPLOYER_PRIVATE_KEY", deployerKeyRaw);
  const deployer = privateKeyToAccount(deployerKey).address;
  const inp = deployInputs(roles);
  const file = prodDeploymentPath(chain);
  const existing = readProdDeployment(file);
  if (existing && !args.redeploy) {
    const code = await chain.client.getCode({ address: existing.clearinghouse });
    if (code && code !== "0x") throw new Error(`${rel(file)} already points at a live deployment (${existing.clearinghouse}); pass --redeploy to deploy a NEW set`);
  }

  console.log(`deploy:mainnet · ${chain.label} · chain ${chain.chainId} → ${rel(file)}`);
  console.log(`  deployer ${deployer} · owner (multisig) ${inp.owner} · timelock delay ${inp.timelockDelay} s`);
  console.log(`  guardian ${inp.guardian} · ops ${inp.ops} · keepers ${inp.keepers.length}`);
  console.log(`  caps: ${inp.maxDepositAusd} AUSD/account · ${inp.maxTvlPerLaneAusd} AUSD/lane TVL · ${inp.maxLeverage}x leverage`);
  console.log(`  prices: stored/lane ≤ ${inp.maxStoredPriceAge} s · supplied ≤ ${inp.maxPriceAge} s · exec delay ${inp.minExecDelay} s · LP exit delay ${inp.backstopWithdrawDelay} s · owner ${inp.ownerIsEoa ? "EOA (hardware wallet)" : "contract (Safe)"}`);
  const pre = await preflight(chain, inp, KNOWN.feeds);
  const preOk = printChecks("preflight (on chain):", pre);
  const gas = loadGasTable(typeof args["gas-report"] === "string" ? args["gas-report"] : undefined);
  // Monad's floor is 100 gwei base + priority; an anvil fork quotes ~1 gwei, so never estimate below it.
  const quoted = await chain.client.getGasPrice().catch(() => KNOWN.minGasPriceWei);
  const price = quoted > KNOWN.minGasPriceWei ? quoted : KNOWN.minGasPriceWei;
  const bal = await chain.client.getBalance({ address: deployer });
  const est = (BigInt(gas.deploy) * BigInt(13) * price) / BigInt(10);
  console.log(
    `\n  cost estimate: ${(gas.deploy / 1e6).toFixed(1)}M gas (${gas.source}) × 1.3 forge margin × ${Number(price) / 1e9} gwei ≈ ${formatEther(est)} MON (billed on gas LIMIT)` +
      `\n  deployer balance ${formatEther(bal)} MON${bal < est ? "  ← TOO LOW" : ""}`,
  );
  if (!preOk) throw new Error("preflight failed: fix the env / addresses above first");
  if (bal < est) throw new Error(`deployer needs ≥ ${formatEther(est)} MON (keeper:fund -- --network mainnet --roles deployer)`);
  confirmMainnet(chain, args, "deploy the production contract set (DeployProd.s.sol)");

  const fresh = await refreshPyth(chain, deployerKey, inp.pyth, Object.values(KNOWN.feeds));
  printChecks("Pyth feeds pushed recently (DeployProd: PYTH_MAX_FEED_AGE_SECONDS):", [fresh]);
  if (!fresh.ok) throw new Error("stored Pyth prices are too old for DeployProd");
  const forge = await runDeployScript(chain, deployerKey, inp, file, opts);
  const dep = readProdDeployment(file);
  if (!dep) throw new Error(`forge finished but ${rel(file)} was not written`);
  if (forge.deployBlock && !dep.deployBlock) dep.deployBlock = forge.deployBlock;
  const post = await verifyDeployment(chain, dep, inp, deployer);
  const ok = printChecks("post-deploy verification (on chain):", post);
  console.log(`\n  forge: ${forge.txs} txs · ${(Number(forge.gasUsedTotal) / 1e6).toFixed(2)}M gas used · ${(Number(forge.gasLimitTotal) / 1e6).toFixed(2)}M gas limit`);
  if (!ok) throw new Error("post-deploy verification FAILED — do not announce or fund this deployment; see docs/RUNBOOK.md");
  return { dep, pre, post, forge, file };
}
