// `npm run guardian:pause -- --network mainnet|testnet [--yes-mainnet|--yes-testnet] [--env PATH] [--rpc URL]`
//
// Emergency pause from the GUARDIAN key (docs/RUNBOOK.md "Pause"). Pause blocks deposits from
// accounts without positions, backstop deposits, and committing / executing INCREASE orders.
// Withdrawals, reduce/close orders, cancellations, liquidations (auctions), pool withdrawals,
// funding updates and claims keep working. Unpausing is timelock-only (`npm run timelock`).
//
//   --status   only print the paused state, the on-chain guardian and the guardian key's balance

import { encodeFunctionData, formatEther } from "viem";
import { parseArgs } from "../env";
import { waitForReceipt, SenderRegistry } from "../sender";
import { clearinghouseAbi } from "./abi";
import { confirmMainnet, connectMainnet, loadMainnetEnv, loadProdRoles, mainnetRpcUrl, rel } from "./config";
import { loadProdDeployment } from "./deployment";
import { decodeRevert } from "./tx";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.network !== "mainnet" && args.network !== "testnet") throw new Error("pass --network mainnet or --network testnet");
  loadMainnetEnv(args);
  const chain = await connectMainnet(mainnetRpcUrl(args));
  const dep = await loadProdDeployment(chain);
  const roles = loadProdRoles(args.status ? [] : ["guardian"]);
  const read = <T>(functionName: "paused" | "guardian" | "owner") =>
    chain.client.readContract({ address: dep.clearinghouse, abi: clearinghouseAbi, functionName }) as Promise<T>;
  const [paused, guardian, owner] = await Promise.all([read<boolean>("paused"), read<string>("guardian"), read<string>("owner")]);
  console.log(`guardian:pause · ${chain.label} · ${rel(dep.file)}`);
  console.log(`  clearinghouse ${dep.clearinghouse}  paused=${paused}`);
  console.log(`  on-chain guardian ${guardian} · owner ${owner}${dep.timelock && owner.toLowerCase() === dep.timelock.toLowerCase() ? " (the timelock)" : ""}`);
  if (roles.guardian) {
    const bal = await chain.client.getBalance({ address: roles.guardian.address });
    const match = roles.guardian.address.toLowerCase() === guardian.toLowerCase();
    console.log(`  guardian key ${roles.guardian.address} · ${formatEther(bal)} MON · ${match ? "matches" : "DOES NOT MATCH the on-chain guardian"}`);
    if (!chain.fork && bal < BigInt(10) ** BigInt(16)) console.log("  WARNING the guardian key holds < 0.01 MON: pause() may not be payable (keeper:fund)");
    if (!match && !args.status) throw new Error("GUARDIAN_PRIVATE_KEY is not the contract's guardian: pause would revert (Unauthorized)");
  }
  if (args.status) return;
  if (paused) {
    console.log("already paused; nothing to do.");
    return;
  }
  const guardianKey = roles.guardian!;
  const data = encodeFunctionData({ abi: clearinghouseAbi, functionName: "pause" });
  let gas: bigint;
  try {
    gas = ((await chain.client.estimateGas({ account: guardianKey.address, to: dep.clearinghouse, data })) * BigInt(12)) / BigInt(10);
  } catch (err) {
    throw new Error(`pause() does not simulate: ${decodeRevert(err).message}`);
  }
  const fees = await chain.client.estimateFeesPerGas();
  console.log(`  pause(): gas limit ${gas} ≈ ${formatEther(gas * fees.maxFeePerGas)} MON`);
  confirmMainnet(chain, args, "pause() the production clearinghouse from the guardian key");
  const sub = await new SenderRegistry(chain.client, chain.chainId).for(guardianKey).send({ to: dep.clearinghouse, data, gas });
  const { receipt } = await waitForReceipt(chain.client, sub.hash, { pollMs: 300, timeoutMs: 90_000 });
  console.log(`  pause() ${receipt.status} · tx ${sub.hash} · block ${receipt.blockNumber} · gas used ${receipt.gasUsed} / limit ${gas}`);
  if (receipt.status !== "success") process.exit(1);
  console.log(`PAUSED. Unpause only via the timelock: \`npm run timelock -- --network ${chain.profile.name} prepare --call "unpause()"\` (docs/RUNBOOK.md).`);
}

main().catch((err: unknown) => {
  console.error(`guardian:pause failed: ${(err as Error)?.message ?? err}`);
  process.exit(1);
});
