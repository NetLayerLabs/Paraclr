// Conflict X-ray on its own — `npm run xray -- --from B1 --to B2 [--method auto|debug|fork]`.
//
// Re-runs the X-ray (xray-run.ts) over an existing block range, e.g. a crash run whose keeper had
// XRAY=off, a Monad run re-traced later, or to exercise the anvil-fork-replay fallback on purpose
// (--method fork). Every tx to a design contract in [from, to] is a node.
//
// Flags:
//   --from N --to M     resolution block range (inclusive; normally shock block + 1 … last resolution)
//   --run-id ID         id for the report / file name (default xray-<from>-<to>)
//   --method M          auto (default: debug trace, else fork replay) | debug | fork
//   --rpc URL           RPC (default KEEPER_RPC_URL or http://127.0.0.1:8545; private ports get their
//                       own deployment file, see keeper/README.md)
//   --out DIR           directory for <chainId>-<runId>.json (default XRAY_DIR or bench/xray)
//   --paraclr-only      only the lane-sharded design

import { resolve } from "node:path";
import { createContext } from "../keeper/src/context";
import { loadKeeperEnv, parseArgs } from "../keeper/src/env";
import { applyPrivateStackDefaults, defaultRpcUrl } from "../keeper/src/network";
import { runXray } from "../keeper/src/xray-run";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadKeeperEnv();
  const rpcUrl = typeof args.rpc === "string" ? args.rpc : defaultRpcUrl();
  applyPrivateStackDefaults(rpcUrl);
  if (typeof args.out === "string") process.env.XRAY_DIR = resolve(args.out);
  const ctx = await createContext({ rpcUrl });
  const from = Number(args.from);
  const to = Number(args.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) throw new Error("--from/--to must be a block range");
  const method = (typeof args.method === "string" ? args.method : "auto") as "auto" | "debug" | "fork";
  if (!["auto", "debug", "fork"].includes(method)) throw new Error("--method must be auto | debug | fork");
  const designs = ctx.designs.filter((d) => d.label === "paraclr" || !args["paraclr-only"]);
  const runId = typeof args["run-id"] === "string" ? args["run-id"] : `xray-${from}-${to}`;
  const report = await runXray(ctx, { runId, fromBlock: from, toBlock: to, designs, method });
  console.log(JSON.stringify({ method: report.method, forkedFrom: report.forkedFrom, summary: report.designs.map((d) => [d.design, d.summary]) }));
}

main().catch((err: unknown) => {
  console.error(`xray failed: ${(err as Error)?.message ?? err}`);
  process.exit(1);
});
