// `npm run oracle:fallback -- --network testnet <deploy|record|status>` — the TESTNET trial-end
// fallback oracle (docs/TESTNET_PLAN.md "Trial-end fallback"; docs/RUNBOOK.md "Testnet: trial-end
// fallback"). NOT for mainnet: every command refuses --network mainnet.
//
//   deploy [--yes-testnet]   deploy contracts/src/testnet/KeeperSignedPyth.sol from the OPS key with
//                            owner = the deployment's TimelockController (so only the Safe, through
//                            the timelock, can change its signers) and signer = PRICE_SIGNER_PRIVATE_KEY's
//                            address; push one keeper-signed update for every listed feed (setPyth
//                            requires each feed to be stored); record "fallbackOracle" in the
//                            deployment file. Dry run (prints the plan + cost) without --yes-testnet.
//   record [--oracle 0x…] [--live]
//                            write "fallbackOracle"; with --live (AFTER the timelocked setPyth
//                            executed) also "pyth"/"oracle" = the fallback, "priceSource":
//                            "keeper-signed" ("realPyth" keeps the real Pyth) so the app labels prices
//                            "simulated after the Pyth trial". Refuses --live unless pyth() really is it.
//   status                   the clearinghouse's live oracle, the fallback's owner / signers / stored
//                            prices.
//
// After `deploy`: `npm run timelock -- --network testnet set-pyth --to <fallback>` writes the Safe
// files; keep `npm run pyth:push -- --network testnet --signed --every 10` running around the
// execute; the keeper switches live (PythUpdated → gov:oracle).

import { readFileSync, writeFileSync } from "node:fs";
import { createWalletClient, encodeDeployData, encodeFunctionData, formatEther, getAddress, http, isAddress, parseAbi, type Address, type Hex } from "viem";
import { parseArgs } from "../keeper/src/env";
import { pythAbi } from "../keeper/src/prod/abi";
import { confirmMainnet, connectMainnet, loadMainnetEnv, loadProdRoles, mainnetRpcUrl, rel, type ProdChain } from "../keeper/src/prod/config";
import { prodDeploymentPath, readProdDeployment, type ProdDeployment } from "../keeper/src/prod/deployment";
import { loadPriceSigner, SignedPriceSource } from "../keeper/src/prod/signed";
import { waitForReceipt } from "../keeper/src/sender";
import { buildArtifacts } from "./lib/artifacts";

const KSP_ABI = parseAbi([
  "function owner() view returns (address)",
  "function isSigner(address) view returns (bool)",
  "function signerCount() view returns (uint256)",
  "function version() view returns (string)",
  "function validTimePeriod() view returns (uint256)",
]);
const CH_ABI = parseAbi(["function pyth() view returns (address)", "function getMarkets() view returns (bytes32[] ids, string[] symbols, bytes32[] feeds)"]);

function load(chain: ProdChain): ProdDeployment {
  const file = prodDeploymentPath(chain);
  const dep = readProdDeployment(file);
  if (!dep) throw new Error(`no deployment at ${rel(file)} (npm run deploy:testnet first)`);
  if (!dep.timelock) throw new Error(`${rel(file)} has no timelock`);
  return dep;
}

function patchFile(file: string, patch: Record<string, unknown>): void {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...raw, ...patch }, null, 2) + "\n");
}

