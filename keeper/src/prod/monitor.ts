// Monitoring + alerting (docs/PRODUCTION_PLAN.md "Keeper / ops"). Every MONITOR_INTERVAL_MS:
//
//   balances   hot keys below ALERT_MIN_{KEEPER,OPS,GUARDIAN}_MON → `balance:<role>` (critical
//              below a quarter of it)
//   oracle     Hermes latest per feed: age vs ALERT_PRICE_AGE_{WARN,CRITICAL}_S → `oracle:stale:<m>`;
//              conf/price vs the contract's maxConfBps (warn at 80 %) → `oracle:conf:<m>`
//   pause      paused() flips → one event each way (`pause`), plus `paused` while it lasts
//   solvency   v2: per lane, laneSolvency(lane).surplus < 0 → `solvency:lane<i>` (critical; the lane
//              has bad debt beyond its insurance and withdrawals are haircut by haircutBps);
//              solvency().solvent == false → `solvency` (critical; token-level loss, e.g. an issuer
//              burn); AUTO_PAUSE_ON_INSOLVENCY=1 with a GUARDIAN key pauses on either
//   events     from the executor's per-head log scan: LaneHaircut (warning), BackstopLossAbsorbed
//              (warning), BackstopPoolReset (critical), AccountSkipped (warning), and on v3
//              BackstopRepaid (info) and MarketFeedReplaced (critical; feeds switch live), on v4
//              BackstopReceivableNetted (info) and BackstopSwept (`pool:forgiven` warning when a
//              receivable was forgiven, else `pool:swept` info) — one event alert each,
//              de-duplicated per lane and minute (names absent from the ABI simply never match)
//   caps       lane TVL / lane-market OI ≥ ALERT_CAP_PCT of their caps → `cap:…`
//   pools      v4: backstopDepositStatus(lane).open == false for longer than ALERT_POOL_CLOSED_H (6 h)
//              → `pool:closed:lane<i>` (a hedged pair can keep pool deposits closed: a DoS on LPs)
//   governance owner() must stay the timelock and the deployer must stay powerless → `gov:…`
//   AUSD       issuer risk (Agora can pause transfers / freeze addresses / upgrade AUSD):
//              isTransferPaused() → `ausd:paused`, isAccountFrozen(clearinghouse) → `ausd:frozen`,
//              Pyth AUSD/USD off peg by > ALERT_DEPEG_BPS (50) → `ausd:depeg` (critical at 4×;
//              AUSD_DEPEG_CHECK, on by default on mainnet only: testnet AUSD has no value and the
//              Pyth trial key may not cover AUSD/USD — a refused feed must not trip Hermes' breaker)
//   oracle src the clearinghouse's live `pyth()` (testnet: Pyth, or the keeper-signed fallback after
//              a timelocked setPyth) → the keeper switches its price source live (`gov:oracle`)
//   rpc        head not advancing for 15 s → `rpc:stalled`

import { encodeFunctionData, formatEther, parseEventLogs, type Abi, type Address, type Log } from "viem";
import { clearinghouseAbi, pythAbi } from "./abi";
import { short, switchOracle, type ProdContext } from "./context";
import type { Head, HeadWatcher } from "./head";
import { confBps, toFloat } from "./pyth-wire";
import { estimate, sendTracked, type TxLedger } from "./tx";
import { envNum, LANES } from "./config";
import { erc20Abi } from "./abi";

/** Pyth Crypto.AUSD/USD (Hermes /v2/price_feeds?query=AUSD, verified 2026-10-07). */
export const AUSD_USD_FEED = "0xd9912df360b5b7f21a122f15bdd5e27f62ce5e72bd316c291f7c86620e07fb2a";

