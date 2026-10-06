// Nonce-safe transaction sending for the keeper's operator keys.
//
// Why not just `walletClient.writeContract`?
//   - Several roles send concurrently (price pusher every second, 8 lane keepers at once during a
//     crash, faucet on demand). Each role has its own key, and each key gets one TxSender that
//     hands out nonces locally under a per-key lock. Monad treats the "pending" block tag as
//     "latest" (docs.monad.xyz/reference/rpc-differences), so asking the node for the next nonce
//     while a tx is in flight would return a stale value — a local counter is required.
//   - The crash run wants to SIGN everything first and then fire all lane batches back to back,
//     so the measured "first submit → last receipt" window is not padded by signing time.
//   - Gas limits are always explicit (estimateGas + a small margin). Monad charges the gas LIMIT,
//     not gas used ("the gas charged for a transaction is the gas limit set in the transaction,
//     rather than the gas used", docs.monad.xyz/developer-essentials/gas-pricing), so a wallet-style
//     2x safety margin would double the bill.

import {
  TransactionReceiptNotFoundError,
  keccak256,
  type Address,
  type Hex,
  type LocalAccount,
  type TransactionReceipt,
} from "viem";
import type { Client } from "./network";

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface TxRequest {
  to: Address;
  data?: Hex;
  value?: bigint;
  gas: bigint;
}

export interface SignedTx {
  from: Address;
  hash: Hex;
  serialized: Hex;
  nonce: number;
  gas: bigint;
}

export interface Submitted {
  hash: Hex;
  nonce: number;
  gas: bigint;
  /** ms epoch taken immediately before eth_sendRawTransaction. */
  submittedAt: number;
}

/** EIP-1559 fee quote, cached briefly so a 1 Hz price loop doesn't double its RPC load. */
export class FeeOracle {
  private cached: { fees: Fees; at: number } | null = null;
  constructor(
    private readonly client: Client,
    private readonly ttlMs = 5_000,
  ) {}

  async get(fresh = false): Promise<Fees> {
    if (!fresh && this.cached && Date.now() - this.cached.at < this.ttlMs) return this.cached.fees;
    const f = await this.client.estimateFeesPerGas();
    const fees = { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
    this.cached = { fees, at: Date.now() };
    return fees;
  }
}

const NONCE_ERROR = /nonce too low|nonce.*(already|too low|used)|already known|replacement transaction underpriced|invalid nonce/i;

export class TxSender {
  readonly address: Address;
  private nextNonce: number | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly account: LocalAccount,
    private readonly client: Client,
    private readonly chainId: number,
    private readonly fees: FeeOracle,
  ) {
    this.address = account.address;
  }

  /** Run `fn` with this key's nonce stream locked. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Forget the local nonce; the next tx re-reads it from the chain. */
  resync(): void {
    this.nextNonce = null;
  }

  private async takeNonce(): Promise<number> {
    if (this.nextNonce === null) {
      this.nextNonce = await this.client.getTransactionCount({ address: this.address, blockTag: "pending" });
    }
    return this.nextNonce++;
  }

