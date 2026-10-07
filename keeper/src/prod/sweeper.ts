// Production auction sweeper: the fair-liquidation auction path of the demo
// (docs/FAIR_LIQUIDATION_PLAN.md), now with VERIFIED Pyth prices — every auction tx carries a
// fresh Hermes update that the contract verifies on chain.
//
// Every SWEEPER_MIN_INTERVAL_MS (on a new head), one Hermes `latest` update for all markets, then
// for each of the 8 lanes concurrently, from that lane's keeper key:
//   1. views at fresh prices: `eth_simulateV1` runs [pyth.updatePriceFeeds(update), lane views…]
//      in one simulated block, so liquidatable / health numbers use the same prices the tx will
//      (node without eth_simulateV1 → plain views on the stored on-chain price, and every tx is
//      still simulated with the update before it is sent);
//   2. cancelAuction(account, update)            for in-auction accounts cured per v2: equity ≥
//                                                CURE_BUFFER_BPS (110 %) × maintenance, and not in the
//                                                auction's start block;
//   3. startAuctions(lane, accounts, update)     for newly liquidatable accounts;
//   4. backstopTakeBatch(lane, accounts, update) for auctions at/above the lane pool's min discount
//      (sent only when a simulation says the pool takes ≥ 1);
//   5. expireBatch(lane, accounts, update)       for auctions at MAX discount.
// Batches are CHUNKED by measured gas (R2-09: startAuctions ≈ 57.5k gas per account,
// backstopTakeBatch ≈ 75.5k, so a 30M-gas tx holds only ~400–520 accounts): chunk size =
// (KEEPER_MAX_TX_GAS × KEEPER_BATCH_HEADROOM − base) / per-account gas; each chunk is estimated and
// halved again if its estimate is still above the target; per-account gas is re-learnt from every
// receipt. View calls are chunked too (SWEEPER_SIM_CALLS per eth_simulateV1 request).
// Cure / expiry rules are switchable without code changes: the cure line is
// CURE_BUFFER_BPS read from the contract (v2: 110 % of maintenance; absent → 100 %), overridable
// with SWEEPER_CURE_BPS.
// Accounts a batch cannot price are skipped on chain with `AccountSkipped` (v2): that is an
// alert (`auction:skipped:<lane>`), not a failure. LaneInsolvent reverts page `lane:insolvent:<lane>`.
// No demo takers, no naive design, no synthetic crash on mainnet. Monad's RPC rejects
// eth_call blockOverrides, so decisions are made on block N's discount (conservative: the tx
// lands later, at a higher discount).

import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from "viem";
import { clearinghouseAbi, pythAbi } from "./abi";
import { envNum, LANES } from "./config";
import { short, updateFee, type ProdContext } from "./context";
import type { Head } from "./head";
import type { PriceUpdate } from "./hermes";
import { estimate, sendTracked, type ProdTx, type TxKind, type TxLedger } from "./tx";

const PAGE = 150;

type BatchKind = "startAuctions" | "backstopTakeBatch" | "expireBatch";
/** Per-account gas (R2-09; measured 73.7k start / 94.8k take on a 600-account lane) and a fixed per-tx base (Pyth verification + overhead). */
const PER_ACCOUNT_DEFAULT: Record<BatchKind, number> = { startAuctions: 74_000, backstopTakeBatch: 95_000, expireBatch: 80_000 }; // measured: 600-account lane, rehearse:mainnet scale leg
const BASE_DEFAULT = 300_000;

interface LaneView {
  liquidatable: Address[];
  auction: Address[];
  /** per in-auction account: [active, startBlock, discountBps] and [equity, mm] */
  state: Map<string, { active: boolean; startBlock: number; equity: bigint; mm: bigint }>;
}

