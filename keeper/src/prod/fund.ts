// `npm run keeper:fund -- --network mainnet|testnet` — preview (always) and top up (with --send) the
// production hot keys from a funder key YOU choose. Testnet: --yes-testnet, testnet MON, and the
// budget defaults to ~3 weeks of light demo use (budget.ts).
//
//   (no flags)                    preview: every role's balance vs its target from MEASURED gas
//                                 (budget.ts) and the total that would be sent
//   --send --yes-mainnet          send the shortfalls from the funder
//   --funder deployer             funder = DEPLOYER_PRIVATE_KEY from the env file (default), or
//   --funder-env NAME             funder = the private key in environment variable NAME, e.g.
//                                 `FUNDER_PRIVATE_KEY=0x… npm run keeper:fund -- --network mainnet --funder-env FUNDER_PRIVATE_KEY …`
//                                 (keeps a big wallet's key out of every file)
//   --roles ops,keepers,guardian  only these roles (default: guardian, ops, keepers; the deployer
//                                 is the usual funder, add `deployer` to top it up too)
//   --days N                      budget horizon (default FUND_DAYS or 14)
//   --gas-report PATH             use gas measured by a newer rehearsal report
//   --sweep-retired FILE --to 0x… move all MON from keys retired by `keeper:init --rotate` to an address
//
// Per-role overrides (MON): FUND_DEPLOYER_MON, FUND_GUARDIAN_MON, FUND_OPS_MON, FUND_KEEPER_MON.
// Monad reserve balance: a value transfer may not take its sender below min(balance, 10 MON)
// unless it is the sender's first tx in 3 blocks, so transfers wait 3 blocks between each other.