  private async signWithNonce(req: TxRequest, nonce: number, fees: Fees): Promise<SignedTx> {
    if (!this.account.signTransaction) throw new Error("account cannot sign transactions");
    const serialized = await this.account.signTransaction({
      type: "eip1559",
      chainId: this.chainId,
      nonce,
      to: req.to,
      data: req.data,
      value: req.value ?? BigInt(0),
      gas: req.gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    return { from: this.address, hash: keccak256(serialized), serialized, nonce, gas: req.gas };
  }

  /**
   * Reserve the next nonce and sign, without broadcasting. Callers MUST broadcast the returned
   * txs of one sender in nonce order; on a failed broadcast call `resync()`.
   */
  sign(req: TxRequest, fees?: Fees): Promise<SignedTx> {
    return this.exclusive(async () => {
      const f = fees ?? (await this.fees.get());
      return this.signWithNonce(req, await this.takeNonce(), f);
    });
  }

  /** Broadcast a pre-signed tx. `submittedAt` is taken right before the RPC call. */
  async broadcast(tx: SignedTx): Promise<Submitted> {
    const submittedAt = Date.now();
    try {
      await this.client.sendRawTransaction({ serializedTransaction: tx.serialized });
    } catch (err) {
      this.resync();
      throw err;
    }
    return { hash: tx.hash, nonce: tx.nonce, gas: tx.gas, submittedAt };
  }

  /** Sign + broadcast under the lock. Retries once after a nonce mismatch. */
  send(req: TxRequest): Promise<Submitted> {
    return this.exclusive(async () => {
      for (let attempt = 0; ; attempt++) {
        const fees = await this.fees.get();
        const tx = await this.signWithNonce(req, await this.takeNonce(), fees);
        const submittedAt = Date.now();
        try {
          await this.client.sendRawTransaction({ serializedTransaction: tx.serialized });
          return { hash: tx.hash, nonce: tx.nonce, gas: tx.gas, submittedAt };
        } catch (err) {
          this.resync();
          if (attempt === 0 && NONCE_ERROR.test(String((err as Error)?.message ?? err))) continue;
          throw err;
        }
      }
    });
  }
}

/** One TxSender per key, so two roles configured with the same key still share one nonce stream. */
export class SenderRegistry {
  private readonly senders = new Map<string, TxSender>();
  readonly fees: FeeOracle;

  constructor(
    private readonly client: Client,
    private readonly chainId: number,
  ) {
    this.fees = new FeeOracle(client);
  }

  for(account: LocalAccount): TxSender {
    const key = account.address.toLowerCase();
    let s = this.senders.get(key);
    if (!s) {
      s = new TxSender(account, this.client, this.chainId, this.fees);
      this.senders.set(key, s);
    }
    return s;
  }
}

/** `estimateGas` + margin. Monad bills the limit, so the margin is deliberately small. */
export async function estimateLimit(
  client: Client,
  req: { account: Address; to: Address; data?: Hex; value?: bigint },
  marginBps: number,
): Promise<{ estimate: bigint; limit: bigint }> {
  const estimate = await client.estimateGas({
    account: req.account,
    to: req.to,
    data: req.data,
    value: req.value,
  });
  const limit = (estimate * BigInt(10_000 + marginBps) + BigInt(9_999)) / BigInt(10_000);
  return { estimate, limit };
}

export interface Observed {
  receipt: TransactionReceipt;
  /** ms epoch when the keeper first saw the receipt (includes up to one poll interval of lag). */
  observedAt: number;
}

/**
 * Poll receipts for all `hashes` together (one batched JSON-RPC request per tick) until every
 * one is mined or `timeoutMs` passes. Resolves with whatever was observed; missing = timed out.
 */
export async function waitForReceipts(
  client: Client,
  hashes: Hex[],
  opts: { pollMs: number; timeoutMs: number },
): Promise<Map<Hex, Observed>> {
  const found = new Map<Hex, Observed>();
  const deadline = Date.now() + opts.timeoutMs;
  while (found.size < hashes.length && Date.now() < deadline) {
    const pending = hashes.filter((h) => !found.has(h));
    const results = await Promise.all(
      pending.map((hash) =>
        client.getTransactionReceipt({ hash }).catch((err: unknown) => {
          if (err instanceof TransactionReceiptNotFoundError) return null;
          throw err;
        }),
      ),
    );
    const now = Date.now();
    results.forEach((r, i) => {
      if (r) found.set(pending[i], { receipt: r, observedAt: now });
    });
    if (found.size < hashes.length) await new Promise((r) => setTimeout(r, opts.pollMs));
  }
  return found;
}

export async function waitForReceipt(
  client: Client,
  hash: Hex,
  opts: { pollMs: number; timeoutMs: number },
): Promise<Observed> {
  const r = (await waitForReceipts(client, [hash], opts)).get(hash);
  if (!r) throw new Error(`timed out after ${opts.timeoutMs}ms waiting for ${hash}`);
  return r;
}