export class ProdSweeper {
  private lastSweepAt = 0;
  private readonly inflight = new Map<number, ProdTx[]>();
  private simulateV1: boolean | null = null;
  private params: { stepBps: number; maxBps: number; minBps: number[]; cureBps: number } | null = null;
  /** Learnt per-account gas per batch kind (starts at the measured defaults, env-overridable). */
  readonly perAccount: Record<BatchKind, number> = {
    startAuctions: envNum("GAS_PER_ACCOUNT_START", PER_ACCOUNT_DEFAULT.startAuctions),
    backstopTakeBatch: envNum("GAS_PER_ACCOUNT_TAKE", PER_ACCOUNT_DEFAULT.backstopTakeBatch),
    expireBatch: envNum("GAS_PER_ACCOUNT_EXPIRE", PER_ACCOUNT_DEFAULT.expireBatch),
  };
  private readonly headroom = envNum("KEEPER_BATCH_HEADROOM", 0.8);
  private readonly simCalls = Math.max(10, Math.floor(envNum("SWEEPER_SIM_CALLS", 100)));
  stats = {
    ticks: 0,
    sent: 0,
    failures: 0,
    lastError: null as string | null,
    lastBlock: -1,
    liquidatable: 0,
    inAuction: 0,
    method: "pending" as "pending" | "eth_simulateV1" | "stored-price views",
    chunkedBatches: 0,
  };

  constructor(
    private readonly ctx: ProdContext,
    private readonly ledger: TxLedger,
  ) {}

  async tick(head: Head): Promise<void> {
    if (Date.now() - this.lastSweepAt < this.ctx.config.sweeperMinIntervalMs) return;
    this.lastSweepAt = Date.now();
    this.stats.ticks++;
    this.stats.lastBlock = head.number;
    if (!this.params || this.stats.ticks % 100 === 1) await this.refreshParams();
    let update: PriceUpdate;
    try {
      update = await this.ctx.hermes.latest(this.ctx.markets.map((m) => m.feed));
    } catch (err) {
      this.stats.lastError = `hermes: ${short(err)}`;
      return; // HermesClient alerts on sustained outages
    }
    const fee = await updateFee(this.ctx, update.data);
    const views = await Promise.all(
      Array.from({ length: LANES }, (_, lane) =>
        this.view(lane, update, fee).catch((err: unknown) => {
          this.err(`lane ${lane} view: ${short(err)}`);
          return null;
        }),
      ),
    );
    this.stats.liquidatable = views.reduce((s, v) => s + (v?.liquidatable.length ?? 0), 0);
    this.stats.inAuction = views.reduce((s, v) => s + (v?.auction.length ?? 0), 0);
    await Promise.all(
      views.map((v, lane) => (v ? this.act(lane, v, update, fee, head).catch((err: unknown) => this.err(`lane ${lane}: ${short(err)}`)) : null)),
    );
  }

  private async refreshParams(): Promise<void> {
    const r = (fn: string, args: unknown[] = []) =>
      this.ctx.chain.client
        .readContract({ address: this.ctx.dep.clearinghouse, abi: clearinghouseAbi as never, functionName: fn as never, args: args as never })
        .then((v) => Number(v as bigint), () => null);
    const [step, max, cure, ...mins] = await Promise.all([
      r("auctionStepBps"),
      r("auctionMaxDiscountBps"),
      r("CURE_BUFFER_BPS"),
      ...Array.from({ length: LANES }, (_, lane) => r("backstopMinDiscountBps", [lane])),
    ]);
    const cureOverride = process.env.SWEEPER_CURE_BPS ? Number(process.env.SWEEPER_CURE_BPS) : null;
    // v2 exposes CURE_BUFFER_BPS (11,000 = 110 %); a contract without it cures at maintenance.
    this.params = { stepBps: step ?? 25, maxBps: max ?? 500, minBps: mins.map((m) => m ?? 75), cureBps: cureOverride ?? cure ?? 10_000 };
  }

  // -------------------------------------------------------------------------
  // fresh-price views
  // -------------------------------------------------------------------------