async function deploy(chain: ProdChain, args: Record<string, string | true>): Promise<void> {
  const dep = load(chain);
  const ops = loadProdRoles(["ops"]).ops!;
  const signer = loadPriceSigner();
  if (!signer) throw new Error("PRICE_SIGNER_PRIVATE_KEY is not set (npm run keeper:init -- --network testnet adds it)");
  const live = (await chain.client.readContract({ address: dep.clearinghouse, abi: CH_ABI, functionName: "pyth" })) as Address;
  const [, symbols, feeds] = (await chain.client.readContract({ address: dep.clearinghouse, abi: CH_ABI, functionName: "getMarkets" })) as readonly [readonly Hex[], readonly string[], readonly Hex[]];
  const art = (await buildArtifacts("testnet-oracle"))("KeeperSignedPyth.sol", "KeeperSignedPyth");
  const validTime = BigInt(Number(args["valid-time"] ?? 60));
  const fees = await chain.client.estimateFeesPerGas();
  const gasEst = await chain.client
    .estimateGas({ account: ops.address, data: encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args: [dep.timelock!, [signer.address], validTime] }) })
    .catch(() => BigInt(1_500_000));
  const bal = await chain.client.getBalance({ address: ops.address });
  console.log(`oracle:fallback deploy · ${chain.label} · ${rel(dep.file)}`);
  console.log(`  clearinghouse ${dep.clearinghouse} · live oracle pyth() = ${live}${dep.fallbackOracle ? ` · recorded fallback ${dep.fallbackOracle}` : ""}`);
  console.log(`  KeeperSignedPyth(owner = timelock ${dep.timelock}, signers = [${signer.address}], validTimePeriod ${validTime} s) from OPS ${ops.address}`);
  console.log(`  then one keeper-signed update for ${symbols.join(", ")} (setPyth needs every listed feed stored)`);
  console.log(`  cost ≈ ${formatEther((gasEst * BigInt(12)) / BigInt(10) * fees.maxFeePerGas + BigInt(120_000) * fees.maxFeePerGas)} MON · OPS balance ${formatEther(bal)} MON`);
  confirmMainnet(chain, args, "deploy the keeper-signed fallback oracle (KeeperSignedPyth)");

  const wallet = createWalletClient({ account: ops, chain: chain.chain, transport: http(chain.rpcUrl) });
  const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [dep.timelock!, [signer.address], validTime], gas: (gasEst * BigInt(12)) / BigInt(10), chain: chain.chain });
  const r = await chain.client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy tx ${hash} failed`);
  const oracle = getAddress(r.contractAddress);
  console.log(`  deployed ${oracle} (tx ${hash}, gas ${r.gasUsed})`);

  const src = new SignedPriceSource({ signer, oracle, chainId: chain.chainId, client: chain.client, feeds: symbols.map((s, i) => ({ symbol: s, feed: feeds[i] })) });
  await src.start();
  let u = null;
  for (let i = 0; i < 30 && !u; i++) {
    u = await src.latest(feeds).catch(() => null);
    if (!u) await new Promise((res) => setTimeout(res, 500));
  }
  src.stop();
  if (!u) throw new Error("the signer produced no price (source unreachable?)");
  const data = encodeFunctionData({ abi: pythAbi, functionName: "updatePriceFeeds", args: [u.data] });
  const gas = ((await chain.client.estimateGas({ account: ops.address, to: oracle, data })) * BigInt(12)) / BigInt(10);
  const pushHash = await wallet.sendTransaction({ to: oracle, data, gas, chain: chain.chain });
  const pr = await waitForReceipt(chain.client, pushHash, { pollMs: 300, timeoutMs: 90_000 });
  console.log(`  seeded ${symbols.join(", ")} (tx ${pushHash}, ${pr.receipt.status}, gas ${pr.receipt.gasUsed})`);
  patchFile(dep.file, { fallbackOracle: oracle, fallbackSigner: signer.address });
  console.log(`  recorded "fallbackOracle": ${oracle} in ${rel(dep.file)}${chain.fork ? "" : " (commit it)"}`);
  console.log("next (docs/RUNBOOK.md \"Testnet: trial-end fallback\"):");
  console.log("  1. restart the keeper with PRICE_SIGNER_PRIVATE_KEY in its env (it signs ahead of the switch)");
  console.log(`  2. npm run timelock -- --network testnet set-pyth --to ${oracle}   (Safe files; schedule now, execute after the delay)`);
  console.log(`  3. around the execute: npm run pyth:push -- --network testnet --signed --every 10 --yes-testnet`);
  console.log("  4. npm run oracle:fallback -- --network testnet record --live");
}

async function record(chain: ProdChain, args: Record<string, string | true>): Promise<void> {
  const dep = load(chain);
  const oracle = typeof args.oracle === "string" ? args.oracle : dep.fallbackOracle;
  if (!oracle || !isAddress(oracle)) throw new Error("record needs --oracle 0x… (or a recorded fallbackOracle)");
  const fb = getAddress(oracle);
  const patch: Record<string, unknown> = { fallbackOracle: fb };
  if (args.live === true) {
    const live = (await chain.client.readContract({ address: dep.clearinghouse, abi: CH_ABI, functionName: "pyth" })) as Address;
    if (live.toLowerCase() !== fb.toLowerCase()) throw new Error(`pyth() is ${live}, not ${fb}: execute the timelocked setPyth first`);
    Object.assign(patch, { pyth: fb, oracle: fb, realPyth: dep.realPyth, priceSource: "keeper-signed", oracleSwitch: { to: fb, at: new Date().toISOString(), note: "simulated after the Pyth trial: keeper-signed prices (testnet only)" } });
  } else if (args.back === true) {
    Object.assign(patch, { pyth: dep.realPyth, oracle: dep.realPyth, priceSource: "pyth" });
  }
  patchFile(dep.file, patch);
  console.log(`updated ${rel(dep.file)}: ${JSON.stringify(patch)}`);
}

async function status(chain: ProdChain): Promise<void> {
  const dep = load(chain);
  const live = (await chain.client.readContract({ address: dep.clearinghouse, abi: CH_ABI, functionName: "pyth" })) as Address;
  console.log(`clearinghouse ${dep.clearinghouse} · live oracle ${live} (${live.toLowerCase() === dep.realPyth.toLowerCase() ? "REAL Pyth" : dep.fallbackOracle && live.toLowerCase() === dep.fallbackOracle.toLowerCase() ? "KEEPER-SIGNED fallback" : "unknown"})`);
  if (!dep.fallbackOracle) return console.log("no fallback oracle recorded (oracle:fallback deploy)");
  const fb = dep.fallbackOracle;
  const [owner, n, ver, vt] = await Promise.all([
    chain.client.readContract({ address: fb, abi: KSP_ABI, functionName: "owner" }),
    chain.client.readContract({ address: fb, abi: KSP_ABI, functionName: "signerCount" }),
    chain.client.readContract({ address: fb, abi: KSP_ABI, functionName: "version" }),
    chain.client.readContract({ address: fb, abi: KSP_ABI, functionName: "validTimePeriod" }),
  ]);
  console.log(`fallback ${fb}: ${ver} · owner ${owner}${dep.timelock && owner.toLowerCase() === dep.timelock.toLowerCase() ? " (the timelock)" : " (NOT the timelock!)"} · ${n} signer(s) · validTimePeriod ${vt} s`);
  const signer = loadPriceSigner();
  if (signer) console.log(`  this env's PRICE_SIGNER ${signer.address}: ${(await chain.client.readContract({ address: fb, abi: KSP_ABI, functionName: "isSigner", args: [signer.address] })) ? "allowed" : "NOT allowed"}`);
  const now = Number((await chain.client.getBlock({ blockTag: "latest" })).timestamp);
  for (const [sym, feed] of Object.entries(dep.feeds)) {
    const p = await chain.client.readContract({ address: fb, abi: pythAbi, functionName: "getPriceUnsafe", args: [feed] }).catch(() => null);
    console.log(`  ${sym}: ${p ? `stored ${Number(p.price) * 10 ** Number(p.expo)} (${now - Number(p.publishTime)} s old)` : "NOT stored (setPyth would revert FeedNotOnPyth)"}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = argv.find((a) => ["deploy", "record", "status"].includes(a));
  if (args.network !== "testnet") throw new Error("the keeper-signed fallback oracle is TESTNET ONLY: pass --network testnet");
  if (!cmd) throw new Error("usage: npm run oracle:fallback -- --network testnet <deploy|record|status> [--yes-testnet]");
  loadMainnetEnv(args);
  const chain = await connectMainnet(mainnetRpcUrl(args));
  if (cmd === "deploy") return deploy(chain, args);
  if (cmd === "record") return record(chain, args);
  return status(chain);
}

main().catch((err: unknown) => {
  console.error(`oracle:fallback failed: ${(err as Error)?.message ?? err}`);
  process.exit(1);
});
