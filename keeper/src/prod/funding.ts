// Funding updater (OPS key). Funding is per market from the GLOBAL skew (sum of the 8 lanes' OI)
// and accrues into a cumulative index written only by the rate-limited `updateFunding(market)` —
// the once-per-interval "star" tx every other tx merely reads. Positions keep accruing at the
// stored rate between updates (indexNow = index + rate × elapsed), so an update only matters when
// it CHANGES the rate. With the contract's 60 s interval, updating every market every interval
// would cost 3 × 1,440 txs/day (≈ 38 MON/day at 102 gwei); instead the keeper computes the rate
// the contract would set (same integer formula, from openInterest + the market config) and sends
// `updateFunding(market)` only when
//   - the rate would change by more than FUNDING_MIN_CHANGE_BPS (relative, default 500 = 5 %) or
//     cross zero, or
//   - the rate was last recomputed more than FUNDING_MAX_AGE_S ago (default 3600),
// and never before fundingState(market).nextUpdate. FUNDING_MIN_CHANGE_BPS=0 → every interval.
// FUNDING_SKIP_IDLE (default on for testnet, off for mainnet): no max-age update while the stored
// rate AND the target are both 0 (no skew: the index does not move, an update changes nothing).
// Anyone may call updateFunding; FundingUpdateTooSoon from a race is harmless.
//
// Alerts: `funding:overdue:<market>` when the rate is older than FUNDING_MAX_AGE_S + 2 intervals
// (critical: the OPS key is not getting updates through), `funding:failed` on reverted/lost txs.

import { encodeFunctionData } from "viem";
import { clearinghouseAbi } from "./abi";
import { envNum } from "./config";
import { short, type MarketInfo, type ProdContext } from "./context";
import type { Head } from "./head";
import { estimate, sendTracked, type ProdTx, type TxLedger } from "./tx";

type FundingState = readonly [bigint, bigint, bigint, bigint, bigint]; // index, ratePerSec, lastUpdate, indexNow, nextUpdate
type MarketCfg = readonly [boolean, string, `0x${string}`, bigint, bigint, bigint]; // listed, symbol, feed, skewScale, maxLaneOi, maxFundingBpsPerDay

const FUNDING_SCALE = BigInt(10) ** BigInt(18);
const BPS = BigInt(10_000);
const DAY = BigInt(86_400);

/** The rate updateFunding would store now (ParaclrClearinghouseProd.updateFunding, same integer math). */
export function targetRate(skew: bigint, skewScale: bigint, maxFundingBpsPerDay: bigint): bigint {
  const maxRate = (maxFundingBpsPerDay * FUNDING_SCALE) / BPS / DAY;
  if (skew >= skewScale) return maxRate;
  if (skew <= -skewScale) return -maxRate;
  return (maxRate * skew) / skewScale; // Solidity int division truncates toward zero, like BigInt
}

export class FundingUpdater {
  private readonly inflight = new Map<string, ProdTx>();
  private readonly state = new Map<string, { ratePerSec: string; target: string; lastUpdate: number; nextUpdate: number; reason: string }>();
  private readonly cfg = new Map<string, MarketCfg>();
  private readonly minChangeBps = BigInt(Math.max(0, Math.floor(envNum("FUNDING_MIN_CHANGE_BPS", 500))));
  private readonly maxAgeS = envNum("FUNDING_MAX_AGE_S", 3_600);
  stats = { sent: 0, success: 0, skippedUnchanged: 0, failures: 0, lastError: null as string | null };

  constructor(
    private readonly ctx: ProdContext,
    private readonly ledger: TxLedger,
  ) {}

  get enabled(): boolean {
    return this.ctx.roles.ops !== null;
  }

  async tick(head: Head): Promise<void> {
    if (!this.enabled) return;
    await Promise.all(this.ctx.markets.map((m) => this.market(m, head).catch((err: unknown) => this.err(m, short(err)))));
  }

  private read<T>(functionName: "fundingState" | "getMarket" | "openInterest", m: MarketInfo): Promise<T> {
    return this.ctx.chain.client.readContract({ address: this.ctx.dep.clearinghouse, abi: clearinghouseAbi, functionName, args: [m.id] }) as Promise<T>;
  }

