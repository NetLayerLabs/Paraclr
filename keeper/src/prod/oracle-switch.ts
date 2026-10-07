// Pre-switch pushes for the TESTNET trial-end fallback (docs/RUNBOOK.md "Testnet: trial-end fallback").
//
// The clearinghouse's `setPyth(fallback)` (through the timelock) reverts FeedNotOnPyth unless the
// new oracle STORES every listed feed, and right after the switch every `[]` call (withdraw, pool
// ops) prices from storage (≤ maxStoredPriceAge = 15 s) or the lane's last price. So while the
// clearinghouse still runs on Pyth and a fallback is recorded with this keeper as its signer, the
// keeper watches the timelock for the operation `timelock -- set-pyth` prepares
// (setPyth(fallback), salt keccak256("paraclr:setPyth(address):<fallback>")): from 120 s before it
// becomes executable until it executes, it pushes keeper-signed prices into the fallback (OPS key,
// fee 0, ~70k gas) whenever the stored ones are ≥ 10 s old. SIGNED_PREPUSH_S=N forces a push every
// N s regardless (e.g. an operation scheduled with a custom salt). The keeper is the ONLY signer
// process: never run `pyth:push --signed` with the same key next to a running keeper.

import { encodeFunctionData, getAddress, keccak256, toHex, type Hex } from "viem";
import { pythAbi, timelockAbi } from "./abi";
import { envNum } from "./config";
import { short, type ProdContext } from "./context";
import type { Head } from "./head";
import { estimate, sendTracked, type TxLedger } from "./tx";

const TL_TS_ABI = [{ type: "function", name: "getTimestamp", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "uint256" }] }] as const;
const SET_PYTH_ABI = [{ type: "function", name: "setPyth", stateMutability: "nonpayable", inputs: [{ name: "pyth_", type: "address" }], outputs: [] }] as const;
const ZERO32 = `0x${"0".repeat(64)}` as Hex;

export class FallbackPrepush {
  private opId: Hex | null = null;
  private inflight = false;
  stats = { pushes: 0, failures: 0, lastError: null as string | null, operationId: null as Hex | null, readyAt: null as number | null, lastPushAt: 0, forcedEveryS: envNum("SIGNED_PREPUSH_S", 0) };

  constructor(
    private readonly ctx: ProdContext,
    private readonly ledger: TxLedger,
  ) {}

  async tick(head: Head): Promise<void> {
    const { ctx } = this;
    const fb = ctx.dep.fallbackOracle;
    const signed = ctx.sources.signed;
    if (!fb || !signed || ctx.dep.oracle !== "pyth" || !ctx.dep.timelock || !ctx.roles.ops || this.inflight) return;
    const every = this.stats.forcedEveryS > 0 ? this.stats.forcedEveryS : 10;
    if (this.stats.forcedEveryS <= 0) {
      if (!this.opId) {
        const data = encodeFunctionData({ abi: SET_PYTH_ABI, functionName: "setPyth", args: [fb] });
        const salt = keccak256(toHex(`paraclr:setPyth(address):${getAddress(fb)}`)); // = `timelock set-pyth`'s default salt
        this.opId = await ctx.chain.client.readContract({ address: ctx.dep.timelock, abi: timelockAbi, functionName: "hashOperation", args: [ctx.dep.clearinghouse, BigInt(0), data, ZERO32, salt] });
        this.stats.operationId = this.opId;
      }
      const ts = Number(await ctx.chain.client.readContract({ address: ctx.dep.timelock, abi: TL_TS_ABI, functionName: "getTimestamp", args: [this.opId] }));
      this.stats.readyAt = ts > 1 ? ts : null; // 0 = not scheduled, 1 = done
      if (!(ts > 1 && ts - head.timestamp <= 120)) return;
    }
    const stored = await Promise.all(
      ctx.markets.map((m) => ctx.chain.client.readContract({ address: fb, abi: pythAbi, functionName: "getPriceUnsafe", args: [m.feed] }).then((p) => Number(p.publishTime), () => 0)),
    );
    if (stored.every((t) => head.timestamp - t < every)) return;
    this.inflight = true;
    try {
      const u = await signed.latest(ctx.markets.map((m) => m.feed));
      const data = encodeFunctionData({ abi: pythAbi, functionName: "updatePriceFeeds", args: [u.data] });
      const ops = ctx.roles.ops;
      const est = await estimate(ctx, { from: ops.address, to: fb, data });
      if (!est.ok) throw new Error(`fallback updatePriceFeeds does not simulate: ${est.revert.message}`);
      await sendTracked(ctx, this.ledger, ops, { to: fb, data, gas: est.gas }, { kind: "pythPush", lane: null, meta: { why: "fallback pre-switch push", oracle: fb } }, (tx) => {
        if (tx.status === "success") {
          this.stats.pushes++;
          this.stats.lastPushAt = Date.now();
        } else this.stats.failures++;
      });
    } catch (err) {
      this.stats.failures++;
      this.stats.lastError = short(err);
      console.warn(`[prepush] ${short(err)}`);
    } finally {
      this.inflight = false;
    }
  }

  status() {
    return { active: Boolean(this.ctx.dep.fallbackOracle && this.ctx.sources.signed && this.ctx.dep.oracle === "pyth"), ...this.stats };
  }
}
