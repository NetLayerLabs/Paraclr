// Decides at runtime whether the requested chain mode is usable, and records
// why not. On any failure the app keeps running the simulation (status
// "unavailable" + reason shown inline) instead of breaking — except in the
// production modes (monad-mainnet, monad-testnet), where the shell shows a
// blocking "can't connect" screen instead of a simulation (a production
// deployment must never look simulated, or vice versa).
//
// Production safety (monad-mainnet, monad-testnet):
//   - contract addresses come ONLY from deployments/<chainId>.json (never the
//     keeper or env);
//   - the file must say `"production": true` (the older demo-stack
//     deployments/10143.json has no such flag and is refused);
//   - the collateral token must report 6 decimals, and the clearinghouse's own
//     `ausd()` (when readable) must match the file;
//   - the markets are the file's `markets` keys that the clearinghouse also
//     lists (`getMarkets()`); nothing else is ever read or offered.

import { erc20Abi, type Address, type Hex } from "viem";
import { MARKETS, type MarketSymbol } from "../types";
import { getState, selectMarket, setChain, setKeeper } from "../store";
import { paraclrClearinghouseAbi } from "./abi";
import { publicClient, readMany } from "./clients";
import { AGORA_AUSD_MAINNET, AGORA_AUSD_TESTNET, NETWORK } from "./config";
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
  /** Agora's AUSD contract on this chain (address match: mainnet on 143, Agora's testnet AUSD on 10143). */
  agora: boolean;
  /** No real value: anything but Agora AUSD on Monad mainnet. Labelled as a test token. */
  test: boolean;
  /** Agora's testnet AUSD (chain 10143): real Agora token on testnet, test funds, no value. Tagged TESTNET. */
  testnet: boolean;
}

/** Contracts once connected: AUSD and oracle are always known. */
export interface LiveContracts extends ResolvedContracts {
  ausd: Address;
  oracle: Address;
  token: CollateralToken;
  /**
   * Production: what the clearinghouse's `pyth()` points at. "pyth" = the real
   * Pyth contract; "keeper-signed" = the testnet-only fallback oracle after the
   * Pyth data trial (prices signed by the keeper, labelled as such).
   */
  oracleKind: "pyth" | "keeper-signed";
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
  let fileProblem = loadError ?? parsed.error;
  let deployment = parsed.deployment;
  // The legacy `monad` mode is the DEMO stack on testnet. deployments/10143.json
  // is shared with the production deployment; that one belongs to monad-testnet.
  if (net.mode === "monad" && deployment?.production) {
    fileProblem =
      'deployments/10143.json is the production deployment ("production": true), not the demo stack — ' +
      "run NEXT_PUBLIC_CHAIN_MODE=monad-testnet for it";
    deployment = null;
  }
  let resolved = resolveContracts(deployment);

