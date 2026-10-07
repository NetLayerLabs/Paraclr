// Production keeper entry for the container image (keeper/Dockerfile bundles THIS file only, so
// the image contains no demo code paths: no faucet, price pusher, crash or demo takers).
//   node keeper/src/keeper.cjs --network mainnet --yes-mainnet
//   node keeper/src/keeper.cjs --network testnet --yes-testnet

import { parseArgs } from "../env";
import { runProdKeeper } from "./main";

const args = parseArgs(process.argv.slice(2));
if (args.network !== "mainnet" && args.network !== "testnet") {
  console.error("[keeper] this build is the production keeper: pass --network mainnet or --network testnet");
  process.exit(1);
}
runProdKeeper(args).catch((err: unknown) => {
  console.error(`[keeper] fatal: ${(err as Error)?.message ?? err}`);
  process.exit(1);
});