  /** Run view calls after `pyth.updatePriceFeeds(update)` in one simulated block (eth_simulateV1). */
  private async simulate(update: PriceUpdate, fee: bigint, calls: Array<{ fn: string; args: unknown[] }>): Promise<unknown[] | null> {
    if (this.simulateV1 === false) return null;
    const from = this.ctx.roles.keepers[0].address;
    const pythCall = {
      from,
      to: this.ctx.dep.pyth,
      data: encodeFunctionData({ abi: pythAbi, functionName: "updatePriceFeeds", args: [update.data] }),
      value: `0x${fee.toString(16)}`,
    };
    const viewCalls = calls.map((c) => ({
      from,
      to: this.ctx.dep.clearinghouse,
      data: encodeFunctionData({ abi: clearinghouseAbi, functionName: c.fn, args: c.args } as unknown as Parameters<typeof encodeFunctionData>[0]),
    }));
    try {
      const res = (await this.ctx.chain.client.request({
        method: "eth_simulateV1" as never,
        params: [{ blockStateCalls: [{ calls: [pythCall, ...viewCalls] }], validation: false }, "latest"] as never,
      })) as Array<{ calls: Array<{ status: string; returnData: Hex }> }>;
      const out = res[0].calls;
      if (out[0].status !== "0x1") throw new Error("pyth.updatePriceFeeds failed in simulation");
      this.simulateV1 = true;
      this.stats.method = "eth_simulateV1";
      return out.slice(1).map((r, i) =>
        r.status === "0x1"
          ? decodeFunctionResult({ abi: clearinghouseAbi, functionName: calls[i].fn, data: r.returnData } as unknown as Parameters<typeof decodeFunctionResult>[0])
          : null,
      );
    } catch (err) {
      // Only a node that doesn't know the method disables this path for good; anything else
      // (a transient RPC error, a rejected update) just falls back for this sweep.
      if (this.simulateV1 === null && /not (found|supported|available)|unknown method|-32601|does not exist/i.test(short(err))) {
        this.simulateV1 = false;
        this.stats.method = "stored-price views";
        console.warn(`[sweeper] eth_simulateV1 unavailable (${short(err)}): views use the stored Pyth price; txs are still simulated with the fresh update`);
      }
      return null;
    }
  }