import { existsSync, readFileSync } from "node:fs";
import { formatEther, getAddress, isAddress, parseAbi, parseEther, type Address, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { envStr } from "../env";
import { SenderRegistry, waitForReceipt } from "../sender";
import { clearinghouseAbi } from "./abi";
import { activityFromEnv, computeBudget, loadGasTable, printAssumptions } from "./budget";
import {
  confirmMainnet,
  connectMainnet,
  KNOWN,
  loadMainnetEnv,
  loadProdRoles,
  mainnetRpcUrl,
  normaliseKey,
  type Args,
  type ProdChain,
} from "./config";
import { prodDeploymentPath, readProdDeployment } from "./deployment";

const OVERRIDE: Record<string, string> = {
  deployer: "FUND_DEPLOYER_MON",
  guardian: "FUND_GUARDIAN_MON",
  ops: "FUND_OPS_MON",
  keeper: "FUND_KEEPER_MON",
};

export async function fundMainnet(args: Args): Promise<void> {
  loadMainnetEnv(args);
  if (typeof args.days === "string") process.env.FUND_DAYS = args.days;
  const chain = await connectMainnet(mainnetRpcUrl(args));
  const unit = chain.profile.realValue ? "MON" : "testnet MON";
  console.log(`keeper:fund · ${chain.label} · chain ${chain.chainId}${chain.profile.realValue ? "" : " · TESTNET (no real value)"}`);
  if (typeof args["sweep-retired"] === "string") return sweepRetired(chain, args);

  const roles = loadProdRoles(["ops", "keepers"]);
  const wanted = parseRoles(args.roles);
  const gasPrice = await chain.client.getGasPrice().catch(() => KNOWN.minGasPriceWei);
  const pythFee = await pythUpdateFee(chain);
  const gas = loadGasTable(typeof args["gas-report"] === "string" ? args["gas-report"] : undefined);
  const act = activityFromEnv(gasPrice > KNOWN.minGasPriceWei ? gasPrice : KNOWN.minGasPriceWei, pythFee, await fundingInterval(chain));
  printAssumptions(gas, act);
  const plan = computeBudget(gas, act);

  const rows: Array<{ role: string; address: Address; target: bigint; why: string }> = [];
  for (const r of plan.rows) {
    const base = r.role.startsWith("keeper[") ? "keeper" : r.role;
    if (!wanted.has(base === "keeper" ? "keepers" : base)) continue;
    const acct =
      base === "keeper" ? roles.keepers[Number(r.role.slice(7, -1))] : base === "deployer" ? roles.deployer : base === "guardian" ? roles.guardian : roles.ops;
    if (!acct) {
      console.log(`  ${r.role.padEnd(11)} (no key in the env file — skipped)`);
      continue;
    }
    const ov = envStr(OVERRIDE[base]);
    rows.push({ role: r.role, address: acct.address, target: ov ? parseEther(ov) : r.target, why: ov ? `${OVERRIDE[base]}=${ov}` : r.why });
  }

  const bals = await Promise.all(rows.map((r) => chain.client.getBalance({ address: r.address })));
  let need = BigInt(0);
  const todo: Array<{ role: string; address: Address; amount: bigint }> = [];
  console.log("");
  console.log("  role        address                                       balance        target         to send");
  rows.forEach((r, i) => {
    const short = bals[i] < r.target ? r.target - bals[i] : BigInt(0);
    need += short;
    if (short > BigInt(0)) todo.push({ role: r.role, address: r.address, amount: short });
    console.log(
      `  ${r.role.padEnd(11)} ${r.address}  ${fmt(bals[i])}  ${fmt(r.target)}  ${short > BigInt(0) ? fmt(short) : "          ok"}`,
    );
  });
  console.log("");
  for (const r of rows.filter((x, i) => i === 0 || !x.role.startsWith("keeper[") || x.role === "keeper[0]")) {
    console.log(`  ${r.role.startsWith("keeper[") ? "keepers" : r.role}: ${r.why}`);
  }
  const fees = BigInt(todo.length) * BigInt(21_000) * act.gasPriceWei;
  console.log(
    `\n  total to send: ${formatEther(need)} ${unit} in ${todo.length} transfer(s) + ≈${formatEther(fees)} ${unit} gas` +
      `\n  expected spend over ${act.days} days: ${Number(formatEther(plan.periodGross)).toFixed(2)} MON gross ` +
      `(≈ ${Number(formatEther(plan.perDayTotal)).toFixed(2)} MON/day + deploy); ` +
      (plan.periodNet < BigInt(0)
        ? `users' execution fees (${Number(formatEther(plan.periodGross - plan.periodNet)).toFixed(2)} MON at the minimum fee) more than cover it (+${Number(formatEther(-plan.periodNet)).toFixed(2)} MON)`
        : `${Number(formatEther(plan.periodNet)).toFixed(2)} MON net of users' execution fees`),
  );

  if (!args.send) {
    console.log(`\npreview only. To send: add --send --${chain.profile.yesFlag} (and --funder deployer | --funder-env NAME).`);
    return;
  }
  if (todo.length === 0) {
    console.log("nothing to send.");
    return;
  }
  const funder = pickFunder(args, roles.deployer);
  const funderBal = await chain.client.getBalance({ address: funder.address });
  console.log(`\nfunder ${funder.address}: ${formatEther(funderBal)} MON`);
  if (funderBal < need + fees) throw new Error(`funder has ${formatEther(funderBal)} MON, needs ${formatEther(need + fees)}`);
  if (todo.some((t) => t.address.toLowerCase() === funder.address.toLowerCase())) {
    throw new Error("the funder is also a recipient; pick another --funder or drop that role with --roles");
  }
  confirmMainnet(chain, args, `send ${formatEther(need)} MON to ${todo.length} hot key(s)`);

  const sender = new SenderRegistry(chain.client, chain.chainId).for(funder);
  for (const t of todo) {
    const sub = await sender.send({ to: t.address, value: t.amount, gas: BigInt(21_000) });
    const { receipt } = await waitForReceipt(chain.client, sub.hash, { pollMs: 300, timeoutMs: 90_000 });
    console.log(`  ${t.role.padEnd(11)} +${formatEther(t.amount)} MON  ${sub.hash}  ${receipt.status}`);
    if (receipt.status !== "success") throw new Error(`transfer to ${t.role} reverted (Monad reserve balance?)`);
    await waitBlocks(chain, receipt.blockNumber, 3);
  }
  console.log("done. Re-run without --send to see the new balances.");
}

function parseRoles(v: string | true | undefined): Set<string> {
  if (typeof v !== "string") return new Set(["guardian", "ops", "keepers"]);
  const out = new Set(v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  for (const r of out) if (!["deployer", "guardian", "ops", "keepers"].includes(r)) throw new Error(`--roles: unknown role ${r}`);
  return out;
}

function pickFunder(args: Args, deployer: LocalAccount | null): LocalAccount {
  if (typeof args["funder-env"] === "string") {
    const name = args["funder-env"];
    const v = process.env[name];
    if (!v) throw new Error(`--funder-env ${name}: that environment variable is empty`);
    return privateKeyToAccount(normaliseKey(name, v));
  }
  const which = typeof args.funder === "string" ? args.funder : "deployer";
  if (which !== "deployer") throw new Error("--funder must be `deployer` (or use --funder-env NAME)");
  if (!deployer) throw new Error("no DEPLOYER_PRIVATE_KEY in the env file; use --funder-env NAME");
  return deployer;
}

/** Pyth's fee per update message (`singleUpdateFeeInWei`: 0 on mainnet, 1 wei on testnet, 2026-10-07). */
async function pythUpdateFee(chain: ProdChain): Promise<bigint> {
  const address = (envStr("PYTH_ADDRESS") ?? chain.profile.pyth) as Address;
  try {
    return await chain.client.readContract({ address, abi: parseAbi(["function singleUpdateFeeInWei() view returns (uint256)"]), functionName: "singleUpdateFeeInWei" });
  } catch {
    try {
      return await chain.client.readContract({ address, abi: parseAbi(["function getUpdateFee(bytes[] updateData) view returns (uint256)"]), functionName: "getUpdateFee", args: [["0x"]] });
    } catch {
      return BigInt(0);
    }
  }
}

/** fundingUpdateInterval() of the deployed set, if there is one (else the budget's default). */
async function fundingInterval(chain: ProdChain): Promise<number | undefined> {
  try {
    const dep = readProdDeployment(prodDeploymentPath(chain));
    if (!dep) return undefined;
    return Number(await chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName: "fundingUpdateInterval" }));
  } catch {
    return undefined;
  }
}

