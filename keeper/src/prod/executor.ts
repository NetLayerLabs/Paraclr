// Delayed-order executor (anti front-running; docs/PRODUCTION_PLAN.md "Delayed orders").
//
// A user commits an order (escrowing margin + an execution fee in MON). ParaclrClearinghouseProd
// fills it at the FIRST Pyth update of the market's feed published at/after `execAfter`
// (= commitTime + minExecDelay), no later than `deadline` (= commitTime + maxExecDelay), with
// block.timestamp in [execAfter, deadline]. A fill-level failure (slippage, margin, caps, flip…)
// does not revert: the order becomes Failed (OrderFailed) and the executor is still paid.
// Per new head, for every pending order:
//
//   1. discovery: OrderCommitted / OrderExecuted / OrderFailed / OrderCancelled logs since the last
//      scanned block (≤ KEEPER_LOG_RANGE blocks per eth_getLogs; on startup a backfill covering
//      2 × maxExecDelay);
//   2. once chain time ≥ execAfter: ask Hermes for the first update at/after execAfter
//      (`/v2/updates/price/{t}`; 404 = not published yet → next head). Deterministic → cached;
//   3. check it locally: publishTime ≤ deadline, really the first (prevPublishTime < execAfter, the
//      parsePriceFeedUpdatesUnique rule), conf/price ≤ maxConfBps;
//   4. other legs (EXEC_OTHER_LEGS): `push` (v2 default) — `priceUpdate` carries ONLY the fill
//      update and the cross-margin check prices other legs from Pyth storage or the lane's last
//      price (≤ 15 s old), so the PricePusher pushes exactly the stale feeds from the lane keeper
//      first; `append` (v3: other legs priced from the executor's update through the monotonic
//      path) — a fresh `latest` update for the other legs' feeds is appended, no push;
//   5. eth_estimateGas from the LANE's keeper key (lane = uint160(account) % 8), msg.value =
//      getUpdateFee (0 on Monad today; excess refunded). Revert decoded: not ready → retry;
//      already resolved → drop; oracle/fee problems → retry, alert after 3; LaneInsolvent → page;
//   6. send; one tx per order in flight; the 8 lanes run independently (own key, own nonce stream).
// Executors are credited in MON per lane (claimable): each keeper claims its execution fees once
// they exceed CLAIM_MIN_MON, and its AUSD expiry rewards once they exceed CLAIM_MIN_AUSD.
//
// Alerts: `exec:late:<lane>` (landed > EXEC_LATE_ALERT_S after execAfter), `exec:failed:<lane>`
// (reverted / lost / repeated simulation failures), `exec:expired:<lane>` (deadline passed while
// still pending — a keeper-side failure by construction, since user-side failures resolve as
// OrderFailed). OrderFailed outcomes are recorded, not paged.

import { decodeErrorResult, encodeFunctionData, parseEther, parseEventLogs, type Address, type Hex, type Log } from "viem";
import { envStr } from "../env";
import { clearinghouseAbi } from "./abi";
import { laneOf, short, updateFee, type ProdContext } from "./context";
import type { Head } from "./head";
import type { PriceUpdate } from "./hermes";
import { confBps } from "./pyth-wire";
import type { PricePusher } from "./pricepush";
import { estimate, sendTracked, type ProdTx, type TxLedger } from "./tx";

export type OrderState = "pending" | "waiting-price" | "sending" | "inflight" | "executed" | "failed" | "cancelled" | "expired" | "unfillable";

export interface TrackedOrder {
  id: bigint;
  account: Address;
  lane: number;
  market: Hex;
  symbol: string;
  sizeDelta: bigint;
  execAfter: number;
  deadline: number;
  commitBlock: number;
  executionFee: bigint;
  state: OrderState;
  attempts: number;
  lastError: string | null;
  update: PriceUpdate | null;
  tx: ProdTx | null;
  /** Seconds from execAfter to the execution block's timestamp. */
  latencyS: number | null;
  /** OrderExecuted.fillPrice (1e18) / OrderFailed reason selector. */
  fillPrice: bigint | null;
  failReason: string | null;
  doneAt: number | null;
}