const AUSD_ADMIN_ABI = [
  { type: "function", name: "isTransferPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "isAccountFrozen", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "bool" }] },
] as const;

export interface MonitorSnapshot {
  at: number;
  block: number | null;
  paused: boolean | null;
  solvency: { ausdHeld: string; liabilities: string; surplus: string; solvent: boolean } | null;
  /** v2 per-lane solvency: held, claims, surplus (= insurance − bad debt), insurance, badDebt, haircutBps. */
  laneSolvency: Array<{ lane: number; held: string; claims: string; surplus: string; insurance: string; badDebt: string; haircutBps: number } | null>;
  /** Age (s, vs chain time) of the price STORED in the Pyth contract per market (v2 limit: maxStoredPriceAge). */
  storedPriceAgeS: Record<string, number | null>;
  /** v4: per-lane backstopDepositStatus and how long deposits have been closed. */
  poolDeposits: Array<{ lane: number; open: boolean; receivable: string; unrealizedUncapped: string; closedForS: number } | null>;
  nativeSolvency: { held: string; liabilities: string; solvent: boolean } | null;
  prices: Record<string, { price: number; confBps: number; publishTime: number; ageS: number } | null>;
  balances: Array<{ role: string; address: Address; mon: string; low: boolean }>;
  caps: {
    maxLeverage: number | null;
    maxDepositPerAccount: string | null;
    maxTvlPerLane: string | null;
    laneTvl: Array<string | null>;
    tvlUtilisationPct: Array<number | null>;
    /** min(maxLaneOi, (insurance + pool cash) × oiCapMultiplier) per lane, per market (AUSD 6dp). */
    laneOiCap: Record<string, Array<string | null>>;
    oiUtilisationPct: Record<string, Array<number | null>>;
  } | null;
  owner: Address | null;
  ausd: { transferPaused: boolean | null; clearinghouseFrozen: boolean | null; usdPrice: number | null; balance: string | null };
  errors: string[];
}

const read = async <T>(ctx: ProdContext, functionName: string, args: unknown[] = []): Promise<T | null> => {
  try {
    return (await ctx.chain.client.readContract({
      address: ctx.dep.clearinghouse,
      abi: clearinghouseAbi as never,
      functionName: functionName as never,
      args: args as never,
    })) as T;
  } catch {
    return null;
  }
};

export class Monitor {
  snapshot: MonitorSnapshot | null = null;
  private lastPaused: boolean | null = null;
  private autoPaused = false;

  constructor(
    private readonly ctx: ProdContext,
    private readonly heads: HeadWatcher,
    private readonly ledger: TxLedger,
  ) {}

  async tick(head: Head): Promise<void> {
    const { ctx } = this;
    const errors: string[] = [];
    const guard = <T>(p: Promise<T>, what: string, fallback: T) =>
      p.catch((err: unknown) => {
        errors.push(`${what}: ${short(err)}`);
        return fallback;
      });

    await switchOracle(ctx).catch((err: unknown) => errors.push(`oracle: ${short(err)}`));
    const [balances, prices, paused, sol, caps, owner, nat, ausd, lanes, stored, poolDeposits] = await Promise.all([
      guard(this.balances(), "balances", []),
      guard(this.prices(head), "prices", {}),
      read<boolean>(ctx, "paused"),
      read<readonly [bigint, bigint, bigint, boolean]>(ctx, "solvency"),
      guard(this.caps(), "caps", null),
      read<Address>(ctx, "owner"),
      read<readonly [bigint, bigint, boolean]>(ctx, "nativeSolvency"),
      this.ausd(),
      Promise.all(Array.from({ length: LANES }, (_, lane) => read<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>(ctx, "laneSolvency", [lane]))),
      this.storedAges(head),
      this.poolDeposits(head).catch(() => []),
    ]);

    // per-lane solvency (v2)
    let laneDeficit = false;
    lanes.forEach((l, lane) => {
      if (!l) return;
      const deficit = l[2] < BigInt(0);
      laneDeficit ||= deficit;
      ctx.alerter.set(
        deficit,
        `solvency:lane${lane}`,
        "critical",
        `lane ${lane} is in deficit: surplus ${Number(l[2]) / 1e6} AUSD (insurance ${Number(l[3]) / 1e6}, bad debt ${Number(l[4]) / 1e6}); withdrawals are haircut ${Number(l[5]) / 100}% and fresh deposits revert LaneInDeficit. See docs/RUNBOOK.md "Lane deficit".`,
      );
    });

    // pause
    if (paused !== null) {
      if (this.lastPaused !== null && paused !== this.lastPaused) {
        ctx.alerter.event("pause", paused ? "critical" : "info", paused ? "contract PAUSED (deposits + increase orders blocked; withdrawals, reduce/close and liquidations continue)" : "contract unpaused (via timelock)");
      }
      ctx.alerter.set(paused, "paused", "warning", "contract is paused");
      this.lastPaused = paused;
    }

    // solvency
    if (sol) {
      ctx.alerter.set(!sol[3], "solvency", "critical", `solvency() = false: AUSD held ${sol[0]} < Σ lane holdings ${sol[1]} (surplus ${sol[2]}) — a token-level loss (issuer burn / freeze?)`);
      if (!sol[3] || laneDeficit) await this.maybeAutoPause(paused);
    } else errors.push("solvency(): unreadable");
    if (nat) ctx.alerter.set(!nat[2], "solvency:native", "critical", `nativeSolvency() = false: MON held ${nat[0]} < escrow + owed ${nat[1]}`);

    // governance
    if (owner && ctx.dep.timelock) {
      ctx.alerter.set(
        owner.toLowerCase() !== ctx.dep.timelock.toLowerCase(),
        "gov:owner",
        "critical",
        `owner() is ${owner}, expected the timelock ${ctx.dep.timelock}`,
      );
    }

    // rpc liveness
    const st = this.heads.status();
    ctx.alerter.set((st.lagMs ?? 0) > 15_000, "rpc:stalled", "critical", `no new block for ${Math.round((st.lagMs ?? 0) / 1000)} s (RPC stalled?)`);

    this.snapshot = {
      at: Date.now(),
      block: head.number,
      paused,
      solvency: sol ? { ausdHeld: sol[0].toString(), liabilities: sol[1].toString(), surplus: sol[2].toString(), solvent: sol[3] } : null,
      nativeSolvency: nat ? { held: nat[0].toString(), liabilities: nat[1].toString(), solvent: nat[2] } : null,
      laneSolvency: lanes.map((l, lane) =>
        l ? { lane, held: l[0].toString(), claims: l[1].toString(), surplus: l[2].toString(), insurance: l[3].toString(), badDebt: l[4].toString(), haircutBps: Number(l[5]) } : null,
      ),
      storedPriceAgeS: stored,
      poolDeposits,
      prices,
      balances,
      caps,
      owner,
      ausd,
      errors,
    };
  }

  private async storedAges(head: Head): Promise<Record<string, number | null>> {
    const out: Record<string, number | null> = {};
    await Promise.all(
      this.ctx.markets.map(async (m) => {
        const p = await this.ctx.chain.client.readContract({ address: this.ctx.dep.pyth, abi: pythAbi, functionName: "getPriceUnsafe", args: [m.feed] }).catch(() => null);
        out[m.symbol] = p ? Math.max(0, head.timestamp - Number(p.publishTime)) : null;
      }),
    );
    return out;
  }

  private readonly eventSeen = new Map<string, number>();
  /** First chain time each lane's pool deposits were seen closed (v4 backstopDepositStatus). */
  private readonly poolClosedSince = new Map<number, number>();

  private async poolDeposits(head: Head): Promise<Array<{ lane: number; open: boolean; receivable: string; unrealizedUncapped: string; closedForS: number } | null>> {
    const limitS = envNum("ALERT_POOL_CLOSED_H", 6) * 3600;
    return Promise.all(
      Array.from({ length: LANES }, async (_, lane) => {
        const st = await read<readonly [boolean, bigint, bigint, bigint]>(this.ctx, "backstopDepositStatus", [lane]);
        if (!st) return null; // pre-v4 contract
        if (st[0]) this.poolClosedSince.delete(lane);
        else if (!this.poolClosedSince.has(lane)) this.poolClosedSince.set(lane, head.timestamp);
        const closedForS = st[0] ? 0 : head.timestamp - (this.poolClosedSince.get(lane) ?? head.timestamp);
        this.ctx.alerter.set(
          !st[0] && closedForS >= limitS,
          `pool:closed:lane${lane}`,
          "warning",
          `lane ${lane} pool deposits have been CLOSED for ${(closedForS / 3600).toFixed(1)} h (${st[1] > BigInt(0) ? `the lane owes the pool ${Number(st[1]) / 1e6} AUSD` : `pool gain ${Number(st[2]) / 1e6} > lane insurance ${Number(st[3]) / 1e6}`}). A hedged pair can hold this open-ended: see docs/RUNBOOK.md "Pool deposits closed".`,
        );
        return { lane, open: st[0], receivable: st[1].toString(), unrealizedUncapped: st[2].toString(), closedForS };
      }),
    );
  }

  /** v2 risk events from the executor's log scan (every tx in the clearinghouse, not only ours). */
  onLogs(logs: Log[]): void {
    // BackstopRepaid / MarketFeedReplaced exist from contract v3 on; unknown names just never match.
    const evs = parseEventLogs({ abi: clearinghouseAbi as Abi, logs, strict: false }).filter((e) =>
      ["LaneHaircut", "BackstopLossAbsorbed", "BackstopPoolReset", "AccountSkipped", "BackstopRepaid", "MarketFeedReplaced", "BackstopReceivableNetted", "BackstopSwept", "PythUpdated"].includes(e.eventName ?? ""),
    ) as Array<{ eventName: string; args: unknown; transactionHash: string | null }>;
    for (const e of evs) {
      const a = e.args as Record<string, unknown>;
      const lane = Number(a.lane ?? -1);
      const key = `${e.eventName}:lane${lane}`;
      const now = Date.now();
      if (now - (this.eventSeen.get(key) ?? 0) < 60_000) continue; // one page per lane per minute
      this.eventSeen.set(key, now);
      const tx = e.transactionHash;
      if (e.eventName === "PythUpdated") {
        // A timelocked setPyth (testnet trial-end fallback, or back to Pyth): switch the price source now.
        void switchOracle(this.ctx).catch((err: unknown) => console.warn(`[monitor] oracle switch: ${short(err)}`));
        continue;
      }
      if (e.eventName === "LaneHaircut") {
        this.ctx.alerter.event(`haircut:lane${lane}`, "warning", `lane ${lane} paid a HAIRCUT withdrawal: ${a.account} debited ${Number(a.debited) / 1e6} AUSD, paid ${Number(a.paid) / 1e6} (tx ${tx})`);
      } else if (e.eventName === "BackstopLossAbsorbed") {
        this.ctx.alerter.event(`pool:loss:lane${lane}`, "warning", `lane ${lane} backstop pool absorbed ${Number(a.amount) / 1e6} AUSD of losses (second loss layer after insurance; tx ${tx})`);
      } else if (e.eventName === "BackstopPoolReset") {
        this.ctx.alerter.event(`pool:reset:lane${lane}`, "critical", `lane ${lane} backstop pool RESET (epoch ${a.epoch}): ${a.retiredShares} shares retired, deficit ${Number(a.deficit) / 1e6} AUSD (tx ${tx})`);
      } else if (e.eventName === "BackstopRepaid") {
        this.ctx.alerter.event(`pool:repaid:lane${lane}`, "info", `lane ${lane} backstop pool repaid ${Number(a.amount ?? 0) / 1e6} AUSD of absorbed losses (tx ${tx})`);
      } else if (e.eventName === "BackstopReceivableNetted") {
        this.ctx.alerter.event(`pool:netted:lane${lane}`, "info", `lane ${lane} pool receivable netted: ${Number(a.amount ?? 0) / 1e6} AUSD (tx ${tx})`);
      } else if (e.eventName === "BackstopSwept") {
        const forgiven = BigInt(String(a.receivableForgiven ?? 0));
        if (forgiven > BigInt(0)) {
          this.ctx.alerter.event(`pool:forgiven:lane${lane}`, "warning", `lane ${lane}: the last LP left; the pool's receivable of ${Number(forgiven) / 1e6} AUSD was FORGIVEN and ${Number(a.cash ?? 0) / 1e6} AUSD of orphaned cash went to the lane (tx ${tx})`);
        } else {
          this.ctx.alerter.event(`pool:swept:lane${lane}`, "info", `lane ${lane}: the last LP left; ${Number(a.cash ?? 0) / 1e6} AUSD of orphaned pool cash went to the lane (tx ${tx})`);
        }
      } else if (e.eventName === "MarketFeedReplaced") {
        // Apply live: every loop reads the feed from ctx.markets.
        const m = this.ctx.markets.find((x) => x.id.toLowerCase() === String(a.marketId).toLowerCase());
        const newFeed = String(a.newFeedId).toLowerCase() as `0x${string}`;
        if (m) {
          m.feed = newFeed;
          this.ctx.dep.feeds[m.symbol] = newFeed;
          this.ctx.sources.signed?.setFeeds(this.ctx.markets.map((x) => ({ symbol: x.symbol, feed: x.feed })));
        }
        this.ctx.alerter.event(
          "gov:feed",
          "critical",
          `${m?.symbol ?? a.marketId}: Pyth feed REPLACED through the timelock ${String(a.oldFeedId).slice(0, 10)}… → ${newFeed.slice(0, 10)}… (price ${a.newPrice}, tx ${tx}); the keeper switched to the new feed`,
        );
      } else if (e.eventName === "AccountSkipped") {
        this.ctx.alerter.event(`auction:skipped:lane${lane}`, "warning", `lane ${lane}: a batch skipped ${a.account} (no usable price for one of its markets; tx ${tx}). It is retried with the next fresh update.`);
      }
    }
  }

  /** Issuer-risk checks on AUSD (each optional: a token without the view just reports null). */
  private async ausd(): Promise<MonitorSnapshot["ausd"]> {
    const { ctx } = this;
    const c = ctx.chain.client;
    const [transferPaused, clearinghouseFrozen, balance] = await Promise.all([
      c.readContract({ address: ctx.dep.ausd, abi: AUSD_ADMIN_ABI, functionName: "isTransferPaused" }).catch(() => null),
      c.readContract({ address: ctx.dep.ausd, abi: AUSD_ADMIN_ABI, functionName: "isAccountFrozen", args: [ctx.dep.clearinghouse] }).catch(() => null),
      c.readContract({ address: ctx.dep.ausd, abi: erc20Abi, functionName: "balanceOf", args: [ctx.dep.clearinghouse] }).catch(() => null),
    ]);
    ctx.alerter.set(transferPaused === true, "ausd:paused", "critical", "AUSD transfers are PAUSED by the issuer: deposits and withdrawals fail until Agora unpauses");
    ctx.alerter.set(clearinghouseFrozen === true, "ausd:frozen", "critical", `AUSD has FROZEN the clearinghouse ${ctx.dep.clearinghouse}: pause and contact Agora`);
    let usdPrice: number | null = null;
    // Only against real Hermes and when enabled: never ask a source for a feed it may not serve.
    if (ctx.config.ausdDepegCheck && ctx.hermes === ctx.sources.hermes) {
      try {
        const u = await ctx.hermes.latest([AUSD_USD_FEED]);
        const m = u.messages.get(AUSD_USD_FEED);
        if (m) {
          usdPrice = toFloat(m.price, m.expo);
          const offBps = Math.abs(usdPrice - 1) * 10_000;
          const limit = envNum("ALERT_DEPEG_BPS", 50);
          ctx.alerter.set(offBps > limit, "ausd:depeg", offBps > 4 * limit ? "critical" : "warning", `AUSD/USD (Pyth) at ${usdPrice.toFixed(4)}: ${offBps.toFixed(0)} bps off peg. The contract treats 1 AUSD = 1 USD`);
        }
      } catch {
        /* depeg feed unavailable (e.g. the rehearsal's mock Hermes): informational only */
      }
    }
    return { transferPaused, clearinghouseFrozen, usdPrice, balance: balance?.toString() ?? null };
  }

  private async balances(): Promise<MonitorSnapshot["balances"]> {
    const { ctx } = this;
    const rows: Array<{ role: string; address: Address; min: bigint }> = [
      ...ctx.roles.keepers.map((k, i) => ({ role: `keeper[${i}]`, address: k.address, min: ctx.config.minKeeperWei })),
    ];
    if (ctx.roles.ops) rows.push({ role: "ops", address: ctx.roles.ops.address, min: ctx.config.minOpsWei });
    if (ctx.roles.guardian) rows.push({ role: "guardian", address: ctx.roles.guardian.address, min: ctx.config.minGuardianWei });
    const bals = await Promise.all(rows.map((r) => ctx.chain.client.getBalance({ address: r.address })));
    return rows.map((r, i) => {
      const low = bals[i] < r.min;
      const critical = bals[i] < r.min / BigInt(4);
      ctx.alerter.set(
        low,
        `balance:${r.role}`,
        critical ? "critical" : "warning",
        `${r.role} ${r.address} has ${Number(formatEther(bals[i])).toFixed(3)} MON (alert below ${formatEther(r.min)}); top up with \`npm run keeper:fund -- --network ${ctx.chain.profile.name}\``,
      );
      return { role: r.role, address: r.address, mon: formatEther(bals[i]), low };
    });
  }

  private async prices(head: Head): Promise<MonitorSnapshot["prices"]> {
    const { ctx } = this;
    const out: MonitorSnapshot["prices"] = {};
    let u;
    try {
      u = await ctx.hermes.latest(ctx.markets.map((m) => m.feed));
    } catch (err) {
      for (const m of ctx.markets) out[m.symbol] = null;
      throw err;
    }
    const maxConf = ctx.params.maxConfBps;
    for (const m of ctx.markets) {
      const msg = u.messages.get(m.feed.toLowerCase());
      if (!msg) {
        out[m.symbol] = null;
        continue;
      }
      // Chain time is the reference (the contract checks staleness against block.timestamp).
      const age = Math.max(0, head.timestamp - msg.publishTime);
      const c = confBps(msg);
      out[m.symbol] = { price: toFloat(msg.price, msg.expo), confBps: c, publishTime: msg.publishTime, ageS: age };
      ctx.alerter.set(
        age > ctx.config.priceAgeWarnS,
        `oracle:stale:${m.symbol}`,
        age > ctx.config.priceAgeCriticalS ? "critical" : "warning",
        `${m.symbol} latest Pyth price is ${age}s old (publishTime ${msg.publishTime})`,
      );
      if (maxConf !== null) {
        ctx.alerter.set(
          c * 10 >= maxConf * 8,
          `oracle:conf:${m.symbol}`,
          c > maxConf ? "critical" : "warning",
          `${m.symbol} Pyth confidence ${c} bps vs contract maxConfBps ${maxConf}${c > maxConf ? ": orders/liquidations on this market revert until it narrows" : ""}`,
        );
      }
    }
    return out;
  }

  private async caps(): Promise<MonitorSnapshot["caps"]> {
    const { ctx } = this;
    const [maxLev, maxDep, maxTvl] = await Promise.all([
      read<bigint>(ctx, "maxLeverage"),
      read<bigint>(ctx, "maxDepositPerAccount"),
      read<bigint>(ctx, "maxTvlPerLane"),
    ]);
    const laneTvl = await Promise.all(Array.from({ length: LANES }, (_, lane) => read<bigint>(ctx, "laneTvl", [lane])));
    const pct = (v: bigint | null, cap: bigint | null) => (v === null || cap === null || cap === BigInt(0) ? null : Number((v * BigInt(10_000)) / cap) / 100);
    const tvlPct = laneTvl.map((v) => pct(v, maxTvl));
    tvlPct.forEach((p, lane) =>
      ctx.alerter.set(p !== null && p >= ctx.config.capAlertPct, `cap:tvl:lane${lane}`, "warning", `lane ${lane} TVL at ${p}% of its cap`),
    );
    const oiCaps: Record<string, Array<string | null>> = {};
    const oiPct: Record<string, Array<number | null>> = {};
    await Promise.all(
      ctx.markets.map(async (m) => {
        const [caps, ois] = await Promise.all([
          Promise.all(Array.from({ length: LANES }, (_, lane) => read<bigint>(ctx, "laneOiCap", [lane, m.id]))),
          Promise.all(Array.from({ length: LANES }, (_, lane) => read<readonly [bigint, bigint]>(ctx, "laneOpenInterest", [lane, m.id]))),
        ]);
        oiCaps[m.symbol] = caps.map((c) => c?.toString() ?? null);
        oiPct[m.symbol] = ois.map((oi, lane) => (oi ? pct(oi[0] > oi[1] ? oi[0] : oi[1], caps[lane]) : null));
        oiPct[m.symbol].forEach((p, lane) =>
          ctx.alerter.set(p !== null && p >= ctx.config.capAlertPct, `cap:oi:lane${lane}:${m.symbol}`, "warning", `lane ${lane} ${m.symbol} open interest at ${p}% of its cap`),
        );
      }),
    );
    return {
      maxLeverage: maxLev === null ? null : Number(maxLev),
      maxDepositPerAccount: maxDep?.toString() ?? null,
      maxTvlPerLane: maxTvl?.toString() ?? null,
      laneTvl: laneTvl.map((v) => v?.toString() ?? null),
      tvlUtilisationPct: tvlPct,
      laneOiCap: oiCaps,
      oiUtilisationPct: oiPct,
    };
  }

  /** AUTO_PAUSE_ON_INSOLVENCY=1 + GUARDIAN key: pause once. Pause only blocks NEW risk. */
  private async maybeAutoPause(paused: boolean | null): Promise<void> {
    const { ctx } = this;
    if (!ctx.config.autoPauseOnInsolvency || !ctx.roles.guardian || paused || this.autoPaused) return;
    this.autoPaused = true;
    const data = encodeFunctionData({ abi: clearinghouseAbi, functionName: "pause" });
    const est = await estimate(ctx, { from: ctx.roles.guardian.address, to: ctx.dep.clearinghouse, data });
    if (!est.ok) {
      ctx.alerter.fire("autopause", "critical", `auto-pause on insolvency FAILED to simulate: ${est.revert.message}. Pause by hand (docs/RUNBOOK.md).`);
      return;
    }
    const tx = await sendTracked(ctx, this.ledger, ctx.roles.guardian, { to: ctx.dep.clearinghouse, data, gas: est.gas }, { kind: "pause", lane: null, meta: { reason: "solvency" } });
    ctx.alerter.event("autopause", "critical", `solvency() false → guardian pause() sent automatically (${tx.hash})`);
  }
}
