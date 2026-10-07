// Simulate → estimate → send → track for production txs, with revert reasons decoded from the
// clearinghouse + Pyth ABIs, and a per-kind ledger of gas (limit, as billed by Monad, and used)
// that feeds /health, the rehearsal report and the MON budget.

import {
  BaseError,
  decodeErrorResult,
  type Abi,
  type Address,
  type Hex,
  type LocalAccount,
  type TransactionReceipt,
} from "viem";
import { waitForReceipt } from "../sender";
import { clearinghouseAbi } from "./abi";
import type { ProdContext } from "./context";

export type TxKind =
  | "executeOrder"
  | "updateFunding"
  | "startAuctions"
  | "backstopTakeBatch"
  | "expireBatch"
  | "cancelAuction"
  | "pause"
  | "claim"
  | "pythPush";

export interface ProdTx {
  kind: TxKind;
  lane: number | null;
  from: Address;
  to: Address;
  hash: Hex;
  gasLimit: bigint;
  value: bigint;
  submittedAt: number;
  status: "pending" | "success" | "reverted" | "lost";
  block: number | null;
  blockTimestamp: number | null;
  gasUsed: bigint | null;
  confirmedAt: number | null;
  meta: Record<string, unknown>;
  receipt?: TransactionReceipt;
}

/** Extra error fragments the keeper may meet (Pyth, OZ Pausable). */
const EXTRA_ERRORS = [
  { type: "error", name: "InsufficientFee", inputs: [] },
  { type: "error", name: "StalePrice", inputs: [] },
  { type: "error", name: "PriceFeedNotFound", inputs: [] },
  { type: "error", name: "PriceFeedNotFoundWithinRange", inputs: [] },
  { type: "error", name: "InvalidUpdateData", inputs: [] },
  { type: "error", name: "InvalidUpdateDataSource", inputs: [] },
  { type: "error", name: "InvalidWormholeVaa", inputs: [] },
  { type: "error", name: "NoFreshUpdate", inputs: [] },
  { type: "error", name: "EnforcedPause", inputs: [] },
  { type: "error", name: "ExpectedPause", inputs: [] },
] as const;

let errorAbi: Abi = [...(clearinghouseAbi as Abi), ...(EXTRA_ERRORS as unknown as Abi)];

/** Swap in the generated ABI's errors when it lands (contract.ts calls this). */
export function setErrorAbi(abi: Abi): void {
  errorAbi = [...abi, ...(EXTRA_ERRORS as unknown as Abi)];
}

export interface Revert {
  name: string;
  args: readonly unknown[];
  message: string;
}

/** Best-effort decode of a revert from any viem error. */
export function decodeRevert(err: unknown): Revert {
  let data: Hex | undefined;
  let message = (err as Error)?.message?.split("\n")[0] ?? String(err);
  if (err instanceof BaseError) {
    err.walk((e) => {
      const d = (e as { data?: unknown }).data;
      if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) data = d as Hex;
      else if (d && typeof d === "object" && typeof (d as { data?: unknown }).data === "string") data = (d as { data: Hex }).data;
      return false;
    });
    message = err.shortMessage || message;
  }
  if (!data) {
    const d = (err as { data?: unknown })?.data;
    if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) data = d as Hex;
  }
  if (data) {
    try {
      const r = decodeErrorResult({ abi: errorAbi, data });
      return { name: r.errorName, args: (r.args ?? []) as readonly unknown[], message: `${r.errorName}(${(r.args ?? []).map(String).join(", ")})` };
    } catch {
      return { name: `0x${data.slice(2, 10)}`, args: [], message: `unknown error ${data.slice(0, 10)}` };
    }
  }
  return { name: "unknown", args: [], message };
}

export interface KindStats {
  sent: number;
  success: number;
  reverted: number;
  lost: number;
  gasLimit: bigint;
  gasUsed: bigint;
  maxGasLimit: bigint;
}

export class TxLedger {
  readonly recent: ProdTx[] = [];
  readonly byKind = new Map<TxKind, KindStats>();

  add(tx: ProdTx): void {
    this.recent.push(tx);
    if (this.recent.length > 500) this.recent.shift();
    const s = this.stats(tx.kind);
    s.sent++;
    s.gasLimit += tx.gasLimit;
    if (tx.gasLimit > s.maxGasLimit) s.maxGasLimit = tx.gasLimit;
  }