  /** simulate() in chunks of SWEEPER_SIM_CALLS calls (each chunk re-applies the Pyth update). */
  private async simulateChunked(update: PriceUpdate, fee: bigint, calls: Array<{ fn: string; args: unknown[] }>): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let i = 0; i < calls.length; i += this.simCalls) {
      const part = calls.slice(i, i + this.simCalls);
      const sim = await this.simulate(update, fee, part);
      out.push(...(sim ?? (await Promise.all(part.map((c) => this.read<unknown>(c.fn, c.args).catch(() => null))))));
    }
    return out;
  }

  private async read<T>(fn: string, args: unknown[]): Promise<T> {
    return (await this.ctx.chain.client.readContract({
      address: this.ctx.dep.clearinghouse,
      abi: clearinghouseAbi as never,
      functionName: fn as never,
      args: args as never,
    })) as T;
  }

  private async view(lane: number, update: PriceUpdate, fee: bigint): Promise<LaneView> {
    const count = Number(await this.read<bigint>("laneAccountCount", [lane]));
    if (count === 0) return { liquidatable: [], auction: [], state: new Map() };
    const pages = (fn: string, n: number) => {
      const out: Array<{ fn: string; args: unknown[] }> = [];
      for (let o = 0; o < n; o += PAGE) out.push({ fn, args: [lane, BigInt(o), BigInt(PAGE)] });
      return out;
    };
    const stats = await this.read<readonly bigint[]>("auctionStats", [lane]);
    const listLen = Number(stats[0]);
    const calls = [...pages("getLiquidatableAccounts", count), ...pages("getAuctionAccounts", listLen)];
    const results = await this.simulateChunked(update, fee, calls);
    const liqPages = Math.ceil(count / PAGE);
    const liquidatable = results.slice(0, liqPages).flatMap((r) => (r as Address[] | null) ?? []);
    const auction = results.slice(liqPages).flatMap((r) => (r as Address[] | null) ?? []);
    const state = new Map<string, { active: boolean; startBlock: number; equity: bigint; mm: bigint }>();
    if (auction.length) {
      const c2 = auction.flatMap((a) => [
        { fn: "auctionOf", args: [a] },
        { fn: "accountHealth", args: [a] },
      ]);
      const r2 = await this.simulateChunked(update, fee, c2);
      auction.forEach((a, i) => {
        const ao = r2[2 * i] as readonly [boolean, bigint, number] | null;
        const h = r2[2 * i + 1] as readonly [bigint, bigint, bigint, bigint] | null;
        if (!ao || !h) return;
        state.set(a.toLowerCase(), { active: ao[0], startBlock: Number(ao[1]), equity: h[0], mm: h[1] });
      });
    }
    return { liquidatable: liquidatable.filter((a) => !auction.some((b) => b.toLowerCase() === a.toLowerCase())), auction, state };
  }

  // -------------------------------------------------------------------------
  // actions
  // -------------------------------------------------------------------------

  private async act(lane: number, v: LaneView, update: PriceUpdate, fee: bigint, head: Head): Promise<void> {
    if ((this.inflight.get(lane) ?? []).some((t) => t.status === "pending")) return; // one batch per lane in flight
    const p = this.params!;
    const disc = (start: number) => Math.min(p.maxBps, p.stepBps * Math.max(0, head.number - start));
    const cured: Address[] = [];
    const takeCands: Address[] = [];
    const atMax: Address[] = [];
    for (const a of v.auction) {
      const s = v.state.get(a.toLowerCase());
      if (!s || !s.active) continue;
      // v2 cure: equity ≥ ceil(mm × CURE_BUFFER_BPS / 10_000), and the tx must land after the
      // start block (it lands at ≥ head + 1 > startBlock whenever startBlock ≤ head).
      const cureLine = (s.mm * BigInt(p.cureBps) + BigInt(9_999)) / BigInt(10_000);
      if (s.equity >= cureLine && s.startBlock <= head.number) {
        cured.push(a);
        continue;
      }
      if (s.equity >= s.mm) continue; // healthy but below the cure buffer: nothing to do this block
      const d = disc(s.startBlock);
      if (d >= p.minBps[lane]) takeCands.push(a);
      if (d >= p.maxBps) atMax.push(a);
    }
    const actions: Array<{ kind: TxKind; data: Hex; accounts: Address[] }> = [];
    for (const a of cured) {
      actions.push({ kind: "cancelAuction", accounts: [a], data: encodeFunctionData({ abi: clearinghouseAbi, functionName: "cancelAuction", args: [a, update.data] }) });
    }
    if (v.liquidatable.length) {
      actions.push({
        kind: "startAuctions",
        accounts: v.liquidatable,
        data: encodeFunctionData({ abi: clearinghouseAbi, functionName: "startAuctions", args: [lane, v.liquidatable, update.data] }),
      });
    }
    if (takeCands.length) {
      actions.push({
        kind: "backstopTakeBatch",
        accounts: takeCands,
        data: encodeFunctionData({ abi: clearinghouseAbi, functionName: "backstopTakeBatch", args: [lane, takeCands, update.data] }),
      });
    }
    if (atMax.length) {
      actions.push({
        kind: "expireBatch",
        accounts: atMax,
        data: encodeFunctionData({ abi: clearinghouseAbi, functionName: "expireBatch", args: [lane, atMax, update.data] }),
      });
    }
    if (actions.length === 0) return;
    const keeper = this.ctx.roles.keepers[lane];
    const sent: ProdTx[] = [];
    for (const act of actions) {
      // Batches → gas-sized chunks (every chunk simulated with the fresh update first).
      let chunks: Array<{ accounts: Address[]; data: Hex; gas: bigint }>;
      try {
        chunks = act.kind === "cancelAuction" ? await this.single(act, keeper.address, fee) : await this.chunk(act.kind as BatchKind, lane, act.accounts, update, fee, keeper.address);
      } catch (err) {
        const m = short(err);
        if (/LaneInsolvent/.test(m)) {
          this.ctx.alerter.fire(`lane:insolvent:${lane}`, "critical", `lane ${lane} ${act.kind} reverts LaneInsolvent: see docs/RUNBOOK.md "Lane deficit"`);
        }
        this.err(`lane ${lane} ${act.kind} (${act.accounts.length}): ${m}`);
        continue;
      }
      for (const ch of chunks) {
        if (act.kind === "backstopTakeBatch") {
          const would = await this.ctx.chain.client
            .call({ account: keeper.address, to: this.ctx.dep.clearinghouse, data: ch.data, value: fee })
            .then((r) => (r.data && r.data.length >= 66 ? BigInt(r.data.slice(0, 66)) : BigInt(0)), () => BigInt(0));
          if (would === BigInt(0)) continue; // the pool declines (capacity) — re-offered next sweep
        }
        try {
          const tx = await sendTracked(
            this.ctx,
            this.ledger,
            keeper,
            { to: this.ctx.dep.clearinghouse, data: ch.data, value: fee, gas: ch.gas },
            { kind: act.kind, lane, meta: { accounts: ch.accounts.length, chunks: chunks.length, decidedAtBlock: head.number } },
            (t) => {
              if (t.status !== "success") {
                this.err(`lane ${lane} ${act.kind} ${t.status} (${t.hash})`);
                this.ctx.alerter.fire(`auction:failed:lane${lane}`, "critical", `lane ${lane} ${act.kind} tx ${t.status} (${t.hash})`);
                return;
              }
              this.ctx.alerter.resolve(`auction:failed:lane${lane}`);
              this.learn(act.kind, ch.accounts.length, t.gasUsed);
              // AccountSkipped is reported by the monitor's log scan (every tx, not only ours).
            },
          );
          sent.push(tx);
          this.stats.sent++;
          if (chunks.length > 1) this.stats.chunkedBatches++;
        } catch (err) {
          this.err(`lane ${lane} ${act.kind} send: ${short(err)}`);
        }
      }
    }
    if (sent.length) this.inflight.set(lane, sent);
  }

  private get target(): number {
    return Math.floor(Number(this.ctx.config.maxTxGas) * this.headroom);
  }

  private async single(act: { kind: TxKind; data: Hex; accounts: Address[] }, from: Address, fee: bigint) {
    const est = await estimate(this.ctx, { from, to: this.ctx.dep.clearinghouse, data: act.data, value: fee });
    if (!est.ok) throw new Error(est.revert.message);
    return [{ accounts: act.accounts, data: act.data, gas: est.gas }];
  }

  /** Split `accounts` into chunks whose estimated gas is ≤ the target (30M × headroom). */
  async chunk(kind: BatchKind, lane: number, accounts: Address[], update: PriceUpdate, fee: bigint, from: Address) {
    const size = Math.max(1, Math.floor((this.target - BASE_DEFAULT) / this.perAccount[kind]));
    const out: Array<{ accounts: Address[]; data: Hex; gas: bigint }> = [];
    for (let i = 0; i < accounts.length; i += size) out.push(...(await this.fit(kind, lane, accounts.slice(i, i + size), update, fee, from)));
    return out;
  }

  private async fit(kind: BatchKind, lane: number, accounts: Address[], update: PriceUpdate, fee: bigint, from: Address): Promise<Array<{ accounts: Address[]; data: Hex; gas: bigint }>> {
    const data = encodeFunctionData({ abi: clearinghouseAbi, functionName: kind, args: [lane, accounts, update.data] });
    const est = await estimate(this.ctx, { from, to: this.ctx.dep.clearinghouse, data, value: fee });
    const tooBig = est.ok ? Number(est.gas) > this.target : /gas|out of/i.test(est.revert.message);
    if (tooBig && accounts.length > 1) {
      // Re-size from the estimate itself (e.g. 412 accounts → 30.6M → chunks of 307), else halve.
      const size = est.ok ? Math.max(1, Math.floor(accounts.length * (this.target / Number(est.gas)) * 0.95)) : Math.ceil(accounts.length / 2);
      const parts: Array<{ accounts: Address[]; data: Hex; gas: bigint }> = [];
      for (let i = 0; i < accounts.length; i += size) parts.push(...(await this.fit(kind, lane, accounts.slice(i, i + size), update, fee, from)));
      return parts;
    }
    if (!est.ok) throw new Error(est.revert.message);
    if (est.gas > this.ctx.config.maxTxGas) throw new Error(`a single-account ${kind} needs ${est.gas} gas > the per-tx limit`);
    return [{ accounts, data, gas: est.gas }];
  }

  /** Re-learn per-account gas from receipts of batches large enough for the base to wash out. */
  private learn(kind: TxKind, n: number, gasUsed: bigint | null): void {
    if (gasUsed === null || n < 20 || !(kind in this.perAccount)) return;
    const k = kind as BatchKind;
    const observed = (Number(gasUsed) - BASE_DEFAULT) / n;
    if (observed <= 0) return;
    this.perAccount[k] = Math.max(Math.round(0.8 * PER_ACCOUNT_DEFAULT[k]), Math.round(0.7 * this.perAccount[k] + 0.3 * observed * 1.1));
  }

  private err(msg: string): void {
    this.stats.failures++;
    if (msg !== this.stats.lastError) console.warn(`[sweeper] ${msg}`);
    this.stats.lastError = msg;
  }

  status() {
    return { ...this.stats, params: this.params, chunking: { targetGas: this.target, headroom: this.headroom, perAccountGas: this.perAccount, simCalls: this.simCalls } };
  }
}
