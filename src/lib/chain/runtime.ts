// Decides at runtime whether the requested chain mode is usable, and records
// why not. On any failure the app keeps running the simulation (status
// "unavailable" + reason shown inline) instead of breaking.

import type { Address } from "viem";
import { setChain, setKeeper } from "../store";
import { paraclrClearinghouseAbi } from "./abi";
import { publicClient, readMany } from "./clients";
import { NETWORK } from "./config";
import { contractsFromKeeper, parseDeployment, resolveContracts, type ResolvedContracts } from "./deployments";
import { readableError } from "./errors";
import { keeperApi } from "./keeper";

/** Contracts once connected: AUSD and oracle are always known. */
export interface LiveContracts extends ResolvedContracts {
  ausd: Address;
  oracle: Address;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

let connecting: Promise<void> | null = null;

export function connectChain(input: { raw: unknown; loadError: string | null }): Promise<void> {
  if (!connecting) connecting = doConnect(input).finally(() => (connecting = null));
  return connecting;
}

async function doConnect({ raw, loadError }: { raw: unknown; loadError: string | null }): Promise<void> {
  if (!NETWORK) return;
  const net = NETWORK;
  const fail = (reason: string) => setChain({ status: "unavailable", reason, contracts: null });
  setChain({ status: "connecting", reason: null });

  const parsed = parseDeployment(raw, net.chainId);
  const fileProblem = loadError ?? parsed.error;
  let resolved = resolveContracts(parsed.deployment);

  if (!resolved) {
    try {
      const health = await keeperApi.health();
      setKeeper({ status: "online", error: null, health, checkedAt: Date.now() });
      resolved = contractsFromKeeper(health.addresses);
    } catch {
      /* keeper down too — reported below */
    }
  }
  if (!resolved) {
    fail(
      `No deployment for ${net.label} (chain ${net.chainId}): ` +
        (fileProblem ?? `deployments/${net.chainId}.json not found`) +
        ", NEXT_PUBLIC_CLEARINGHOUSE_ADDRESS unset, and the keeper didn't report addresses. Run the deploy flow (contracts/README.md).",
    );
    return;
  }

  const pc = publicClient();
  let chainId: number;
  try {
    chainId = await withTimeout(pc.getChainId(), 6_000);
  } catch {
    fail(
      `RPC unreachable at ${net.rpcUrl}.` + (net.mode === "anvil" ? " Is anvil running?" : " Check NEXT_PUBLIC_MONAD_RPC_URL."),
    );
    return;
  }
  if (chainId !== net.chainId) {
    fail(`Wrong chain: ${net.rpcUrl} reports chain ${chainId}, expected ${net.chainId} (${net.label}).`);
    return;
  }

  let code: string | undefined;
  try {
    code = await withTimeout(pc.getCode({ address: resolved.clearinghouse }), 6_000);
  } catch {
    fail(`RPC error reading the clearinghouse at ${resolved.clearinghouse}.`);
    return;
  }
  if (!code || code === "0x") {
    fail(
      `No clearinghouse contract at ${resolved.clearinghouse} on ${net.label} (address from ${resolved.source}). ` +
        (net.mode === "anvil" ? "Anvil was probably restarted — redeploy." : "Is the deployment file stale?"),
    );
    return;
  }

  let ausd = resolved.ausd;
  let oracle = resolved.oracle;
  if (!ausd || !oracle) {
    const [a, o] = await readMany({
      contracts: [
        { address: resolved.clearinghouse, abi: paraclrClearinghouseAbi, functionName: "ausd" },
        { address: resolved.clearinghouse, abi: paraclrClearinghouseAbi, functionName: "oracle" },
      ],
    });
    if (!ausd && a.status === "success") ausd = a.result;
    if (!oracle && o.status === "success") oracle = o.result;
  }
  if (!ausd || !oracle) {
    fail(`Couldn't resolve the AUSD / oracle addresses from the clearinghouse at ${resolved.clearinghouse}.`);
    return;
  }

  setChain({ status: "ready", reason: null, contracts: { ...resolved, ausd, oracle } });
}

/** Poll keeper /health once and record reachability + chain match in the store. */
export async function checkKeeper(): Promise<void> {
  if (!NETWORK) return;
  try {
    const health = await keeperApi.health();
    if (typeof health.chainId === "number" && health.chainId !== NETWORK.chainId) {
      setKeeper({
        status: "offline",
        health,
        error: `Keeper is connected to chain ${health.chainId}, but the app expects ${NETWORK.chainId} (${NETWORK.label}).`,
        checkedAt: Date.now(),
      });
      return;
    }
    setKeeper({ status: "online", health, error: null, checkedAt: Date.now() });
  } catch (e) {
    setKeeper({ status: "offline", error: readableError(e), checkedAt: Date.now() });
  }
}
