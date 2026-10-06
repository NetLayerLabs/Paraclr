// `npm run deploy:anvil` / `npm run deploy:monad` — deploy the demo stack and write
// deployments/<chainId>.json. Keys come from keeper/.env (gitignored); see keeper/README.md.
//
//   --network anvil|monad   (required; the npm scripts pass it)
//   --rpc URL               override the RPC (default: anvil http://127.0.0.1:8545,
//                           monad KEEPER_RPC_URL or https://testnet-rpc.monad.xyz)

import { envStr, KEEPER_ANVIL_ENV_FILE, loadKeeperEnv, parseArgs } from "../keeper/src/env";
import { ANVIL_RPC_URL, MONAD_RPC_URL } from "../keeper/src/network";
import { deployStack } from "./lib/deploy";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const net = args.network;
  if (net !== "anvil" && net !== "monad") throw new Error("--network anvil|monad is required");
  // Local anvil always uses anvil dev keys unless keeper/.env.anvil overrides them; keeper/.env
  // holds the Monad keys and must never be used against anvil (or vice versa).
  loadKeeperEnv(net === "anvil" ? KEEPER_ANVIL_ENV_FILE : undefined);
  const rpcUrl =
    typeof args.rpc === "string"
      ? args.rpc
      : net === "anvil"
        ? ANVIL_RPC_URL
        : (envStr("KEEPER_RPC_URL") ?? MONAD_RPC_URL);
  const r = await deployStack({ network: net === "anvil" ? "anvil" : "monad-testnet", rpcUrl });
  console.log(JSON.stringify(r.deployment, null, 2));
}

main().catch((err: unknown) => {
  console.error(`deploy failed: ${(err as Error)?.message ?? err}`);
  process.exit(1);
});
