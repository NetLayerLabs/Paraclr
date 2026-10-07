// Pyth storage freshness (ParaclrClearinghouseProd v2: stored and lane prices expire after
// maxStoredPriceAge = 15 s; supplied updates after maxPriceAge = 30 s).
//
// Who needs a FRESH STORED price, and how each is served (docs/RUNBOOK.md "Pyth push policy"):
//   - auctions (start / take / cure / expire) — the sweeper supplies a fresh Hermes update in every
//     tx: no storage needed;
//   - the order FILL — its own unique update: no storage needed;
//   - an order's OTHER legs (cross-margin check) — storage or the lane's last price only → this
//     module pushes `pyth.updatePriceFeeds` for exactly the stale feeds, from the lane keeper,
//     right before the execution ("on-demand");
//   - users' `[]` calls (withdraw, pool ops, cure) — the app fetches a fresh signed update through
//     the keeper's /hermes proxy when storage is stale and pays the verification itself.
//
// Modes (PYTH_PUSH_MODE):
//   on-demand (default)  pushes only before executions that need it (≈ 0.5 MON/day at the beta's
//                        activity; measured, docs/RUNBOOK.md)
//   interval             additionally keeps every feed ≤ PYTH_PUSH_INTERVAL_S old while any
//                        position or pending order exists (≈ 100 MON/day with the observed
//                        third-party pushes) — only if you want `[]` calls to always work
//   off                  never push (multi-leg executions then wait for a third-party push)

import { encodeFunctionData, type Hex, type LocalAccount } from "viem";
import { waitForReceipt } from "../sender";
import { clearinghouseAbi, pythAbi } from "./abi";
import { envNum, LANES } from "./config";
import { short, updateFee, type MarketInfo, type ProdContext } from "./context";
import type { Head } from "./head";
import { estimate, sendTracked, type TxLedger } from "./tx";

export type PushMode = "on-demand" | "interval" | "off";

export class PricePusher {
  readonly mode: PushMode;
  /** Push when the newest usable price would be older than maxStoredPriceAge − margin. */
  private readonly marginS = envNum("PYTH_PUSH_MARGIN_S", 4);
  private readonly intervalS = envNum("PYTH_PUSH_INTERVAL_S", 12);
  /** In-flight push per feed, so 8 lanes never push the same feed twice at once. */
  private readonly inflight = new Map<string, Promise<boolean>>();
  stats = { pushes: 0, feedsPushed: 0, skippedFresh: 0, failures: 0, gasLimit: BigInt(0), lastError: null as string | null, lastPushAt: 0 };

  constructor(
    private readonly ctx: ProdContext,
    private readonly ledger: TxLedger,
  ) {
    const m = (process.env.PYTH_PUSH_MODE ?? "on-demand").trim().toLowerCase();
    if (m !== "on-demand" && m !== "interval" && m !== "off") throw new Error(`PYTH_PUSH_MODE must be on-demand | interval | off, got "${m}"`);
    this.mode = m;
  }

  get maxAge(): number {
    return this.ctx.params.maxStoredPriceAge ?? 15;
  }

  /** Newest usable publish time per market for `lane`: max(Pyth-stored, the lane's last price). */
  async newest(lane: number, markets: MarketInfo[]): Promise<number[]> {
    const c = this.ctx.chain.client;
    return Promise.all(
      markets.map(async (m) => {
        const [stored, lp] = await Promise.all([
          c.readContract({ address: this.ctx.dep.pyth, abi: pythAbi, functionName: "getPriceUnsafe", args: [m.feed] }).then((p) => Number(p.publishTime), () => 0),
          c.readContract({ address: this.ctx.dep.clearinghouse, abi: clearinghouseAbi, functionName: "lanePrice", args: [lane, m.id] }).then((r) => Number((r as readonly [bigint, bigint])[1]), () => 0),
        ]);
        return Math.max(stored, lp);
      }),
    );
  }

