// Pool exit helper (contract v5): the LAST LP of a lane cannot exit while the pool holds positions
// (`BackstopPositionsOpen`). When that LP's exit request is ripe (readyAt reached, not expired) and
// the pool still holds positions, the lane's keeper — the only backstop operator of that lane —
// unwinds them with `backstopReduce(lane, market, size, update)` (fresh Hermes update), so the exit
// can go through inside its 1 h window.
//
// Requests are learnt from `BackstopWithdrawRequested` events in the executor's per-head log scan;
// the on-chain request, share supply and positions are re-read before acting.

import { encodeFunctionData, parseEventLogs, type Abi, type Address, type Hex, type Log } from "viem";
import { clearinghouseAbi } from "./abi";
import { short, updateFee, type ProdContext } from "./context";
import type { Head } from "./head";
import { estimate, sendTracked, type TxLedger } from "./tx";

interface Req {
  lane: number;
  lp: Address;
}

export class PoolExitHelper {
  private readonly requests = new Map<string, Req>();
  private readonly busy = new Set<number>();
  stats = { reductions: 0, failures: 0, lastError: null as string | null };

  constructor(
    private readonly ctx: ProdContext,
    private readonly ledger: TxLedger,
  ) {}

  onLogs(logs: Log[]): void {
    for (const e of parseEventLogs({ abi: clearinghouseAbi as Abi, logs, strict: false })) {
      if (e.eventName !== "BackstopWithdrawRequested") continue;
      const a = e.args as unknown as { lane: number; lp: Address };
      this.requests.set(`${a.lane}:${a.lp.toLowerCase()}`, { lane: Number(a.lane), lp: a.lp });
    }
  }

  private read<T>(fn: string, args: unknown[]): Promise<T> {
    return this.ctx.chain.client.readContract({ address: this.ctx.dep.clearinghouse, abi: clearinghouseAbi as never, functionName: fn as never, args: args as never }) as Promise<T>;
  }

  async tick(head: Head): Promise<void> {
    for (const [key, r] of this.requests) {
      if (this.busy.has(r.lane)) continue;
      try {
        const req = await this.read<readonly [bigint, bigint, bigint]>("backstopWithdrawRequest", [r.lane, r.lp]);
        if (req[0] === BigInt(0) || head.timestamp > Number(req[2])) {
          this.requests.delete(key); // used, cancelled or expired
          continue;
        }
        if (head.timestamp < Number(req[1])) continue; // not ripe yet
        const [nav, shares, pos] = await Promise.all([
          this.read<readonly bigint[]>("backstopNav", [r.lane]),
          this.read<bigint>("backstopSharesOf", [r.lane, r.lp]),
          this.read<readonly [readonly Hex[], readonly bigint[], readonly bigint[]]>("backstopPositions", [r.lane]),
        ]);
        const last = shares > BigInt(0) && shares === nav[3];
        const open = pos[0].map((m, i) => ({ market: m, size: pos[1][i] })).filter((p) => p.size !== BigInt(0));
        if (!last || open.length === 0) continue;
        this.busy.add(r.lane);
        await this.unwind(r.lane, open).finally(() => this.busy.delete(r.lane));
      } catch (err) {
        this.stats.failures++;
        this.stats.lastError = short(err);
      }
    }
  }

  private async unwind(lane: number, open: Array<{ market: Hex; size: bigint }>): Promise<void> {
    const keeper = this.ctx.roles.keepers[lane];
    for (const p of open) {
      const m = this.ctx.markets.find((x) => x.id.toLowerCase() === p.market.toLowerCase());
      if (!m) continue;
      const u = await this.ctx.hermes.latest([m.feed]);
      const fee = await updateFee(this.ctx, u.data); // per call
      const size = p.size < BigInt(0) ? -p.size : p.size;
      const data = encodeFunctionData({ abi: clearinghouseAbi, functionName: "backstopReduce", args: [lane, p.market, size, u.data] });
      const est = await estimate(this.ctx, { from: keeper.address, to: this.ctx.dep.clearinghouse, data, value: fee });
      if (!est.ok) {
        this.stats.failures++;
        this.stats.lastError = `lane ${lane} backstopReduce ${m.symbol}: ${est.revert.message}`;
        continue;
      }
      await sendTracked(this.ctx, this.ledger, keeper, { to: this.ctx.dep.clearinghouse, data, value: fee, gas: est.gas }, { kind: "backstopReduce", lane, meta: { market: m.symbol, size: size.toString(), why: "last LP exit" } });
      this.stats.reductions++;
      this.ctx.alerter.event(`pool:unwind:lane${lane}`, "info", `lane ${lane}: the last LP's exit is ripe — the lane keeper unwound the pool's ${m.symbol} position (${size}) so the exit can go through`);
    }
  }

  status() {
    return { tracked: this.requests.size, ...this.stats };
  }
}
