// Auction sweeper (docs/FAIR_LIQUIDATION_PLAN.md §Keeper additions): every new block, for every
// lane concurrently, from that lane's keeper key:
//   1. cancelAuction(account)          for in-auction accounts that are healthy again (cured);
//   2. startAuctions(lane, accounts)   for newly liquidatable accounts;
//   3. backstopTakeBatch(lane, …)      for auctions whose discount in the NEXT block (where the tx
//                                      lands) reaches the lane pool's minDiscountBps — sent only when
//                                      an eth_call of the batch at that block says the pool takes ≥1;
//   4. expireBatch(lane, …)            for auctions at MAX in the next block; it follows the take tx
//                                      (same key, next nonce), so it closes only what the pool left.
// Plus, when demo takers are configured (takers.ts — keeper-run bots, labelled as such):
//   5. take(account)                   from a same-lane demo taker once the discount it would really
//                                      be paid (capped at the trader's equity) reaches its reservation
//                                      and an eth_call of the take succeeds; those accounts are left
//                                      out of the pool / expire batches of that block;
//   6. closePosition(market)           the block after, for every leg a taker inherited.
// Both designs (lane-sharded and the naive baseline) are swept the same way when deployed, so the
// X-ray compares identical logic.
//
// Nonce safety: each lane keeper key has one TxSender (local nonce counter under a lock); the
// naive and paraclr txs of lane i share keeper[i] and simply get consecutive nonces. A (design,
// lane) with a tx still unmined is skipped until it is mined, so nothing is sent twice.
//
// Reads are pinned to the head block number N, so the decision for block N+1 is made on N's state.

import {
  decodeFunctionResult,
  encodeFunctionData,
  parseEventLogs,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type Log,
  type TransactionReceipt,
} from "viem";
import { abis, type DesignName, type DesignRef, type KeeperContext } from "./context";
import { keeperForLane, LANE_COUNT } from "./network";
import { estimateLimit, waitForReceipts } from "./sender";
import type { DemoTaker, DemoTakerSet } from "./takers";

export type SweepKind = "startAuctions" | "backstopTakeBatch" | "expireBatch" | "cancelAuction" | "take" | "closePosition";

export interface SweepTx {
  design: DesignName;
  contract: Address;
  lane: number;
  kind: SweepKind;
  accounts: Address[];
  keeper: Address;
  hash: Hex;
  gasLimit: bigint;
  /** Head block the decision was made on (the tx targets the next block). */
  decidedAtBlock: number;
  submittedAt: number;
  block: number | null;
  confirmedAt: number | null;
  status: "pending" | "success" | "reverted" | "lost";
  gasUsed: bigint | null;
  logs: Log[];
}

export interface DesignScan {
  block: number;
  /** Liquidatable and not yet in auction. */
  liquidatable: number;
  inAuction: number;
  /** Sweeper txs for this design not mined yet. */
  pending: number;
}

export interface AuctionParams {
  stepBps: number;
  maxBps: number;
  minDiscountBps: number[]; // per lane
  source: "contract" | "config";
}

/** Collects every sweeper tx sent while it is open (crash runs). */
export class Capture {
  readonly txs: SweepTx[] = [];
  open = true;
  close(): SweepTx[] {
    this.open = false;
    return this.txs;
  }
}

const PAGE = 250;
const RECENT = 200;
const COUNT_TTL = 10;

function laneKey(d: DesignName, lane: number) {
  return `${d}:${lane}`;
}
function acctKey(d: DesignName, a: Address) {
  return `${d}:${a.toLowerCase()}`;
}
/** In-flight key of a demo taker's own txs (prefix `${design}:` so pendingFor counts them). */
function takerKey(d: DesignName, t: DemoTaker) {
  return `${d}:${t.lane}:taker:${t.address.toLowerCase()}`;
}

interface Action {
  kind: SweepKind;
  accounts: Address[];
  data: Hex;
  /** Sender: the lane keeper, or a demo taker. */
  from: "keeper" | DemoTaker;
}