  /**
   * Make sure every market in `markets` has a usable stored/lane price in `lane` for at least the
   * next ~marginS seconds; pushes the stale feeds from `signer` and waits for the receipt.
   * Returns false if a needed push failed (the caller retries on the next head).
   */
  async ensureFresh(lane: number, markets: MarketInfo[], signer: LocalAccount, now: number): Promise<boolean> {
    if (markets.length === 0 || this.mode === "off") return true;
    const newest = await this.newest(lane, markets);
    const stale = markets.filter((_, i) => now - newest[i] > this.maxAge - this.marginS);
    if (stale.length === 0) {
      this.stats.skippedFresh++;
      return true;
    }
    // Join a push already in flight for any of these feeds, then re-check.
    const joining = stale.map((m) => this.inflight.get(m.feed)).filter((p): p is Promise<boolean> => Boolean(p));
    if (joining.length) {
      await Promise.all(joining);
      return this.ensureFresh(lane, markets, signer, now);
    }
    const p = this.push(stale, signer, `lane ${lane} execution`);
    for (const m of stale) this.inflight.set(m.feed, p);
    try {
      return await p;
    } finally {
      for (const m of stale) if (this.inflight.get(m.feed) === p) this.inflight.delete(m.feed);
    }
  }

  /** interval mode: keep all feeds ≤ intervalS old while there is anything to price. */
  async tick(head: Head, pendingOrders: () => boolean): Promise<void> {
    if (this.mode !== "interval") return;
    if (!pendingOrders()) {
      const oi = await Promise.all(
        this.ctx.markets.map((m) =>
          this.ctx.chain.client.readContract({ address: this.ctx.dep.clearinghouse, abi: clearinghouseAbi, functionName: "openInterest", args: [m.id] }).then((r) => (r as readonly [bigint, bigint]), () => [BigInt(1), BigInt(0)] as const),
        ),
      );
      if (oi.every(([l, s]) => l === BigInt(0) && s === BigInt(0))) return; // idle: nothing to price
    }
    // Judge by Pyth storage (what every lane and every `[]` call falls back on).
    const stored = await Promise.all(
      this.ctx.markets.map((m) =>
        this.ctx.chain.client.readContract({ address: this.ctx.dep.pyth, abi: pythAbi, functionName: "getPriceUnsafe", args: [m.feed] }).then((p) => Number(p.publishTime), () => 0),
      ),
    );
    const stale = this.ctx.markets.filter((_, i) => head.timestamp - stored[i] >= this.intervalS);
    if (stale.length === 0 || stale.some((m) => this.inflight.has(m.feed))) return;
    const signer = this.ctx.roles.ops ?? this.ctx.roles.keepers[head.number % LANES];
    const p = this.push(this.ctx.markets, signer, "interval");
    for (const m of this.ctx.markets) this.inflight.set(m.feed, p);
    try {
      await p;
    } finally {
      for (const m of this.ctx.markets) if (this.inflight.get(m.feed) === p) this.inflight.delete(m.feed);
    }
  }

  private async push(markets: MarketInfo[], signer: LocalAccount, why: string): Promise<boolean> {
    try {
      const u = await this.ctx.hermes.latest(markets.map((m) => m.feed));
      const fee = await updateFee(this.ctx, u.data);
      const data = encodeFunctionData({ abi: pythAbi, functionName: "updatePriceFeeds", args: [u.data] }) as Hex;
      const est = await estimate(this.ctx, { from: signer.address, to: this.ctx.dep.pyth, data, value: fee });
      if (!est.ok) throw new Error(`updatePriceFeeds does not simulate: ${est.revert.message}`);
      const tx = await sendTracked(this.ctx, this.ledger, signer, { to: this.ctx.dep.pyth, data, value: fee, gas: est.gas }, { kind: "pythPush", lane: null, meta: { why, feeds: markets.map((m) => m.symbol) } });
      const { receipt } = await waitForReceipt(this.ctx.chain.client, tx.hash, { pollMs: this.ctx.config.receiptPollMs, timeoutMs: this.ctx.config.receiptTimeoutMs });
      if (receipt.status !== "success") throw new Error(`push ${tx.hash} reverted`);
      this.stats.pushes++;
      this.stats.feedsPushed += markets.length;
      this.stats.gasLimit += est.gas;
      this.stats.lastPushAt = Date.now();
      return true;
    } catch (err) {
      this.stats.failures++;
      this.stats.lastError = short(err);
      console.warn(`[pricepush] ${why}: ${short(err)}`);
      return false;
    }
  }

  status() {
    return { mode: this.mode, maxStoredPriceAge: this.maxAge, marginS: this.marginS, intervalS: this.mode === "interval" ? this.intervalS : null, ...this.stats, gasLimit: this.stats.gasLimit.toString() };
  }
}
