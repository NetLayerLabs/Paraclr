// `npm run pyth:push -- --network mainnet --feeds 0x…[,0x…] [--every S] [--count N] [--yes-mainnet]`
//
// Push the latest Hermes update for the given Pyth feeds with `pyth.updatePriceFeeds`, from the OPS
// key, once (`--count 1`) or every `--every` seconds until Ctrl-C. For the dead-feed procedure
// (docs/RUNBOOK.md "Dead feed"): `replaceMarketFeed` requires the NEW feed's stored price to be
// ≤ maxStoredPriceAge (15 s) old in the block it executes, and nobody else may be pushing that feed
// on Monad — so keep this running while the Safe executes the timelock operation.
// Cost: ≈ 0.0128 MON per 1-feed push at 102 gwei (126k gas limit, measured).

import { encodeFunctionData, formatEther, isHex, type Hex } from "viem";
import { parseArgs } from "../env";
import { SenderRegistry, waitForReceipt } from "../sender";
import { pythAbi } from "./abi";
import { confirmMainnet, connectMainnet, loadMainnetEnv, loadProdRoles, mainnetRpcUrl, rel } from "./config";
import { loadProdDeployment } from "./deployment";
import { HermesClient, hermesOptionsFromEnv } from "./hermes";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.network !== "mainnet") throw new Error("pass --network mainnet");
  loadMainnetEnv(args);
  const chain = await connectMainnet(mainnetRpcUrl(args));
  const dep = await loadProdDeployment(chain);
  const ops = loadProdRoles(["ops"]).ops!;
  const feeds = String(args.feeds ?? "")
    .split(",")
    .map((f) => f.trim().toLowerCase())
    .filter(Boolean) as Hex[];
  if (feeds.length === 0 || feeds.some((f) => !isHex(f) || f.length !== 66)) throw new Error("--feeds 0x<32 bytes>[,…] required");
  const every = Number(args.every ?? 10);
  const count = args.count === undefined ? Infinity : Number(args.count);
  const hermes = new HermesClient(hermesOptionsFromEnv());
  const sender = new SenderRegistry(chain.client, chain.chainId).for(ops);
  console.log(`pyth:push · ${chain.label} · ${rel(dep.file)} · Pyth ${dep.pyth} · from OPS ${ops.address} · ${feeds.length} feed(s) · ${Number.isFinite(count) ? `${count}×` : "until Ctrl-C"} every ${every}s`);
  confirmMainnet(chain, args, `push ${feeds.length} Pyth feed(s) from the OPS key`);
  let n = 0;
  let spent = BigInt(0);
  let stop = false;
  process.on("SIGINT", () => (stop = true));
  while (!stop && n < count) {
    const t0 = Date.now();
    try {
      const u = await hermes.latest(feeds);
      const fee = await chain.client.readContract({ address: dep.pyth, abi: pythAbi, functionName: "getUpdateFee", args: [u.data] });
      const data = encodeFunctionData({ abi: pythAbi, functionName: "updatePriceFeeds", args: [u.data] });
      const est = await chain.client.estimateGas({ account: ops.address, to: dep.pyth, data, value: fee });
      const gas = (est * BigInt(11)) / BigInt(10);
      const sub = await sender.send({ to: dep.pyth, data, value: fee, gas });
      const { receipt } = await waitForReceipt(chain.client, sub.hash, { pollMs: 200, timeoutMs: 60_000 });
      const fees = await chain.client.estimateFeesPerGas();
      spent += gas * fees.maxFeePerGas;
      n++;
      console.log(
        `  #${n} ${receipt.status} ${sub.hash} · publish ${[...u.messages.values()].map((m) => m.publishTime).join(",")} · gas ${receipt.gasUsed}/${gas} · ≈ ${formatEther(spent)} MON so far`,
      );
    } catch (err) {
      console.error(`  push failed: ${(err as Error).message.split("\n")[0]}`);
    }
    if (n >= count) break;
    await new Promise((r) => setTimeout(r, Math.max(0, every * 1000 - (Date.now() - t0))));
  }
}

main().catch((err: unknown) => {
  console.error(`pyth:push failed: ${(err as Error)?.message ?? err}`);
  process.exit(1);
});
