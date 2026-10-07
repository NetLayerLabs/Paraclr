// `npm run keeper:fund` — show every role's balance vs. its target; with `--send`, top them up
// from the operator key. Works before or after deploying (needs only KEEPER_RPC_URL + keys).
//
// Monad reserve-balance rule: a value transfer may not take the sender below
// min(its starting balance, 10 MON) unless it is the sender's first tx in 3 blocks. On Monad this
// script therefore waits 3 blocks after each transfer, so every transfer qualifies.
//
// `--network mainnet` → keeper/src/prod/fund.ts (production hot keys, keeper/.env.mainnet, budget
// from measured gas, explicit funder, --yes-mainnet). Everything below is the testnet/anvil flow.
//
// Targets (MON, override in keeper/.env): FUND_PUSHER_MON (5), FUND_FAUCET_MON (12), FUND_KEEPER_MON (2: one
// crash run v2 on both designs costs the busiest lane keeper ≈1.1 MON, see keeper/README.md).

import { formatEther, parseEther, type Address } from "viem";
import { envStr, loadKeeperEnv, parseArgs, rpcHost } from "./env";
import { chainFor, defaultRpcUrl, detectChain, loadRoles, makeClient } from "./network";
import { fundMainnet } from "./prod/fund";
import { SenderRegistry, waitForReceipt } from "./sender";

function target(name: string, fallback: string): bigint {
  return parseEther(envStr(name) ?? fallback);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.network === "mainnet") return fundMainnet(args);
  loadKeeperEnv();
  const rpcUrl = typeof args.rpc === "string" ? args.rpc : defaultRpcUrl();
  const info = await detectChain(rpcUrl);
  const client = makeClient(rpcUrl, chainFor(info, rpcUrl));
  const roles = loadRoles(info.network);
  const unit = info.network === "anvil" ? "ETH" : "MON";

  const wanted: Array<{ role: string; address: Address; target: bigint }> = [
    { role: "pricePusher", address: roles.pricePusher.address, target: target("FUND_PUSHER_MON", "5") },
    { role: "faucet", address: roles.faucet.address, target: target("FUND_FAUCET_MON", "12") },
    ...roles.keepers.map((k, i) => ({ role: `keeper[${i}]`, address: k.address, target: target("FUND_KEEPER_MON", "2") })),
  ];
  const opBal = await client.getBalance({ address: roles.operator.address });
  console.log(`${info.network} (chain ${info.chainId}) via ${rpcHost(rpcUrl)}`);
  console.log(`operator     ${roles.operator.address}  ${formatEther(opBal)} ${unit}  (funds everyone below)`);
  let need = BigInt(0);
  const todo: Array<{ role: string; address: Address; amount: bigint }> = [];
  for (const w of wanted) {
    const bal = await client.getBalance({ address: w.address });
    const short = bal < w.target ? w.target - bal : BigInt(0);
    need += short;
    if (short > BigInt(0)) todo.push({ role: w.role, address: w.address, amount: short });
    console.log(
      `${w.role.padEnd(12)} ${w.address}  ${formatEther(bal)} ${unit}  target ${formatEther(w.target)}` +
        (short > BigInt(0) ? `  → needs ${formatEther(short)}` : "  ok"),
    );
  }
  console.log(`total to send: ${formatEther(need)} ${unit}`);
  if (!args.send) {
    console.log("dry run. Re-run with --send to transfer from the operator.");
    return;
  }
  if (need === BigInt(0)) return;
  if (opBal < need) throw new Error(`operator has ${formatEther(opBal)} ${unit}, needs ${formatEther(need)} + gas`);

  const sender = new SenderRegistry(client, info.chainId).for(roles.operator);
  for (const t of todo) {
    const sub = await sender.send({ to: t.address, value: t.amount, gas: BigInt(21_000) });
    const { receipt } = await waitForReceipt(client, sub.hash, { pollMs: 250, timeoutMs: 60_000 });
    console.log(`${t.role.padEnd(12)} +${formatEther(t.amount)} ${unit}  ${sub.hash}  ${receipt.status}`);
    if (receipt.status !== "success") throw new Error(`transfer to ${t.role} reverted (reserve balance?)`);
    if (info.network === "monad-testnet") {
      // Next transfer must be the operator's first tx in 3 blocks (reserve-balance emptying rule).
      while ((await client.getBlockNumber()) < receipt.blockNumber + BigInt(3)) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
  console.log("done.");
}

main().catch((err: unknown) => {
  console.error(`keeper:fund failed: ${(err as Error)?.message ?? err}`);
  process.exit(1);
});