/** executeOrder reverts that mean "not yet": retry next head. */
const RETRY_LATER = new Set(["OrderNotReady", "PriceFeedNotFoundWithinRange", "NoFreshUpdate", "IsPaused"]);
/** Expected refusals (v5): the order cannot fill as committed — record it, never page. */
const EXPECTED = new Set(["CollateralAboveCap", "BackstopPositionsOpen", "MarginAboveNotional"]);
/** The order is no longer pending (executed / failed / cancelled by someone else). */
const ALREADY_DONE = new Set(["OrderNotPending"]);
/** Oracle-side: the pinned or fresh price can't be used right now (stale, wide conf, bad data). */
const ORACLE = new Set(["PriceConfidenceTooWide", "InvalidPrice", "InvalidPythResponse", "InvalidUpdateData", "InvalidWormholeVaa", "InsufficientPythFee"]);

export class OrderExecutor {
  readonly orders = new Map<string, TrackedOrder>();
  private scannedTo = -1;
  /** Market id → symbol + CURRENT feed (read from ctx.markets each time: a timelocked feed swap updates it). */
  private symbolOf(market: string): { symbol: string; feed: Hex } | undefined {
    const m = this.ctx.markets.find((x) => x.id.toLowerCase() === market.toLowerCase());
    return m ? { symbol: m.symbol, feed: m.feed } : undefined;
  }
  stats = {
    executed: 0,
    /** Resolved as OrderFailed (fill impossible at the pinned price: slippage, margin, caps…). */
    userFailed: 0,
    expired: 0,
    unfillable: 0,
    failures: 0,
    late: 0,
    maxLatencyS: 0,
    claims: 0,
    lastError: null as string | null,
  };

  /** Every clearinghouse log the executor scans (one eth_getLogs per head) is also handed here (monitor). */
  onLogs: ((logs: Log[]) => void) | null = null;
  pusher: PricePusher | null = null;
  /**
   * How other legs of multi-leg accounts get a fresh price (see the header). `auto` (default):
   * `append` when the contract prices other legs from the executor's update (v3, detected by its
   * `TOP_UP_TARGET_BPS()` getter), else `push`.
   */
  otherLegs: "push" | "append" = "push";
  private otherLegsResolved = false;

  private async resolveOtherLegs(): Promise<void> {
    if (this.otherLegsResolved) return;
    this.otherLegsResolved = true;
    const env = (process.env.EXEC_OTHER_LEGS ?? "auto").trim().toLowerCase();
    if (env === "push" || env === "append") {
      this.otherLegs = env;
      return;
    }
    const v3 = await this.ctx.chain.client
      .readContract({ address: this.ctx.dep.clearinghouse, abi: clearinghouseAbi as never, functionName: "TOP_UP_TARGET_BPS" as never })
      .then(() => true, () => false);
    this.otherLegs = v3 ? "append" : "push";
    console.log(`[executor] other legs of multi-leg orders: ${this.otherLegs} (${v3 ? "contract prices them from the executor's update" : "contract prices them from Pyth storage"})`);
  }

  constructor(
    private readonly ctx: ProdContext,
    private readonly ledger: TxLedger,
  ) {
  }

  get maxDelay(): number {
    return this.ctx.params.maxExecDelay ?? 120;
  }
  private claimCheckedAt = 0;

  async tick(head: Head): Promise<void> {
    await this.resolveOtherLegs();
    await this.discover(head);
    const work = [...this.orders.values()].filter((o) => o.state === "pending" || o.state === "waiting-price");
    await Promise.all(work.map((o) => this.consider(o, head).catch((err: unknown) => this.fail(o, `consider: ${short(err)}`))));
    this.gc();
    if (Date.now() - this.claimCheckedAt > 10 * 60_000) {
      this.claimCheckedAt = Date.now();
      void this.claim().catch((err: unknown) => console.warn(`[executor] claim: ${short(err)}`));
    }
  }

  // -------------------------------------------------------------------------
  // discovery
  // -------------------------------------------------------------------------

  private async discover(head: Head): Promise<void> {
    if (this.scannedTo < 0) {
      // Backfill: everything that could still be executable (≥ 2× MAX_EXEC_DELAY of 0.4 s blocks).
      const back = Math.ceil((this.maxDelay * 2) / 0.4) + 50;
      this.scannedTo = Math.max(this.ctx.dep.deployBlock - 1, head.number - back);
    }
    const ch = this.ctx.dep.clearinghouse;
    while (this.scannedTo < head.number) {
      const from = this.scannedTo + 1;
      const to = Math.min(head.number, from + this.ctx.config.logRange - 1);
      const logs = (await this.ctx.chain.client.getLogs({ address: ch, fromBlock: BigInt(from), toBlock: BigInt(to) } as never)) as Log[];
      this.ingest(logs);
      if (this.onLogs && logs.length) {
        try {
          this.onLogs(logs);
        } catch (err) {
          console.warn(`[executor] log hook: ${short(err)}`);
        }
      }
      this.scannedTo = to;
    }
  }

