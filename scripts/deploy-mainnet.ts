// `npm run deploy:mainnet` — deploy the PRODUCTION contract set to Monad mainnet (chain 143).
//
//   npm run deploy:mainnet                 preflight + cost estimate, then REFUSES (dry run)
//   npm run deploy:mainnet -- --yes-mainnet   deploy for real (after reading the preflight)
//   flags: --env PATH (default keeper/.env.mainnet) · --rpc URL · --redeploy · --gas-report PATH
//
// Reads keeper/.env.mainnet (DEPLOYER key, OWNER_MULTISIG_ADDRESS, TIMELOCK_MIN_DELAY_SECONDS,
// caps, AUSD/Pyth addresses; guardian/ops/keeper ADDRESSES are derived from their keys). Writes
// deployments/143.json (commit it) — or DEPLOYMENTS_OUT on a rehearsal fork; never the canonical
// file from an anvil. Every role, cap and the ownership hand-off is verified on chain afterwards.
// Procedure and launch gate: docs/RUNBOOK.md.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONTRACTS_DIR, parseArgs } from "../keeper/src/env";
import { connectMainnet, loadMainnetEnv, loadProdRoles, mainnetRpcUrl, rel } from "../keeper/src/prod/config";
import { prodDeploymentPath } from "../keeper/src/prod/deployment";
import { deployProd } from "./lib/prod-deploy";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.network === undefined) args.network = "mainnet";
  if (args.network !== "mainnet") throw new Error("deploy:mainnet only deploys to --network mainnet (use deploy:anvil / deploy:monad for the demo)");
  loadMainnetEnv(args);
  const chain = await connectMainnet(mainnetRpcUrl(args));
  const roles = loadProdRoles(["deployer", "guardian", "ops", "keepers"]);
  // Real chain: contracts/cache/deploy-mainnet/. Anvil (rehearsal): next to its DEPLOYMENTS_OUT file.
  const dir = chain.fork ? dirname(prodDeploymentPath(chain)) : join(CONTRACTS_DIR, "cache", "deploy-mainnet");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const r = await deployProd(chain, roles, args, { logFile: join(dir, `${chain.chainId}-${stamp}-forge.log`) });
  const report = join(dir, `${chain.chainId}-${stamp}-verify.json`);
  writeFileSync(
    report,
    JSON.stringify(
      { network: chain.network, label: chain.label, chainId: chain.chainId, file: rel(r.file), deployment: r.dep.raw, preflight: r.pre, verification: r.post, forge: { ...r.forge, gasLimitTotal: r.forge.gasLimitTotal.toString(), gasUsedTotal: r.forge.gasUsedTotal.toString() } },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${rel(r.file)} and the verification report ${rel(report)}`);
  if (!chain.fork) {
    console.log("next (docs/RUNBOOK.md): commit deployments/143.json · sweep the deployer's MON · seed lane insurance + backstop pools · keeper:fund · start the keeper · launch gate.");
  }
}

main().catch((err: unknown) => {
  console.error(`deploy:mainnet failed: ${(err as Error)?.message ?? err}`);
  process.exit(1);
});