  private async market(m: MarketInfo, head: Head): Promise<void> {
    const pending = this.inflight.get(m.symbol);
    if (pending && pending.status === "pending") return;
    let cfg = this.cfg.get(m.symbol);
    if (!cfg || head.number % 600 === 0) {
      cfg = await this.read<MarketCfg>("getMarket", m);
      this.cfg.set(m.symbol, cfg);
    }
    const [st, oi] = await Promise.all([this.read<FundingState>("fundingState", m), this.read<readonly [bigint, bigint]>("openInterest", m)]);
    const rate = st[1];
    const lastUpdate = Number(st[2]);
    const nextUpdate = Number(st[4]);
    const interval = Math.max(1, nextUpdate - lastUpdate);
    const target = targetRate(oi[0] - oi[1], cfg[3], cfg[5]);
    const age = head.timestamp - lastUpdate;

    const diff = target > rate ? target - rate : rate - target;
    const absRate = rate < BigInt(0) ? -rate : rate;
    const changed = this.minChangeBps === BigInt(0) ? true : diff * BPS > absRate * this.minChangeBps || (rate === BigInt(0) && target !== BigInt(0)) || (rate !== BigInt(0) && (target > BigInt(0)) !== (rate > BigInt(0)));
    const idle = this.ctx.config.fundingSkipIdle && rate === BigInt(0) && target === BigInt(0);
    const stale = age >= this.maxAgeS && !idle;
    const reason = changed ? `rate ${rate} → ${target}` : stale ? `rate older than ${this.maxAgeS}s` : "unchanged";
    this.state.set(m.symbol, { ratePerSec: rate.toString(), target: target.toString(), lastUpdate, nextUpdate, reason });
    this.ctx.alerter.set(
      !idle && age > this.maxAgeS + 2 * interval + 60,
      `funding:overdue:${m.symbol}`,
      "critical",
      `${m.symbol} funding rate last recomputed ${Math.round(age / 60)} min ago (policy max ${Math.round(this.maxAgeS / 60)} min): check the OPS key balance and /health`,
    );
    if (head.timestamp < nextUpdate) return;
    if (!changed && !stale) {
      this.stats.skippedUnchanged++;
      return;
    }
    const ops = this.ctx.roles.ops!;
    const data = encodeFunctionData({ abi: clearinghouseAbi, functionName: "updateFunding", args: [m.id] });
    const est = await estimate(this.ctx, { from: ops.address, to: this.ctx.dep.clearinghouse, data });
    if (!est.ok) {
      if (est.revert.name === "FundingUpdateTooSoon") return; // someone else just updated it (anyone may)
      return this.err(m, `estimate: ${est.revert.message}`);
    }
    const tx = await sendTracked(
      this.ctx,
      this.ledger,
      ops,
      { to: this.ctx.dep.clearinghouse, data, gas: est.gas },
      { kind: "updateFunding", lane: null, meta: { market: m.symbol, ageS: age, reason } },
      (t) => {
        if (t.status === "success") {
          this.stats.success++;
          this.ctx.alerter.resolve("funding:failed");
        } else this.err(m, `tx ${t.hash} ${t.status}`, true);
      },
    );
    this.stats.sent++;
    this.inflight.set(m.symbol, tx);
  }

  private err(m: MarketInfo, msg: string, page = false): void {
    this.stats.failures++;
    this.stats.lastError = `${m.symbol}: ${msg}`;
    if (page) this.ctx.alerter.fire("funding:failed", "warning", `funding update for ${m.symbol} failed: ${msg}`);
    else console.warn(`[funding] ${m.symbol}: ${msg}`);
  }

  status() {
    return {
      enabled: this.enabled,
      interval: this.ctx.params.fundingInterval,
      policy: { minChangeBps: Number(this.minChangeBps), maxAgeS: this.maxAgeS, skipIdle: this.ctx.config.fundingSkipIdle },
      markets: Object.fromEntries(this.state),
      ...this.stats,
    };
  }
}