  private ingest(logs: Log[]): void {
    const events = parseEventLogs({
      abi: clearinghouseAbi,
      logs,
      eventName: ["OrderCommitted", "OrderExecuted", "OrderFailed", "OrderCancelled"],
      strict: false,
    });
    for (const e of events) {
      const args = e.args as Record<string, unknown>;
      const id = args.orderId as bigint | undefined;
      if (id === undefined) continue;
      const key = id.toString();
      if (e.eventName === "OrderCommitted") {
        if (this.orders.has(key)) continue;
        const market = (args.market as Hex).toLowerCase() as Hex;
        const account = args.account as Address;
        this.orders.set(key, {
          id,
          account,
          lane: args.lane === undefined ? laneOf(account) : Number(args.lane),
          market,
          symbol: this.symbolOf(market)?.symbol ?? market.slice(0, 10),
          sizeDelta: (args.sizeDelta as bigint) ?? BigInt(0),
          execAfter: Number(args.execAfter ?? 0),
          deadline: Number(args.deadline ?? 0),
          commitBlock: Number(e.blockNumber ?? 0),
          executionFee: (args.executionFee as bigint) ?? BigInt(0),
          state: "pending",
          attempts: 0,
          lastError: null,
          update: null,
          tx: null,
          latencyS: null,
          fillPrice: null,
          failReason: null,
          doneAt: null,
        });
      } else {
        const o = this.orders.get(key);
        if (!o || o.state === "executed" || o.state === "failed" || o.state === "cancelled") continue;
        o.state = e.eventName === "OrderExecuted" ? "executed" : e.eventName === "OrderFailed" ? "failed" : "cancelled";
        if (e.eventName === "OrderExecuted") o.fillPrice = (args.fillPrice as bigint) ?? null;
        if (e.eventName === "OrderFailed") o.failReason = decodeFailReason(args.reason as Hex | undefined);
        o.doneAt = Date.now();
      }
    }
  }

  // -------------------------------------------------------------------------
  // execution
  // -------------------------------------------------------------------------

