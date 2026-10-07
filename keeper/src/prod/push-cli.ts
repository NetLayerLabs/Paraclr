// `npm run pyth:push -- --network mainnet|testnet --feeds 0x…[,0x…] [--every S] [--count N] [--yes-mainnet|--yes-testnet]`
//
// Push the latest Hermes update for the given Pyth feeds with `pyth.updatePriceFeeds`, from the OPS
// key, once (`--count 1`) or every `--every` seconds until Ctrl-C. For the dead-feed procedure
// (docs/RUNBOOK.md "Dead feed"): `replaceMarketFeed` requires the NEW feed's stored price to be
// ≤ maxStoredPriceAge (15 s) old in the block it executes, and nobody else may be pushing that feed
// on Monad — so keep this running while the Safe executes the timelock operation.
// Cost: ≈ 0.0128 MON per 1-feed push at 102 gwei (126k gas limit, measured).
//
// `--signed` (TESTNET trial-end fallback, docs/RUNBOOK.md "Testnet: trial-end fallback"): push
// KEEPER-SIGNED prices (PRICE_SIGNER_PRIVATE_KEY, keeper/src/prod/signed.ts) for every listed feed
// (or --feeds) into the KeeperSignedPyth oracle (--oracle 0x…, else the deployment's
// "fallbackOracle" / KEEPER_SIGNED_PYTH_ADDRESS). `setPyth` requires every listed feed to be STORED
// in the new oracle, and right after the switch storage should be fresh. A running keeper with the
// signer key does this by itself (oracle-switch.ts); use this only when NO keeper with the same
// PRICE_SIGNER_PRIVATE_KEY is running (two processes would sign competing price chains). Fee 0.

import { encodeFunctionData, formatEther, getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { parseArgs } from "../env";
import { SenderRegistry, waitForReceipt } from "../sender";
import { pythAbi } from "./abi";
import { confirmMainnet, connectMainnet, loadMainnetEnv, loadProdRoles, mainnetRpcUrl, rel } from "./config";
import { loadProdDeployment } from "./deployment";
import { HermesClient, hermesOptionsFromEnv } from "./hermes";
import { ReserveGuard } from "./reserve";
import { loadPriceSigner, SignedPriceSource } from "./signed";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.network !== "mainnet" && args.network !== "testnet") throw new Error("pass --network mainnet or --network testnet");
  loadMainnetEnv(args);
  const chain = await connectMainnet(mainnetRpcUrl(args));
  const dep = await loadProdDeployment(chain);
  const ops = loadProdRoles(["ops"]).ops!;
  const signedMode = args.signed === true;
  let feeds = String(args.feeds ?? "")
    .split(",")
    .map((f) => f.trim().toLowerCase())
    .filter(Boolean) as Hex[];
  if (signedMode && feeds.length === 0) feeds = Object.values(dep.feeds).map((f) => f.toLowerCase() as Hex);
  if (feeds.length === 0 || feeds.some((f) => !isHex(f) || f.length !== 66)) throw new Error("--feeds 0x<32 bytes>[,…] required");
  const every = Number(args.every ?? 10);
  const count = args.count === undefined ? Infinity : Number(args.count);

  let target: Address = dep.pyth;
  let source: { latest(ids: readonly Hex[]): Promise<{ data: Hex[]; messages: Map<string, { publishTime: number }> }> };
  let signed: SignedPriceSource | null = null;
  if (signedMode) {
    if (chain.profile.name !== "testnet") throw new Error("--signed is the TESTNET trial-end fallback only");
    const oracle = typeof args.oracle === "string" ? args.oracle : dep.fallbackOracle;
    if (!oracle || !isAddress(oracle)) throw new Error("--signed needs --oracle 0x… (or fallbackOracle in the deployment file / KEEPER_SIGNED_PYTH_ADDRESS)");
    target = getAddress(oracle);
    const signer = loadPriceSigner();
    if (!signer) throw new Error("--signed needs PRICE_SIGNER_PRIVATE_KEY in the env file");
    const symbolOf = new Map(Object.entries(dep.feeds).map(([s, f]) => [f.toLowerCase(), s]));
    console.warn("  --signed: this process signs its OWN price chain. Never run it next to a keeper that signs with the same PRICE_SIGNER_PRIVATE_KEY.");
    signed = new SignedPriceSource({ signer, oracle: target, chainId: chain.chainId, client: chain.client, feeds: feeds.map((f) => ({ symbol: symbolOf.get(f) ?? f.slice(0, 10), feed: f })) });
    await signed.start();
    source = signed;
  } else {
    source = new HermesClient(hermesOptionsFromEnv());
  }
  const sender = new SenderRegistry(chain.client, chain.chainId).for(ops);
  const guard = new ReserveGuard(chain.client, chain.fork);
  console.log(
    `pyth:push · ${chain.label} · ${rel(dep.file)} · ${signedMode ? `KEEPER-SIGNED oracle ${target} (signer ${signed!.signer})` : `Pyth ${target}`} · from OPS ${ops.address} · ` +
      `${feeds.length} feed(s) · ${Number.isFinite(count) ? `${count}×` : "until Ctrl-C"} every ${every}s`,
  );
  confirmMainnet(chain, args, `push ${feeds.length} ${signedMode ? "keeper-signed" : "Pyth"} feed(s) from the OPS key`);
  let n = 0;
  let spent = BigInt(0);
  let stop = false;
  process.on("SIGINT", () => (stop = true));
  while (!stop && n < count) {
    const t0 = Date.now();
    try {
      let u = null;
      for (let i = 0; i < 20 && !u; i++) {
        u = await source.latest(feeds).catch((err: unknown) => {
          if (!signedMode || i === 19) throw err;
          return null;
        });
        if (!u) await new Promise((r) => setTimeout(r, 500));
      }
      if (!u) throw new Error("no update");
      const fee = await chain.client.readContract({ address: target, abi: pythAbi, functionName: "getUpdateFee", args: [u.data] });
      const data = encodeFunctionData({ abi: pythAbi, functionName: "updatePriceFeeds", args: [u.data] });
      const est = await chain.client.estimateGas({ account: ops.address, to: target, data, value: fee });
      const gas = (est * BigInt(11)) / BigInt(10);
      const fees = await chain.client.estimateFeesPerGas();
      // Monad reserve balance: testnet Pyth charges 1 wei per message (value) — space after the last tx.
      const sub = await guard.send(ops.address, fee, gas * fees.maxFeePerGas, async () => {
        const s = await sender.send({ to: target, data, value: fee, gas });
        const mined = waitForReceipt(chain.client, s.hash, { pollMs: 200, timeoutMs: 60_000 });
        return { ...s, mined, block: mined.then((r) => r.receipt.blockNumber as bigint | null, () => null) };
      });
      const { receipt } = await sub.mined;
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
  signed?.stop();
}

main().catch((err: unknown) => {
  console.error(`pyth:push failed: ${(err as Error)?.message ?? err}`);
  process.exit(1);
});
