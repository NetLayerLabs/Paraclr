// Decides at runtime whether the requested chain mode is usable, and records
// why not. On any failure the app keeps running the simulation (status
// "unavailable" + reason shown inline) instead of breaking — except in
// monad-mainnet mode, where the shell shows a blocking "can't connect" screen
// instead of a simulation (real money must never look simulated, or vice versa).
//
// Production safety (monad-mainnet):
//   - contract addresses come ONLY from deployments/143.json (never the keeper);
//   - the file must say `"production": true`;
//   - the collateral token must report 6 decimals, and the clearinghouse's own
//     `ausd()` (when readable) must match the file.

import { erc20Abi, type Address, type Hex } from "viem";
import { MARKETS, type MarketSymbol } from "../types";
import { setChain, setKeeper } from "../store";
import { paraclrClearinghouseAbi } from "./abi";
import { publicClient, readMany } from "./clients";
import { AGORA_AUSD_MAINNET, NETWORK } from "./config";
import { contractsFromKeeper, parseDeployment, resolveContracts, type ResolvedContracts } from "./deployments";
import { readableError } from "./errors";
import { keeperApi } from "./keeper";
import { prodAbi } from "./prod/abi";
import { PYTH_MAINNET_FEEDS } from "./prod/state";

/** The collateral token as reported by the chain. */
export interface CollateralToken {
  address: Address;
  /** `symbol()` from chain ("AUSD" for both Agora AUSD and the demo MockAUSD). */
  symbol: string;
  name: string;
  decimals: number;
  /** The real Agora AUSD on Monad mainnet (address match on chain 143). */
  agora: boolean;
  /** Anything that isn't Agora AUSD in production: label it as a test token. */
  test: boolean;
}

/** Contracts once connected: AUSD and oracle are always known. */
export interface LiveContracts extends ResolvedContracts {
  ausd: Address;
  oracle: Address;
  token: CollateralToken;
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

const ZERO32 = `0x${"0".repeat(64)}`;

async function doConnect({ raw, loadError }: { raw: unknown; loadError: string | null }): Promise<void> {
  if (!NETWORK) return;
  const net = NETWORK;
  const fail = (reason: string) => setChain({ status: "unavailable", reason, contracts: null });
  setChain({ status: "connecting", reason: null });

  const parsed = parseDeployment(raw, net.chainId);
  const fileProblem = loadError ?? parsed.error;
  let resolved = resolveContracts(parsed.deployment);

  if (net.isMainnet) {
    // Real money: addresses only from the deployment file, and only the production set.
    if (!resolved || resolved.source !== "deployments") {
      fail(
        `No production deployment for ${net.label}: ${fileProblem ?? `deployments/${net.chainId}.json not found`}. ` +
          "Mainnet mode reads contract addresses only from that file (never from the keeper or env).",
      );
      return;
    }
    if (!resolved.production) {
      fail(
        `deployments/${net.chainId}.json is not marked "production": true — refusing to use it in mainnet mode ` +
          "(the demo contracts must never hold real funds).",
      );
      return;
    }
  } else if (!resolved) {
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
      `RPC unreachable at ${net.rpcUrl}.` +
        (net.mode === "anvil"
          ? " Is anvil running?"
          : net.mode === "monad-mainnet"
            ? " Check NEXT_PUBLIC_MONAD_MAINNET_RPC_URL."
            : " Check NEXT_PUBLIC_MONAD_RPC_URL."),
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
  let pyth = resolved.pyth;
  // The clearinghouse's own view of its collateral / oracle / Pyth.
  const [a, o, py] = await readMany({
    contracts: [
      { address: resolved.clearinghouse, abi: paraclrClearinghouseAbi, functionName: "ausd" },
      { address: resolved.clearinghouse, abi: paraclrClearinghouseAbi, functionName: "oracle" },
      { address: resolved.clearinghouse, abi: prodAbi, functionName: "pyth" },
    ],
  });
  const onchainAusd = a.status === "success" ? a.result : null;
  if (resolved.production && onchainAusd && ausd && onchainAusd.toLowerCase() !== ausd.toLowerCase()) {
    fail(
      `The clearinghouse's collateral token (${onchainAusd}) doesn't match deployments/${net.chainId}.json (${ausd}). Refusing to continue.`,
    );
    return;
  }
  if (!ausd && onchainAusd) ausd = onchainAusd;
  if (!oracle && o.status === "success") oracle = o.result;
  if (!pyth && py.status === "success") pyth = py.result;
  if (!oracle && resolved.production && pyth) oracle = pyth;
  if (!ausd || !oracle) {
    fail(`Couldn't resolve the AUSD / oracle addresses from the clearinghouse at ${resolved.clearinghouse}.`);
    return;
  }

  // Collateral token as the chain reports it.
  const [sym, name, dec] = await readMany({
    contracts: [
      { address: ausd, abi: erc20Abi, functionName: "symbol" },
      { address: ausd, abi: erc20Abi, functionName: "name" },
      { address: ausd, abi: erc20Abi, functionName: "decimals" },
    ],
  });
  const decimals = dec.status === "success" ? Number(dec.result) : null;
  if (decimals !== null && decimals !== 6) {
    fail(`The collateral token at ${ausd} reports ${decimals} decimals; the app and contracts assume 6. Refusing to continue.`);
    return;
  }
  if (resolved.production && decimals === null) {
    fail(`Couldn't read decimals() of the collateral token at ${ausd}.`);
    return;
  }
  const agora = net.chainId === 143 && ausd.toLowerCase() === AGORA_AUSD_MAINNET.toLowerCase();
  const token: CollateralToken = {
    address: ausd,
    symbol: sym.status === "success" && sym.result ? sym.result : "AUSD",
    name: name.status === "success" ? name.result : "",
    decimals: decimals ?? 6,
    agora,
    test: !(resolved.production && agora),
  };

  // Pyth feed ids per market: deployment file → the clearinghouse's getMarkets() → Pyth's official ids.
  let pythFeeds: Partial<Record<MarketSymbol, Hex>> = resolved.pythFeeds;
  if (resolved.production && MARKETS.some((m) => !pythFeeds[m])) {
    const [gm] = await readMany({
      contracts: [{ address: resolved.clearinghouse, abi: prodAbi, functionName: "getMarkets" }],
    });
    pythFeeds = { ...pythFeeds };
    const onchain = new Map<string, Hex>();
    if (gm.status === "success") {
      const [ids, , feeds] = gm.result;
      ids.forEach((id, i) => {
        const f = feeds[i];
        if (f && f !== ZERO32) onchain.set(id.toLowerCase(), f);
      });
    }
    for (const m of MARKETS) {
      if (pythFeeds[m]) continue;
      const hit = onchain.get(resolved.markets[m].toLowerCase());
      if (hit) pythFeeds[m] = hit;
      else if (net.chainId === 143) pythFeeds[m] = PYTH_MAINNET_FEEDS[m];
    }
  }

  setChain({
    status: "ready",
    reason: null,
    contracts: { ...resolved, ausd, oracle, pyth, pythFeeds, token },
  });
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