  finish(tx: ProdTx): void {
    const s = this.stats(tx.kind);
    if (tx.status === "success") s.success++;
    else if (tx.status === "reverted") s.reverted++;
    else if (tx.status === "lost") s.lost++;
    if (tx.gasUsed !== null) s.gasUsed += tx.gasUsed;
  }

  private stats(kind: TxKind): KindStats {
    let s = this.byKind.get(kind);
    if (!s) {
      s = { sent: 0, success: 0, reverted: 0, lost: 0, gasLimit: BigInt(0), gasUsed: BigInt(0), maxGasLimit: BigInt(0) };
      this.byKind.set(kind, s);
    }
    return s;
  }

  summary() {
    return Object.fromEntries(
      [...this.byKind.entries()].map(([k, s]) => [
        k,
        {
          ...s,
          gasLimit: s.gasLimit.toString(),
          gasUsed: s.gasUsed.toString(),
          maxGasLimit: s.maxGasLimit.toString(),
          avgGasLimit: s.sent ? (s.gasLimit / BigInt(s.sent)).toString() : "0",
        },
      ]),
    );
  }
}

/** eth_estimateGas + margin; returns the decoded revert instead of throwing. */
export async function estimate(
  ctx: ProdContext,
  req: { from: Address; to: Address; data: Hex; value?: bigint },
): Promise<{ ok: true; gas: bigint; estimate: bigint } | { ok: false; revert: Revert }> {
  try {
    const est = await ctx.chain.client.estimateGas({ account: req.from, to: req.to, data: req.data, value: req.value ?? BigInt(0) });
    const gas = (est * BigInt(10_000 + ctx.config.gasMarginBps) + BigInt(9_999)) / BigInt(10_000);
    return { ok: true, gas, estimate: est };
  } catch (err) {
    return { ok: false, revert: decodeRevert(err) };
  }
}

/** Send under the key's nonce lock and track the receipt in the background. */
export async function sendTracked(
  ctx: ProdContext,
  ledger: TxLedger,
  account: LocalAccount,
  req: { to: Address; data: Hex; value?: bigint; gas: bigint },
  info: { kind: TxKind; lane: number | null; meta?: Record<string, unknown> },
  onDone?: (tx: ProdTx) => void,
): Promise<ProdTx> {
  const sender = ctx.senders.for(account);
  const sub = await sender.send({ to: req.to, data: req.data, value: req.value ?? BigInt(0), gas: req.gas });
  const tx: ProdTx = {
    kind: info.kind,
    lane: info.lane,
    from: account.address,
    to: req.to,
    hash: sub.hash,
    gasLimit: req.gas,
    value: req.value ?? BigInt(0),
    submittedAt: sub.submittedAt,
    status: "pending",
    block: null,
    blockTimestamp: null,
    gasUsed: null,
    confirmedAt: null,
    meta: info.meta ?? {},
  };
  ledger.add(tx);
  void (async () => {
    try {
      const { receipt, observedAt } = await waitForReceipt(ctx.chain.client, sub.hash, {
        pollMs: ctx.config.receiptPollMs,
        timeoutMs: ctx.config.receiptTimeoutMs,
      });
      tx.receipt = receipt;
      tx.status = receipt.status === "success" ? "success" : "reverted";
      tx.block = Number(receipt.blockNumber);
      tx.gasUsed = receipt.gasUsed;
      tx.confirmedAt = observedAt;
      const b = await ctx.chain.client.getBlock({ blockNumber: receipt.blockNumber }).catch(() => null);
      tx.blockTimestamp = b ? Number(b.timestamp) : null;
    } catch {
      tx.status = "lost";
      sender.resync();
    }
    ledger.finish(tx);
    onDone?.(tx);
  })();
  return tx;
}

export function txJson(t: ProdTx) {
  return {
    kind: t.kind,
    lane: t.lane,
    from: t.from,
    hash: t.hash,
    status: t.status,
    block: t.block,
    blockTimestamp: t.blockTimestamp,
    gasLimit: t.gasLimit.toString(),
    gasUsed: t.gasUsed?.toString() ?? null,
    value: t.value.toString(),
    submittedAt: t.submittedAt,
    confirmedAt: t.confirmedAt,
    meta: t.meta,
  };
}