  private async consider(o: TrackedOrder, head: Head): Promise<void> {
    const { execAfter, deadline } = o;
    if (head.timestamp > deadline) return this.expire(o, head);
    if (head.timestamp < execAfter) return; // the contract requires block.timestamp >= execAfter

    const feed = this.symbolOf(o.market)?.feed;
    if (!feed) return this.fail(o, `unknown market ${o.market}`, true);

    if (!o.update) {
      let u: PriceUpdate | null;
      try {
        u = await this.ctx.hermes.firstAtOrAfter(execAfter, [feed]);
      } catch (err) {
        o.lastError = `hermes: ${short(err)}`;
        o.state = "waiting-price";
        return;
      }
      if (!u) {
        o.state = "waiting-price";
        return;
      }
      const m = u.messages.get(feed.toLowerCase())!;
      if (m.publishTime > deadline) {
        return this.unfillable(o, `first Pyth update at/after ${execAfter} is at ${m.publishTime}, after the deadline ${deadline}`, true);
      }
      if (u.parsedLocally && m.prevPublishTime >= execAfter) {
        // Not the first update ≥ execAfter: parsePriceFeedUpdatesUnique would reject it.
        o.lastError = `Hermes returned a non-first update (prev ${m.prevPublishTime} ≥ ${execAfter}); retrying`;
        o.state = "waiting-price";
        return;
      }
      const maxConf = this.ctx.params.maxConfBps;
      if (maxConf !== null && confBps(m) > maxConf) {
        // The fill price is pinned to this update; the contract reverts PriceConfidenceTooWide.
        return this.unfillable(o, `the pinned Pyth update has conf ${confBps(m)} bps > maxConfBps ${maxConf}; it expires, the user cancels`, true);
      }
      o.update = u;
    }

    // Other legs are priced from Pyth storage / the lane's last price (v2): keep them fresh.
    const acct = (await this.ctx.chain.client.readContract({
      address: this.ctx.dep.clearinghouse,
      abi: clearinghouseAbi,
      functionName: "getAccount",
      args: [o.account],
    })) as readonly [bigint, number, boolean, readonly Hex[], bigint, bigint];
    const others = acct[3].filter((mk) => mk.toLowerCase() !== o.market);
    let data = o.update.data;
    let parses = 1;
    // v3: a reduce-only order of an account in auction also needs the order market's CURRENT price.
    const inAuction =
      this.otherLegs === "append" && acct[3].length > 0
        ? await this.ctx.chain.client
            .readContract({ address: this.ctx.dep.clearinghouse, abi: clearinghouseAbi, functionName: "auctionOf", args: [o.account] })
            .then((r) => (r as readonly [boolean, bigint, number])[0], () => false)
        : false;
    // v4: the in-auction "current" price must be STRICTLY newer than execAfter (and ≤ 15 s old):
    // execute at least 1 s after execAfter; StalePrice reverts are retried with a fresh latest.
    if (inAuction && head.timestamp < execAfter + 1) {
      o.state = "waiting-price";
      return;
    }
    const freshFor = inAuction ? acct[3] : others;
    if (freshFor.length) {
      const legs = this.ctx.markets.filter((m) => freshFor.some((x) => x.toLowerCase() === m.id.toLowerCase()));
      if (this.otherLegs === "append") {
        // v3: [latest for the account's feeds, unique update at execAfter] — latest FIRST, so the
        // monotonic path sees the newest price for every leg (incl. the order market's current
        // price for a reduce-only order in auction); the unique parse skips the latest messages.
        try {
          const acctFeeds = this.ctx.markets.filter((m) => acct[3].some((x) => x.toLowerCase() === m.id.toLowerCase()));
          const fresh = await this.ctx.hermes.latest(acctFeeds.map((m) => m.feed));
          if (inAuction) {
            const cur = fresh.messages.get(this.symbolOf(o.market)?.feed.toLowerCase() ?? "");
            if (!cur || cur.publishTime <= execAfter) {
              o.lastError = `in-auction reduce: latest price (${cur?.publishTime ?? "none"}) not newer than execAfter ${execAfter}; retrying`;
              o.state = "waiting-price";
              return;
            }
          }
          data = [...fresh.data, ...o.update.data];
          parses = 2;
        } catch (err) {
          o.lastError = `hermes latest (account feeds): ${short(err)}`;
          o.state = "waiting-price";
          return;
        }
      } else if (this.pusher) {
        const ok = await this.pusher.ensureFresh(o.lane, legs, this.ctx.roles.keepers[o.lane], head.timestamp);
        if (!ok) {
          o.lastError = "could not refresh the stored price of the account's other legs; retrying";
          o.state = "waiting-price";
          return;
        }
      }
    }
    const keeper = this.ctx.roles.keepers[o.lane];
    const calldata = encodeFunctionData({ abi: clearinghouseAbi, functionName: "executeOrder", args: [o.id, data] });
    const fee = (await updateFee(this.ctx, data)) * BigInt(parses);
    const est = await estimate(this.ctx, { from: keeper.address, to: this.ctx.dep.clearinghouse, data: calldata, value: fee });
    if (!est.ok) {
      const name = est.revert.name;
      o.lastError = est.revert.message;
      if (RETRY_LATER.has(name) || name === "StalePrice") {
        // StalePrice here = another leg's stored/lane price expired between push and send.
        o.state = "waiting-price";
        return;
      }
      if (name === "LaneInsolvent") {
        this.ctx.alerter.fire(`lane:insolvent:${o.lane}`, "critical", `lane ${o.lane} reverts LaneInsolvent: ${est.revert.message}. See docs/RUNBOOK.md "Lane deficit".`);
        return;
      }
      if (ALREADY_DONE.has(name)) {
        o.state = "cancelled"; // its event arrives with the next log scan and sets the real outcome
        o.doneAt = Date.now();
        return;
      }
      if (name === "OrderExpired") return this.expire(o, head);
      if (EXPECTED.has(name)) return this.unfillable(o, `${est.revert.message} (expected refusal)`);
      o.attempts++;
      if (ORACLE.has(name)) o.update = null; // refetch next head
      if (o.attempts >= 3) {
        this.ctx.alerter.fire(
          `exec:failed:lane${o.lane}`,
          "warning",
          `order ${label(o.id)} (lane ${o.lane}, ${o.symbol}) does not simulate after ${o.attempts} tries: ${est.revert.message}`,
        );
      }
      return;
    }
    if (est.gas > this.ctx.config.maxTxGas) return this.fail(o, `gas ${est.gas} above the per-tx cap`, true);

    o.state = "sending";
    try {
      o.tx = await sendTracked(
        this.ctx,
        this.ledger,
        keeper,
        { to: this.ctx.dep.clearinghouse, data: calldata, value: fee, gas: est.gas },
        { kind: "executeOrder", lane: o.lane, meta: { orderId: o.id.toString(), market: o.symbol, execAfter, otherLegs: others.length } },
        (tx) => this.settled(o, tx, execAfter),
      );
      o.state = "inflight";
    } catch (err) {
      o.state = "pending";
      this.fail(o, `send: ${short(err)}`);
    }
  }

