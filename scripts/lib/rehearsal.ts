// Helpers for `npm run rehearse:mainnet` / `rehearse:testnet` / `sandbox` (anvil processes, AUSD storage cheats, lane-ground keys,
// a webhook sink, time control). Rehearsal-only: nothing here is used by the production keeper.

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createConnection } from "node:net";
import {
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundryBin } from "../../keeper/src/foundry";
import type { Client, ProdChain } from "../../keeper/src/prod/config";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function rpc<T = unknown>(client: Client, method: string, params: unknown[] = []): Promise<T> {
  return (await client.request({ method: method as never, params: params as never })) as T;
}

export interface AnvilOpts {
  port: number;
  forkUrl?: string;
  forkBlock?: number;
  chainId?: number;
  blockTime?: number;
  logFile: string;
}

/** Start anvil (Monad-like: 128 KB code, 150M block gas, prague) and wait until it answers. */
export async function startAnvil(o: AnvilOpts): Promise<ChildProcess> {
  const args = [
    "--port", String(o.port),
    "--code-size-limit", "131072",
    "--gas-limit", "150000000",
    "--hardfork", "prague",
    "--block-time", String(o.blockTime ?? 1),
  ];
  if (o.forkUrl) {
    args.push("--fork-url", o.forkUrl, "--fork-block-number", String(o.forkBlock), "--no-rate-limit", "--fork-retry-backoff", "500", "--retries", "8", "--timeout", "45000");
  }
  if (o.chainId) args.push("--chain-id", String(o.chainId));
  const fd = openSync(o.logFile, "w");
  const child = spawn(foundryBin("anvil"), args, { stdio: ["ignore", fd, fd] });
  closeSync(fd);
  const url = `http://127.0.0.1:${o.port}`;
  for (let i = 0; i < 200; i++) {
    await sleep(150);
    if (child.exitCode !== null) throw new Error(`anvil exited (${child.exitCode}); see ${o.logFile}`);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (res.ok) return child;
    } catch {
      /* not up yet */
    }
  }
  throw new Error(`anvil did not come up on ${url}`);
}

export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ port, host: "127.0.0.1" });
    s.once("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", () => resolve(true));
  });
}

/** A fresh key whose address is in `lane` (uint160(address) % 8). */
export function laneAccount(lane: number): { key: Hex; account: LocalAccount } {
  for (;;) {
    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    if (Number(BigInt(account.address) % BigInt(8)) === lane) return { key, account };
  }
}

export async function setBalance(client: Client, who: Address, wei: bigint): Promise<void> {
  await rpc(client, "anvil_setBalance", [who, toHex(wei)]);
}

// Balance-slot cheats live in the keeper (the sandbox faucet uses them too).
export { dealToken, findBalanceSlot } from "../../keeper/src/prod/anvil-cheats";

/** Send a contract call from a local key and wait for the receipt (rehearsal traders / treasury). */
export async function sendAs(
  chain: ProdChain,
  account: LocalAccount,
  to: Address,
  data: Hex,
  value = BigInt(0),
): Promise<{ hash: Hex; status: "success" | "reverted"; gasUsed: bigint; gas: bigint; block: bigint }> {
  const wallet = createWalletClient({ account, chain: chain.chain, transport: http(chain.rpcUrl) });
  const gasEst = await chain.client.estimateGas({ account: account.address, to, data, value });
  const gas = (gasEst * BigInt(11)) / BigInt(10);
  const hash = await wallet.sendTransaction({ to, data, value, gas, chain: chain.chain });
  const r = await chain.client.waitForTransactionReceipt({ hash, pollingInterval: 200, timeout: 120_000 });
  return { hash, status: r.status, gasUsed: r.gasUsed, gas, block: r.blockNumber };
}