export class Sweeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;
  private paused = false;
  private pauseReason: string | null = null;
  private lastBlock = -1;
  private readonly inflight = new Map<string, SweepTx[]>();
  private readonly captures = new Set<Capture>();
  private readonly startBlocks = new Map<string, number>();
  /** Per design: does the node apply eth_call/eth_estimateGas blockOverrides (probed once)? */
  private readonly nextBlock = new Map<DesignName, boolean>();
  private readonly nextBlockProbe = new Map<DesignName, Promise<boolean>>();
  private readonly params = new Map<DesignName, AuctionParams>();
  private paramsAt = -1;
  readonly scans = new Map<DesignName, DesignScan>();
  /** ms epoch when this process first saw each block number (keeper-side clock). */
  readonly blockSeenAt = new Map<number, number>();
  /** First block the sweeper saw each account liquidatable (outside crash runs: time underwater). */
  readonly firstSeen = new Map<string, number>();
  readonly recent: SweepTx[] = [];
  private stats = { ticks: 0, sent: 0, failures: 0, lastError: null as string | null, lastTickMs: 0 };

  /** Demo external takers (null = none) and, per design, the legs each one still has to close. */
  private takerSet: DemoTakerSet | null = null;
  private readonly holdings = new Map<string, Hex[] | null>();

  /** Lane account counts (pagination of getLiquidatableAccounts), refreshed every COUNT_TTL ticks. */
  private readonly counts = new Map<string, { n: number; tick: number }>();
  private lastSweepAt = 0;

  /**
   * `designs`: everything this sweeper may act on. The naive baseline (if listed) is swept only
   * while a crash run is capturing, unless SWEEP_NAIVE=always.
   */
  constructor(
    private readonly ctx: KeeperContext,
    readonly designs: DesignRef[] = ctx.designs.filter((d) => d.label === "paraclr" || ctx.config.sweepNaive !== "off"),
  ) {}

  private get capturing(): boolean {
    for (const c of this.captures) if (c.open) return true;
    return false;
  }

  /** Designs to sweep right now. */
  activeDesigns(): DesignRef[] {
    const naiveNow = this.ctx.config.sweepNaive === "always" || (this.ctx.config.sweepNaive === "crash" && this.capturing);
    return this.designs.filter((d) => d.label === "paraclr" || naiveNow);
  }

  get enabled(): boolean {
    return this.ctx.features.auctions;
  }

  start(): void {
    if (this.timer || !this.enabled) return;
    this.timer = setInterval(() => {
      if (this.ticking || this.paused) return;
      this.ticking = this.poll()
        .catch((err: unknown) => this.fail(err))
        .finally(() => {
          this.ticking = null;
        });
    }, this.ctx.config.sweeperPollMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.idle();
  }

  /** Stop acting (legacy crash path); waits for the current tick and in-flight txs. */
  async pause(reason: string): Promise<void> {
    this.paused = true;
    this.pauseReason = reason;
    await this.idle();
  }

  resume(): void {
    this.paused = false;
    this.pauseReason = null;
  }

  /** Resolves once no tick is running and every sent tx has a receipt (or was given up on). */
  async idle(): Promise<void> {
    if (this.ticking) await this.ticking.catch(() => undefined);
    for (;;) {
      const pending = [...this.inflight.values()].flat().filter((t) => t.status === "pending");
      if (pending.length === 0) return;
      await new Promise((r) => setTimeout(r, this.ctx.config.receiptPollMs));
    }
  }

  capture(): Capture {
    const c = new Capture();
    this.captures.add(c);
    this.counts.clear(); // fresh lane counts for the run
    for (const old of this.captures) if (!old.open) this.captures.delete(old);
    return c;
  }

  /** Install (or remove, with null) the demo takers. Holdings are re-read from chain lazily. */
  setTakers(set: DemoTakerSet | null): void {
    this.takerSet = set;
    this.holdings.clear();
  }

  get takers(): DemoTakerSet | null {
    return this.takerSet;
  }

  /** Demo takers of `design` still holding inherited legs (unknown counts as holding). */
  takersHolding(design: DesignName): number {
    if (!this.takerSet) return 0;
    return this.takerSet.takers.filter((t) => {
      const h = this.holdings.get(takerKey(design, t));
      return h === null || (h !== undefined && h.length > 0);
    }).length;
  }

  /** What a RunReport says about external takers in this process. */
  externalTakersInfo(): { demo: boolean; accounts: number; reservationBps: [number, number] | null } {
    const set = this.takerSet;
    if (!set) return { demo: false, accounts: 0, reservationBps: null };
    return { demo: true, accounts: set.takers.length, reservationBps: [set.config.minBps, set.config.maxBps] };
  }

  pendingFor(design: DesignName): number {
    let n = 0;
    for (const [k, txs] of this.inflight) if (k.startsWith(`${design}:`)) n += txs.filter((t) => t.status === "pending").length;
    return n;
  }

  auctionParams(design: DesignName): AuctionParams | undefined {
    return this.params.get(design);
  }

  status() {
    return {
      enabled: this.enabled,
      running: this.timer !== null,
      paused: this.paused,
      pauseReason: this.pauseReason,
      lastBlock: this.lastBlock,
      designs: this.designs.map((d) => ({
        design: d.design,
        contract: d.address,
        sweeping: this.activeDesigns().includes(d),
        ...(this.scans.get(d.design) ?? {}),
      })),
      params: Object.fromEntries([...this.params.entries()]),
      ...this.stats,
    };
  }

  private fail(err: unknown): void {
    this.stats.failures++;
    const msg = (err as Error)?.message?.split("\n")[0] ?? String(err);
    if (msg !== this.stats.lastError) console.error(`[sweeper] ${msg}`);
    this.stats.lastError = msg;
  }

  private async poll(): Promise<void> {
    if (!this.capturing && Date.now() - this.lastSweepAt < this.ctx.config.sweeperMinIntervalMs) return;
    const head = Number(await this.ctx.client.getBlockNumber());
    if (head <= this.lastBlock) return;
    this.lastSweepAt = Date.now();
    this.blockSeenAt.set(head, Date.now());
    if (this.blockSeenAt.size > 2_000) this.blockSeenAt.delete(this.blockSeenAt.keys().next().value as number);
    this.lastBlock = head;
    await this.tick(head);
  }

  /** One sweep at head block `n` (exposed for the standalone bench). */
  async tick(n: number): Promise<void> {
    const t0 = Date.now();
    this.stats.ticks++;
    if (this.paramsAt < 0 || n - this.paramsAt >= 50) await this.refreshParams(n);
    await this.refreshPending(n);
    await Promise.all(this.activeDesigns().map((d) => this.sweepDesign(d, n)));
    this.stats.lastTickMs = Date.now() - t0;
  }

  // ---------------------------------------------------------------------------
  // Auction parameters (owner-configurable on chain; config fallbacks)
  // ---------------------------------------------------------------------------

  private async refreshParams(n: number): Promise<void> {
    this.paramsAt = n;
    const { client, config } = this.ctx;
    await Promise.all(
      this.designs.map(async (d) => {
        const call = (functionName: string, args: unknown[] = []) =>
          client
            .readContract({ address: d.address, abi: abis.clearinghouse as never, functionName: functionName as never, args: args as never, blockNumber: BigInt(n) })
            .then((v) => Number(v as bigint), () => null);
        const [step, max, ...mins] = await Promise.all([
          call("auctionStepBps"),
          call("auctionMaxDiscountBps"),
          ...Array.from({ length: LANE_COUNT }, (_, lane) => call("backstopMinDiscountBps", [lane])),
        ]);
        this.params.set(d.design, {
          stepBps: step ?? config.auctionStepBps,
          maxBps: max ?? config.auctionMaxDiscountBps,
          minDiscountBps: mins.map((m) => m ?? config.backstopMinDiscountBps),
          source: step !== null && max !== null && mins.every((m) => m !== null) ? "contract" : "config",
        });
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Per design / lane
  // ---------------------------------------------------------------------------

  private async sweepDesign(d: DesignRef, n: number): Promise<void> {
    const results = await Promise.all(
      Array.from({ length: LANE_COUNT }, (_, lane) =>
        this.sweepLane(d, lane, n).catch((err: unknown) => {
          this.fail(new Error(`${d.label} lane ${lane}: ${(err as Error)?.message?.split("\n")[0] ?? err}`));
          return { liquidatable: 0, inAuction: 0 };
        }),
      ),
    );
    this.scans.set(d.design, {
      block: n,
      liquidatable: results.reduce((s, r) => s + r.liquidatable, 0),
      inAuction: results.reduce((s, r) => s + r.inAuction, 0),
      pending: this.pendingFor(d.design),
    });
  }

  private read<T>(d: DesignRef, functionName: string, args: unknown[], n: number): Promise<T> {
    return this.ctx.client.readContract({
      address: d.address,
      abi: abis.clearinghouse as never,
      functionName: functionName as never,
      args: args as never,
      blockNumber: BigInt(n),
    }) as Promise<T>;
  }

  /** All pages of a paginated lane view whose underlying list has `count` entries. */
  private async pages(d: DesignRef, fn: "getLiquidatableAccounts" | "getAuctionAccounts", lane: number, n: number, count: number) {
    const offsets = [];
    for (let o = 0; o < count; o += PAGE) offsets.push(o);
    const pages = await Promise.all(offsets.map((o) => this.read<Address[]>(d, fn, [lane, BigInt(o), BigInt(PAGE)], n)));
    return pages.flat();
  }

  private async sweepLane(d: DesignRef, lane: number, n: number): Promise<{ liquidatable: number; inAuction: number }> {
    const key = laneKey(d.design, lane);
    const params = this.params.get(d.design)!;
    const ck = laneKey(d.design, lane);
    let cached = this.counts.get(ck);
    if (!cached || this.stats.ticks - cached.tick >= COUNT_TTL) {
      cached = { n: Number(await this.read<bigint>(d, "laneAccountCount", [lane], n)), tick: this.stats.ticks };
      this.counts.set(ck, cached);
    }
    const count = cached.n;
    if (count === 0) return { liquidatable: 0, inAuction: 0 };
    // auctionStats(lane).active = length of the lane's auction list (naive: the SHARED list, which
    // getAuctionAccounts pages and filters to `lane`, so a short page does not mean "done").
    const [liq, stats] = await Promise.all([
      this.pages(d, "getLiquidatableAccounts", lane, n, count),
      this.read<readonly [bigint, bigint, bigint, bigint, bigint]>(d, "auctionStats", [lane], n),
    ]);
    const listLen = Number(stats[0]);
    const auction = listLen === 0 ? [] : await this.pages(d, "getAuctionAccounts", lane, n, listLen);
    const inAuction = new Set(auction.map((a) => a.toLowerCase()));
    const fresh = liq.filter((a) => !inAuction.has(a.toLowerCase()));
    for (const a of liq) if (!this.firstSeen.has(acctKey(d.design, a))) this.firstSeen.set(acctKey(d.design, a), n);
    const result = { liquidatable: fresh.length, inAuction: auction.length };

    // Busy lane keeper: decisions on N would duplicate what is still in flight.
    const keeperBusy = (this.inflight.get(key) ?? []).some((t) => t.status === "pending");
    const laneTakers = (this.takerSet?.takers ?? []).filter((t) => t.lane === lane);
    const takerBusy = (t: DemoTaker) => (this.inflight.get(takerKey(d.design, t)) ?? []).some((x) => x.status === "pending");
    await this.loadHoldings(d, laneTakers.filter((t) => !takerBusy(t)), n);
    const actions: Action[] = [];

    // 6. Takers close what they inherited (positions exist at N, so plain estimates are exact).
    for (const t of laneTakers) {
      const h = this.holdings.get(takerKey(d.design, t));
      if (takerBusy(t) || !h || h.length === 0) continue;
      for (const m of h) actions.push({ kind: "closePosition", accounts: [], data: this.encode("closePosition", [m]), from: t });
    }
    if (auction.length === 0 && fresh.length === 0) {
      await this.send(d, lane, n, actions);
      return result;
    }

    // Auction state of every in-auction account (start block cached; health read each block).
    const [starts, health] = await Promise.all([
      Promise.all(
        auction.map(async (a) => {
          const k = acctKey(d.design, a);
          let s = this.startBlocks.get(k);
          if (s === undefined) {
            const [active, startBlock] = await this.read<readonly [boolean, bigint, number]>(d, "auctionOf", [a], n);
            s = active ? Number(startBlock) : -1;
            if (active) this.startBlocks.set(k, s);
          }
          return s;
        }),
      ),
      Promise.all(auction.map((a) => this.read<readonly [bigint, bigint, bigint, bigint]>(d, "accountHealth", [a], n))),
    ]);
    const disc = (start: number, block: number) => Math.min(params.maxBps, params.stepBps * Math.max(0, block - start));

    // Decide for the block the txs land in (N+1) when the node can simulate it (blockOverrides),
    // else conservatively on N's own discount (lands later, at a higher discount).
    const firstActive = auction.findIndex((_, i) => starts[i] >= 0);
    const nextOk = firstActive >= 0 ? await this.nextBlockSupported(d, auction[firstActive], starts[firstActive], n) : false;
    const at = nextOk ? n + 1 : n;

    const cured: Address[] = [];
    const live: Array<{ a: Address; start: number; equity: bigint; notional: bigint }> = [];
    auction.forEach((a, i) => {
      const s = starts[i];
      if (s < 0) return; // listed but inactive (racing a resolution) — next block will tell
      const [equity, mm, , notional] = health[i];
      if (equity >= mm) return void cured.push(a);
      live.push({ a, start: s, equity, notional });
    });
    live.sort((x, y) => x.start - y.start || (x.a.toLowerCase() < y.a.toLowerCase() ? -1 : 1));

    // 5. Demo external takers bid first: lowest reservation that the payment it would really get
    //    (min(d × notional, max(equity, 0)), the contract's external-take cap) satisfies.
    const external = new Set<string>();
    if (!keeperBusy && laneTakers.length) {
      const free = laneTakers
        .filter((t) => !takerBusy(t) && (this.holdings.get(takerKey(d.design, t))?.length ?? 1) === 0)
        .sort((x, y) => x.reservationBps - y.reservationBps);
      for (const acc of live) {
        if (free.length === 0) break;
        if (acc.notional === BigInt(0)) continue;
        const dd = disc(acc.start, at);
        const pos = acc.equity > BigInt(0) ? acc.equity : BigInt(0);
        const full = (acc.notional * BigInt(dd)) / BigInt(10_000);
        const pay = full < pos ? full : pos;
        const effBps = Number((pay * BigInt(10_000)) / acc.notional);
        const i = free.findIndex((t) => t.reservationBps <= dd && t.reservationBps <= effBps);
        if (i < 0) continue;
        const t = free[i];
        const data = this.encode("take", [acc.a]);
        const sim = await this.simulate(d, data, n, nextOk, t.address);
        if (sim === null || Number((sim * BigInt(10_000)) / acc.notional) < t.reservationBps) continue;
        actions.push({ kind: "take", accounts: [acc.a], data, from: t });
        external.add(acc.a.toLowerCase());
        free.splice(i, 1);
      }
    }

    if (!keeperBusy) {
      const takeCands: Address[] = [];
      const atMax: Address[] = [];
      for (const acc of live) {
        if (external.has(acc.a.toLowerCase())) continue;
        if (disc(acc.start, at) >= params.minDiscountBps[lane]) takeCands.push(acc.a);
        if (disc(acc.start, at) >= params.maxBps) atMax.push(acc.a);
      }
      // The pool's capacity check gets easier as the discount grows (the payment adds to its
      // equity), so declined accounts are re-offered every block — but a tx is only sent when an
      // eth_call of the same batch says the pool would take at least one of them.
      let take: Address[] = [];
      if (takeCands.length) {
        const would = await this.simulate(d, this.encode("backstopTakeBatch", [lane, takeCands]), n, nextOk);
        if (would !== null && would > BigInt(0)) take = takeCands;
      }
      for (const a of cured) {
        actions.push({ kind: "cancelAuction", accounts: [a], data: this.encode("cancelAuction", [a]), from: "keeper" });
      }
      if (fresh.length) actions.push({ kind: "startAuctions", accounts: fresh, data: this.encode("startAuctions", [lane, fresh]), from: "keeper" });
      if (take.length) actions.push({ kind: "backstopTakeBatch", accounts: take, data: this.encode("backstopTakeBatch", [lane, take]), from: "keeper" });
      // Whatever is at MAX and not taken by the take tx just before it (same key, lower nonce) expires.
      if (atMax.length) actions.push({ kind: "expireBatch", accounts: atMax, data: this.encode("expireBatch", [lane, atMax]), from: "keeper" });
    }
    await this.send(d, lane, n, actions);
    return result;
  }

  /** Read each taker's open markets on `d` where unknown (startup, after a failed close). */
  private async loadHoldings(d: DesignRef, takers: DemoTaker[], n: number): Promise<void> {
    await Promise.all(
      takers.map(async (t) => {
        const k = takerKey(d.design, t);
        const h = this.holdings.get(k);
        if (h !== undefined && h !== null) return;
        try {
          const acct = await this.read<readonly [bigint, number, boolean, readonly Hex[]]>(d, "getAccount", [t.address], n);
          this.holdings.set(k, [...acct[3]]);
        } catch {
          this.holdings.set(k, null);
        }
      }),
    );
  }

  /** Sign and send `actions`: keeper actions in order from the lane key, taker actions from each taker. */
  private async send(d: DesignRef, lane: number, n: number, actions: Action[]): Promise<void> {
    if (actions.length === 0) return;
    const groups = new Map<string, Action[]>();
    for (const a of actions) {
      const k = a.from === "keeper" ? laneKey(d.design, lane) : takerKey(d.design, a.from);
      groups.set(k, [...(groups.get(k) ?? []), a]);
    }
    await Promise.all(
      [...groups.entries()].map(async ([key, acts]) => {
        const from = acts[0].from;
        const account = from === "keeper" ? keeperForLane(this.ctx.roles, lane) : from.account;
        const sender = this.ctx.senders.for(account);
        const sent: SweepTx[] = [];
        for (const act of acts) {
          let chunks: Array<{ accounts: Address[]; data: Hex; gasLimit: bigint }>;
          try {
            chunks = await this.plan(d, lane, act, n, account.address);
          } catch (err) {
            this.fail(new Error(`${d.label} lane ${lane} ${act.kind}: estimate failed: ${(err as Error)?.message?.split("\n")[0] ?? err}`));
            continue;
          }
          for (const chunk of chunks) {
            try {
              const sub = await sender.send({ to: d.address, data: chunk.data, gas: chunk.gasLimit });
              const tx: SweepTx = {
                design: d.design,
                contract: d.address,
                lane,
                kind: act.kind,
                accounts: chunk.accounts,
                keeper: sender.address,
                hash: sub.hash,
                gasLimit: chunk.gasLimit,
                decidedAtBlock: n,
                submittedAt: sub.submittedAt,
                block: null,
                confirmedAt: null,
                status: "pending",
                gasUsed: null,
                logs: [],
              };
              sent.push(tx);
              this.stats.sent++;
              for (const c of this.captures) if (c.open) c.txs.push(tx);
              this.recent.push(tx);
              if (this.recent.length > RECENT) this.recent.shift();
            } catch (err) {
              this.fail(new Error(`${d.label} lane ${lane} ${act.kind}: ${(err as Error)?.message?.split("\n")[0] ?? err}`));
            }
          }
        }
        if (sent.length) {
          this.inflight.set(key, sent);
          void this.track(sent);
        }
      }),
    );
  }

  private encode(functionName: SweepKind, args: unknown[]): Hex {
    return encodeFunctionData({ abi: abis.clearinghouse, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
  }

  /**
   * Gas limit per action, split in halves above the per-tx cap. A backstop take is estimated
   * as of block N+1 (block override) because at N the pool may still be below its min discount
   * and would skip everything — a far smaller estimate than the real take.
   */
  private async plan(
    d: DesignRef,
    lane: number,
    act: Action,
    n: number,
    keeper: Address,
  ): Promise<Array<{ accounts: Address[]; data: Hex; gasLimit: bigint }>> {
    const { ctx } = this;
    const next = this.nextBlock.get(d.design) === true;
    const estimate = async (data: Hex, marginBps: number) => {
      // Takes / expiries act on the discount of the landing block: estimate there (else the
      // estimate would cover the cheap "skip" path and the real tx would run out of gas).
      if (next && (act.kind === "backstopTakeBatch" || act.kind === "expireBatch" || act.kind === "take")) {
        return estimateAt(ctx, { account: keeper, to: d.address, data }, n + 1, marginBps);
      }
      return (await estimateLimit(ctx.client, { account: keeper, to: d.address, data }, marginBps)).limit;
    };
    const go = async (accounts: Address[], marginBps: number): Promise<Array<{ accounts: Address[]; data: Hex; gasLimit: bigint }>> => {
      const batch = act.kind === "startAuctions" || act.kind === "backstopTakeBatch" || act.kind === "expireBatch";
      const data = batch ? this.encode(act.kind, [lane, accounts]) : act.data;
      const gasLimit = await estimate(data, marginBps);
      if (gasLimit <= ctx.config.maxTxGas || accounts.length <= 1 || !batch) return [{ accounts, data, gasLimit }];
      const mid = Math.ceil(accounts.length / 2);
      const m = ctx.config.gasMarginBps + 1_000;
      return [...(await go(accounts.slice(0, mid), m)), ...(await go(accounts.slice(mid), m))];
    };
    return go(act.accounts, ctx.config.gasMarginBps);
  }

  private async track(txs: SweepTx[]): Promise<void> {
    const { ctx } = this;
    const got = await waitForReceipts(
      ctx.client,
      txs.map((t) => t.hash),
      { pollMs: ctx.config.receiptPollMs, timeoutMs: ctx.config.receiptTimeoutMs },
    ).catch(() => new Map());
    for (const t of txs) {
      if (t.status !== "pending") continue; // already finished by refreshPending
      const o = got.get(t.hash);
      if (!o) {
        t.status = "lost";
        ctx.senders.for(this.senderOf(t)).resync();
        if (t.kind === "take" || t.kind === "closePosition") this.markHoldingUnknown(t);
        this.fail(new Error(`${t.design} lane ${t.lane} ${t.kind}: no receipt for ${t.hash}`));
        continue;
      }
      this.finish(t, o.receipt, o.observedAt);
    }
  }

  /**
   * At the start of a tick: fetch receipts of every pending tx decided before this block, so a
   * receipt poll that hasn't caught up yet never makes a lane skip a block.
   */
  private async refreshPending(n: number): Promise<void> {
    const pending = [...this.inflight.values()].flat().filter((t) => t.status === "pending" && t.decidedAtBlock < n);
    if (pending.length === 0) return;
    const now = Date.now();
    const rs = await Promise.all(
      pending.map((t) =>
        this.ctx.client.getTransactionReceipt({ hash: t.hash }).catch((err: unknown) => {
          if (err instanceof TransactionReceiptNotFoundError) return null;
          return null;
        }),
      ),
    );
    rs.forEach((r, i) => {
      if (r) this.finish(pending[i], r, now);
    });
  }

  private senderOf(t: SweepTx) {
    const taker = this.takerSet?.takers.find((x) => x.address.toLowerCase() === t.keeper.toLowerCase());
    return taker ? taker.account : keeperForLane(this.ctx.roles, t.lane);
  }

  private markHoldingUnknown(t: SweepTx): void {
    const taker = this.takerSet?.takers.find((x) => x.address.toLowerCase() === t.keeper.toLowerCase());
    if (taker) this.holdings.set(takerKey(t.design, taker), null);
  }

  /** Record a receipt (idempotent) and do the bookkeeping. */
  private finish(t: SweepTx, receipt: TransactionReceipt, observedAt: number): void {
    if (t.status !== "pending") return;
    t.block = Number(receipt.blockNumber);
    t.confirmedAt = observedAt;
    t.gasUsed = receipt.gasUsed;
    t.status = receipt.status === "success" ? "success" : "reverted";
    t.logs = receipt.logs.filter((l: Log) => l.address.toLowerCase() === t.contract.toLowerCase());
    if (t.status === "reverted") this.fail(new Error(`${t.design} lane ${t.lane} ${t.kind} reverted (${t.hash})`));
    this.afterReceipt(t);
  }

  /** Bookkeeping from the tx's own events. */
  private afterReceipt(t: SweepTx): void {
    const events = decodeAuctionEvents(t.logs);
    for (const e of events) {
      if (e.eventName === "AuctionTaken" || e.eventName === "AuctionCancelled" || e.eventName === "AuctionExpired") {
        const k = acctKey(t.design, e.args.account);
        this.startBlocks.delete(k);
        this.firstSeen.delete(k);
      }
    }
    if (t.kind !== "take" && t.kind !== "closePosition") return;
    const taker = this.takerSet?.takers.find((x) => x.address.toLowerCase() === t.keeper.toLowerCase());
    if (!taker) return;
    const k = takerKey(t.design, taker);
    if (t.status !== "success") return void this.holdings.set(k, null); // re-read from chain
    const pos = parseEventLogs({ abi: abis.clearinghouse, logs: t.logs, eventName: ["PositionOpened", "PositionClosed"] });
    const h = new Set(this.holdings.get(k) ?? []);
    for (const e of pos) {
      if (e.args.account.toLowerCase() !== taker.address.toLowerCase()) continue;
      if (e.eventName === "PositionOpened") h.add(e.args.marketId);
      else h.delete(e.args.marketId);
    }
    this.holdings.set(k, [...h]);
  }

  /**
   * Probe once per design whether the node honours blockOverrides: auctionOf() returns the
   * discount computed from block.number, so with {number: N+1} it must be one step higher than
   * at N. Nodes that reject the param — or silently ignore it — get the conservative path.
   */
  private nextBlockSupported(d: DesignRef, account: Address, start: number, n: number): Promise<boolean> {
    let p = this.nextBlockProbe.get(d.design);
    if (!p) {
      p = this.probeNextBlock(d, account, start, n);
      this.nextBlockProbe.set(d.design, p);
    }
    return p;
  }

  private async probeNextBlock(d: DesignRef, account: Address, start: number, n: number): Promise<boolean> {
    const params = this.params.get(d.design)!;
    let ok = false;
    try {
      const data = encodeFunctionData({ abi: abis.clearinghouse, functionName: "auctionOf", args: [account] });
      const ret = (await this.ctx.client.request({
        method: "eth_call" as never,
        params: [{ to: d.address, data }, `0x${n.toString(16)}`, {}, { number: `0x${(n + 1).toString(16)}` }] as never,
      })) as Hex;
      const [, , discount] = decodeFunctionResult({ abi: abis.clearinghouse, functionName: "auctionOf", data: ret });
      ok = Number(discount) === Math.min(params.maxBps, params.stepBps * (n + 1 - start));
    } catch {
      ok = false;
    }
    this.nextBlock.set(d.design, ok);
    console.log(`[sweeper] ${d.label}: blockOverrides ${ok ? "honoured → decisions for block N+1" : "unavailable → conservative (block N) decisions"}`);
    return ok;
  }

  /** eth_call `data` on the design as of block N (+1 via blockOverrides when `next`); uint256 result or null on revert. */
  private async simulate(d: DesignRef, data: Hex, n: number, next: boolean, from?: Address): Promise<bigint | null> {
    const caller = from ?? this.ctx.roles.keepers[0].address;
    const params: unknown[] = [{ from: caller, to: d.address, data }, `0x${n.toString(16)}`];
    if (next) params.push({}, { number: `0x${(n + 1).toString(16)}` });
    try {
      const ret = (await this.ctx.client.request({ method: "eth_call" as never, params: params as never })) as Hex;
      return ret && ret.length >= 66 ? BigInt(ret.slice(0, 66)) : null;
    } catch {
      return null;
    }
  }
}

/** estimateGas as if executed in block `number` (eth_estimateGas's 4th param, blockOverrides). */
export async function estimateAt(
  ctx: KeeperContext,
  req: { account: Address; to: Address; data: Hex },
  number: number,
  marginBps: number,
): Promise<bigint> {
  const hex = (await ctx.client.request({
    method: "eth_estimateGas" as never,
    params: [{ from: req.account, to: req.to, data: req.data }, "latest", {}, { number: `0x${number.toString(16)}` }] as never,
  })) as Hex;
  const est = BigInt(hex);
  return (est * BigInt(10_000 + marginBps) + BigInt(9_999)) / BigInt(10_000);
}

// ---------------------------------------------------------------------------
// Event decoding shared with the crash report
// ---------------------------------------------------------------------------

export function decodeAuctionEvents(logs: Log[]) {
  return parseEventLogs({
    abi: abis.clearinghouse,
    logs,
    eventName: ["AuctionStarted", "AuctionTaken", "AuctionCancelled", "AuctionExpired"],
  });
}