  private settled(o: TrackedOrder, tx: ProdTx, executableAt: number): void {
    if (tx.status === "success") {
      const outcome = tx.receipt ? parseEventLogs({ abi: clearinghouseAbi, logs: tx.receipt.logs, eventName: ["OrderExecuted", "OrderFailed"], strict: false }) : [];
      const failed = outcome.find((e) => e.eventName === "OrderFailed");
      const filled = outcome.find((e) => e.eventName === "OrderExecuted");
      o.state = failed ? "failed" : "executed";
      if (filled) o.fillPrice = ((filled.args as Record<string, unknown>).fillPrice as bigint) ?? null;
      if (failed) o.failReason = decodeFailReason((failed.args as Record<string, unknown>).reason as Hex | undefined);
      o.doneAt = Date.now();
      if (failed) this.stats.userFailed++;
      else this.stats.executed++;
      if (tx.blockTimestamp !== null) {
        o.latencyS = Math.max(0, tx.blockTimestamp - executableAt);
        this.stats.maxLatencyS = Math.max(this.stats.maxLatencyS, o.latencyS);
        if (o.latencyS > this.ctx.config.execLateAlertS) {
          this.stats.late++;
          this.ctx.alerter.event(
            `exec:late:lane${o.lane}`,
            "warning",
            `order ${label(o.id)} (lane ${o.lane}) executed ${o.latencyS}s after it became executable (alert threshold ${this.ctx.config.execLateAlertS}s)`,
          );
        }
      }
      this.ctx.alerter.resolve(`exec:failed:lane${o.lane}`);
      return;
    }
    o.state = "pending"; // re-evaluated next head (the order may still be executable)
    o.attempts++;
    this.fail(o, `tx ${tx.hash} ${tx.status}`);
    if (o.attempts >= 2) {
      this.ctx.alerter.fire(`exec:failed:lane${o.lane}`, "critical", `order ${label(o.id)} (lane ${o.lane}): execution tx ${tx.status} (${tx.hash})`);
    }
  }

  private expire(o: TrackedOrder, head: Head): void {
    if (o.state === "inflight" || o.state === "sending") return;
    o.state = "expired";
    o.doneAt = Date.now();
    this.stats.expired++;
    const why = o.lastError ?? "no executable price in the window";
    // Keeper-side when Hermes / sends were the problem; the user can cancel and recover the escrow.
    this.ctx.alerter.event(
      `exec:expired:lane${o.lane}`,
      "critical",
      `order ${label(o.id)} (lane ${o.lane}, ${o.symbol}) passed its deadline (chain time ${head.timestamp} > ${o.deadline}) without execution: ${why}. The user can cancelOrder() to recover the escrow + fee.`,
    );
  }

  private unfillable(o: TrackedOrder, why: string, page = false): void {
    o.state = "unfillable";
    o.lastError = why;
    o.doneAt = Date.now();
    this.stats.unfillable++;
    if (page) this.ctx.alerter.event(`exec:unfillable:lane${o.lane}`, "warning", `order ${label(o.id)}: ${why}`);
    else console.log(`[executor] order ${label(o.id)} (lane ${o.lane}) cannot fill: ${why} (user-side; it expires and the user cancels)`);
  }