/** Collects every POST (alert webhook payloads). */
export class WebhookSink {
  readonly received: Array<{ at: number; body: unknown }> = [];
  private server: Server | null = null;
  constructor(readonly port: number) {}
  start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try {
          this.received.push({ at: Date.now(), body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch {
          this.received.push({ at: Date.now(), body: Buffer.concat(chunks).toString("utf8") });
        }
        res.writeHead(204);
        res.end();
      });
    });
    return new Promise((r) => this.server!.listen(this.port, "127.0.0.1", () => r()));
  }
  stop(): Promise<void> {
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }
  keys(): string[] {
    return this.received.map((x) => {
      const a = (x.body as { alert?: { key?: string; state?: string } }).alert;
      return a ? `${a.state === "resolved" ? "resolved:" : ""}${a.key}` : "?";
    });
  }
}

export async function chainTime(client: Client): Promise<number> {
  return Number((await client.getBlock({ blockTag: "latest" })).timestamp);
}

/**
 * Mine exactly one block at `timestamp` containing whatever is pending (interval mining paused
 * around it, so the block can't be pre-empted by an empty interval block).
 */
export async function mineAt(client: Client, timestamp: number, send: () => Promise<Hex[]>, blockTime = 1): Promise<Hex[]> {
  await rpc(client, "evm_setIntervalMining", [0]);
  try {
    const hashes = await send();
    // wait until the node has them all
    for (let i = 0; i < 100; i++) {
      const got = await Promise.all(hashes.map((h) => client.getTransaction({ hash: h }).then(() => true, () => false)));
      if (got.every(Boolean)) break;
      await sleep(50);
    }
    await rpc(client, "evm_mine", [{ timestamp, blocks: 1 }]);
    return hashes;
  } finally {
    await rpc(client, "evm_setIntervalMining", [blockTime]);
  }
}

/** Warp the chain clock forward (next block at `timestamp`) and mine one block. */
export async function warpTo(client: Client, timestamp: number): Promise<void> {
  await rpc(client, "evm_setNextBlockTimestamp", [timestamp]);
  await rpc(client, "evm_mine", []);
}

export function idOf(symbol: string): Hex {
  return keccak256(toHex(symbol));
}

// ---------------------------------------------------------------------------
// Safe (the owner multisig) on a fork of Monad mainnet
// ---------------------------------------------------------------------------

/** Safe v1.4.1 on Monad mainnet (code verified on chain 2026-10-07). */
export const SAFE = {
  singletonL2: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762" as Address,
  proxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67" as Address,
};

const SAFE_SETUP_ABI = [
  {
    type: "function",
    name: "setup",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_owners", type: "address[]" },
      { name: "_threshold", type: "uint256" },
      { name: "to", type: "address" },
      { name: "data", type: "bytes" },
      { name: "fallbackHandler", type: "address" },
      { name: "paymentToken", type: "address" },
      { name: "payment", type: "uint256" },
      { name: "paymentReceiver", type: "address" },
    ],
    outputs: [],
  },
] as const;

const FACTORY_ABI = [
  {
    type: "function",
    name: "createProxyWithNonce",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_singleton", type: "address" },
      { name: "initializer", type: "bytes" },
      { name: "saltNonce", type: "uint256" },
    ],
    outputs: [{ name: "proxy", type: "address" }],
  },
] as const;

/** Deploy a real Safe proxy (owners, threshold) through the canonical factory; returns its address. */
export async function createSafe(chain: ProdChain, payer: LocalAccount, owners: Address[], threshold: number): Promise<Address> {
  const zero = "0x0000000000000000000000000000000000000000" as Address;
  const initializer = encodeFunctionData({ abi: SAFE_SETUP_ABI, functionName: "setup", args: [owners, BigInt(threshold), zero, "0x", zero, zero, BigInt(0), zero] });
  const salt = BigInt(Date.now());
  const sim = await chain.client.simulateContract({ address: SAFE.proxyFactory, abi: FACTORY_ABI, functionName: "createProxyWithNonce", args: [SAFE.singletonL2, initializer, salt], account: payer.address });
  const data = encodeFunctionData({ abi: FACTORY_ABI, functionName: "createProxyWithNonce", args: [SAFE.singletonL2, initializer, salt] });
  const r = await sendAs(chain, payer, SAFE.proxyFactory, data);
  if (r.status !== "success") throw new Error("Safe proxy creation reverted");
  return sim.result;
}