  if (net.requiresProduction) {
    // Production modes: addresses only from the deployment file, and only the production set.
    if (!resolved || resolved.source !== "deployments") {
      fail(
        `No production deployment for ${net.label}: ${fileProblem ?? `deployments/${net.chainId}.json not found`}. ` +
          `This mode reads contract addresses only from that file (never from the keeper or env)${
            net.isTestnetProd ? "; NEXT_PUBLIC_CHAIN_MODE=monad runs the older demo stack instead" : ""
          }.`,
      );
      return;
    }
    if (!resolved.production) {
      fail(
        net.isMainnet
          ? `deployments/${net.chainId}.json is not marked "production": true — refusing to use it in mainnet mode ` +
              "(the demo contracts must never hold real funds)."
          : `deployments/${net.chainId}.json is not marked "production": true (it looks like the older demo-stack ` +
              "deployment). monad-testnet mode runs only the production contracts; use NEXT_PUBLIC_CHAIN_MODE=monad for the demo stack.",
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
            : net.mode === "monad-testnet"
              ? net.sandbox
                ? " Is the local sandbox (anvil fork of Monad testnet) running? Check NEXT_PUBLIC_MONAD_TESTNET_RPC_URL."
                : " Check NEXT_PUBLIC_MONAD_TESTNET_RPC_URL."
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
        (net.mode === "anvil" || net.sandbox
          ? "The local chain was probably restarted — redeploy."
          : "Is the deployment file stale?"),
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
  // Production: the clearinghouse's live oracle is the truth. It must be the
  // deployment's Pyth, or (testnet only) its recorded keeper-signed fallback.
  let oracleKind: LiveContracts["oracleKind"] = "pyth";
  const livePyth = py.status === "success" ? py.result : null;
  if (resolved.production && livePyth && pyth && livePyth.toLowerCase() !== pyth.toLowerCase()) {
    const fallback = resolved.fallbackOracle;
    if (!net.isMainnet && fallback && livePyth.toLowerCase() === fallback.toLowerCase()) {
      oracleKind = "keeper-signed";
      pyth = livePyth;
      oracle = livePyth;
    } else {
      fail(
        `The clearinghouse's oracle pyth() = ${livePyth} is neither deployments/${net.chainId}.json's Pyth (${pyth})` +
          (net.isMainnet ? "" : ` nor its recorded fallback oracle (${fallback ?? "none"})`) +
          ". Refusing to continue.",
      );
      return;
    }
  }
  if (!pyth && livePyth) pyth = livePyth;
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
  const mainnetAgora = net.chainId === 143 && ausd.toLowerCase() === AGORA_AUSD_MAINNET.toLowerCase();
  const testnetAgora = net.chainId === 10143 && ausd.toLowerCase() === AGORA_AUSD_TESTNET.toLowerCase();
  const token: CollateralToken = {
    address: ausd,
    symbol: sym.status === "success" && sym.result ? sym.result : "AUSD",
    name: name.status === "success" ? name.result : "",
    decimals: decimals ?? 6,
    agora: mainnetAgora || testnetAgora,
    test: !(resolved.production && mainnetAgora),
    testnet: testnetAgora,
  };

  // Production markets + Pyth feed ids. Listed = the deployment's `markets`
  // keys that the clearinghouse also lists (getMarkets); feed id = the
  // clearinghouse's own (what it verifies) → the file → Pyth's official id.
  let listed = resolved.listed;
  let pythFeeds: Partial<Record<MarketSymbol, Hex>> = resolved.pythFeeds;
  if (resolved.production) {
    const [gm] = await readMany({
      contracts: [{ address: resolved.clearinghouse, abi: prodAbi, functionName: "getMarkets" }],
    });
    const onchain = gm.status === "success" ? new Map<string, Hex>() : null;
    if (gm.status === "success") {
      const [ids, , feeds] = gm.result;
      ids.forEach((id, i) => onchain?.set(id.toLowerCase(), feeds[i] ?? (ZERO32 as Hex)));
    }
    const named = listed.length ? listed : MARKETS;
    listed = onchain ? named.filter((m) => onchain.has(resolved.markets[m].toLowerCase())) : listed;
    if (listed.length === 0) {
      fail(
        `No tradable market: deployments/${net.chainId}.json names ` +
          (resolved.listed.length ? resolved.listed.join(", ") : "no market") +
          (onchain ? ", and the clearinghouse lists none of them." : ", and the clearinghouse's getMarkets() didn't answer."),
      );
      return;
    }
    const feeds: Partial<Record<MarketSymbol, Hex>> = {};
    for (const m of listed) {
      const fromChain = onchain?.get(resolved.markets[m].toLowerCase());
      const official = net.chainId === 143 || net.chainId === 10143 ? PYTH_MAINNET_FEEDS[m] : undefined;
      const hit = (fromChain && fromChain !== ZERO32 ? fromChain : undefined) ?? pythFeeds[m] ?? official;
      if (hit) feeds[m] = hit;
    }
    pythFeeds = feeds;
  }

  setChain({
    status: "ready",
    reason: null,
    contracts: { ...resolved, ausd, oracle, pyth, pythFeeds, listed, token, oracleKind },
  });
  // The default market (MON) may not be listed on this deployment.
  if (!listed.includes(getState().selectedMarket)) selectMarket(listed[0]);
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