  private fail(o: TrackedOrder, why: string, page = false): void {
    this.stats.failures++;
    this.stats.lastError = `order ${label(o.id)}: ${why}`;
    o.lastError = why;
    if (page) this.ctx.alerter.event(`exec:failed:lane${o.lane}`, "critical", `order ${label(o.id)} (lane ${o.lane}): ${why}`);
    else console.warn(`[executor] order ${label(o.id)} (lane ${o.lane}): ${why}`);
  }

  private gc(): void {
    if (this.orders.size < 5_000) return;
    const done = [...this.orders.values()].filter((o) => o.doneAt !== null).sort((a, b) => a.doneAt! - b.doneAt!);
    for (const o of done.slice(0, done.length - 2_000)) this.orders.delete(o.id.toString());
  }

  pending(): TrackedOrder[] {
    return [...this.orders.values()].filter((o) => !["executed", "failed", "cancelled", "expired", "unfillable"].includes(o.state));
  }

  /** Claim MON execution fees / AUSD expiry rewards each lane keeper has earned (lane-local writes). */
  private async claim(): Promise<void> {
    const minMon = parseEther(envStr("CLAIM_MIN_MON") ?? "1");
    const minAusd = BigInt(Math.round(Number(envStr("CLAIM_MIN_AUSD") ?? "1") * 1e6));
    await Promise.all(
      this.ctx.roles.keepers.map(async (k, lane) => {
        const [mon, ausd] = await Promise.all([
          this.ctx.chain.client.readContract({ address: this.ctx.dep.clearinghouse, abi: clearinghouseAbi, functionName: "executionFeesOwed", args: [k.address] }),
          this.ctx.chain.client.readContract({ address: this.ctx.dep.clearinghouse, abi: clearinghouseAbi, functionName: "keeperRewards", args: [k.address] }),
        ]);
        for (const [fn, owed, min] of [
          ["claimExecutionFees", mon as bigint, minMon],
          ["claimKeeperRewards", ausd as bigint, minAusd],
        ] as const) {
          if (owed < min) continue;
          const data = encodeFunctionData({ abi: clearinghouseAbi, functionName: fn });
          const est = await estimate(this.ctx, { from: k.address, to: this.ctx.dep.clearinghouse, data });
          if (!est.ok) continue;
          await sendTracked(this.ctx, this.ledger, k, { to: this.ctx.dep.clearinghouse, data, gas: est.gas }, { kind: "claim", lane, meta: { fn, owed: owed.toString() } });
          this.stats.claims++;
        }
      }),
    );
  }

  status() {
    return {
      otherLegs: this.otherLegs,
      scannedTo: this.scannedTo,
      minExecDelay: this.ctx.params.minExecDelay,
      maxExecDelay: this.ctx.params.maxExecDelay,
      pending: this.pending().length,
      perLane: Array.from({ length: 8 }, (_, lane) => this.pending().filter((o) => o.lane === lane).length),
      ...this.stats,
    };
  }
}

export function orderJson(o: TrackedOrder) {
  return {
    id: o.id.toString(),
    account: o.account,
    lane: o.lane,
    market: o.symbol,
    sizeDelta: o.sizeDelta.toString(),
    execAfter: o.execAfter,
    deadline: o.deadline,
    state: o.state,
    fillPrice: o.fillPrice?.toString() ?? null,
    failReason: o.failReason,
    attempts: o.attempts,
    lastError: o.lastError,
    txHash: o.tx?.hash ?? null,
    latencyS: o.latencyS,
    pricePublishTime: o.update ? [...o.update.messages.values()][0]?.publishTime ?? null : null,
  };
}

/** OrderFailed.reason: the fill's revert data → error name (e.g. "SlippageExceeded(…)"). */
function decodeFailReason(reason: Hex | undefined): string | null {
  if (!reason || reason === "0x") return null;
  try {
    const r = decodeErrorResult({ abi: clearinghouseAbi, data: reason });
    return `${r.errorName}(${(r.args ?? []).map(String).join(", ")})`;
  } catch {
    return reason.slice(0, 10);
  }
}

/** orderId = (uint160(account) << 96) | nonce → "0xabcd…1234#7" for humans. */
export function label(id: bigint): string {
  const account = `0x${(id >> BigInt(96)).toString(16).padStart(40, "0")}`;
  return `${account.slice(0, 6)}…${account.slice(-4)}#${id & ((BigInt(1) << BigInt(96)) - BigInt(1))}`;
}