async function waitBlocks(chain: ProdChain, from: bigint, n: number): Promise<void> {
  while ((await chain.client.getBlockNumber()) < from + BigInt(n)) await new Promise((r) => setTimeout(r, 300));
}

function fmt(v: bigint): string {
  return `${Number(formatEther(v)).toFixed(4).padStart(12)} `;
}

/** Move all MON from keys listed in a `.retired-*` file to `--to`. */
async function sweepRetired(chain: ProdChain, args: Args): Promise<void> {
  const file = args["sweep-retired"] as string;
  if (!existsSync(file)) throw new Error(`${file} not found`);
  if (typeof args.to !== "string" || !isAddress(args.to)) throw new Error("--sweep-retired needs --to 0x… (where the MON goes)");
  const to = getAddress(args.to);
  const keys = [...readFileSync(file, "utf8").matchAll(/0x[0-9a-fA-F]{64}/g)].map((m) => normaliseKey("retired key", m[0]));
  const fees = await chain.client.estimateFeesPerGas();
  const cost = BigInt(21_000) * fees.maxFeePerGas;
  const plan = await Promise.all(
    keys.map(async (k) => {
      const a = privateKeyToAccount(k);
      const bal = await chain.client.getBalance({ address: a.address });
      return { a, bal, amount: bal > cost ? bal - cost : BigInt(0) };
    }),
  );
  for (const p of plan) console.log(`  ${p.a.address}  ${formatEther(p.bal)} MON → ${formatEther(p.amount)} to ${to}`);
  const todo = plan.filter((p) => p.amount > BigInt(0));
  if (!args.send) {
    console.log(`preview only. Add --send --${chain.profile.yesFlag} to sweep.`);
    return;
  }
  confirmMainnet(chain, args, `sweep ${todo.length} retired key(s) to ${to}`);
  const reg = new SenderRegistry(chain.client, chain.chainId);
  for (const p of todo) {
    const sub = await reg.for(p.a).send({ to, value: p.amount, gas: BigInt(21_000) });
    const { receipt } = await waitForReceipt(chain.client, sub.hash, { pollMs: 300, timeoutMs: 90_000 });
    console.log(`  ${p.a.address} → ${to}  ${formatEther(p.amount)} MON  ${sub.hash}  ${receipt.status}`);
  }
}
