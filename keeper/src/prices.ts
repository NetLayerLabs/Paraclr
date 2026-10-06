// Price loop: a GBM simulator (same model as src/lib/prices/simulated.ts) whose output is
// pushed to MockOracle.setPrices from the dedicated price-pusher key. In chain modes the
// on-chain oracle is the single source of price truth; the app reads it, never this process.

import { encodeFunctionData, type Hex } from "viem";
import { mockOracleAbi } from "../../src/lib/chain/abi";
import type { KeeperContext } from "./context";
import { estimateLimit, waitForReceipt } from "./sender";

/**
 * Per-tick (250 ms) log-return stdev, copied from MARKET_META.tickVol in
 * src/lib/prices/markets.ts so chain-mode charts move like the in-browser simulation.
 */
const TICK_VOL_250MS: Record<string, number> = {
  "MON/AUSD": 0.0009,
  "SOL/AUSD": 0.0005,
  "BTC/AUSD": 0.00032,
};
/** Seed prices if the oracle has none (MARKET_META.seedPrice). */
export const SEED_PRICES: Record<string, number> = {
  "MON/AUSD": 0.04,
  "SOL/AUSD": 180,
  "BTC/AUSD": 110_000,
};
const SIM_TICK_MS = 250;
const REVERSION = 0.0015; // per 250 ms tick, pull toward the drifting anchor
const JUMP_PROB = 0.0025; // per 250 ms tick

function gaussian(): number {
  let u = 0;
  while (u === 0) u = Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

interface Walk {
  logP: number;
  anchor: number;
  regime: number;
}

/**
 * GBM with Itô correction + weak OU pull to a drifting anchor + volatility regimes + rare jumps,
 * i.e. the SimulatedSource model, rescaled from its 250 ms tick to `stepMs`.
 */
export class PriceSim {
  private readonly walks: Record<string, Walk> = {};
  private readonly k: number;

  constructor(
    readonly symbols: string[],
    initial: Record<string, number>,
    stepMs: number,
  ) {
    this.k = stepMs / SIM_TICK_MS;
    for (const s of symbols) {
      const p = initial[s] > 0 ? initial[s] : (SEED_PRICES[s] ?? 1);
      this.walks[s] = { logP: Math.log(p), anchor: Math.log(p), regime: 1 };
    }
  }

  step(): Record<string, number> {
    const out: Record<string, number> = {};
    const sqrtK = Math.sqrt(this.k);
    const reversion = 1 - Math.pow(1 - REVERSION, this.k);
    const jumpProb = 1 - Math.pow(1 - JUMP_PROB, this.k);
    for (const s of this.symbols) {
      const w = this.walks[s];
      const base = TICK_VOL_250MS[s] ?? 0.0005;
      w.regime = Math.min(3, Math.max(0.4, w.regime + 0.04 * this.k * (1 - w.regime) + 0.06 * sqrtK * gaussian()));
      const sigma = base * w.regime * sqrtK;
      let z = gaussian();
      if (Math.random() < jumpProb) z += (Math.random() < 0.5 ? -1 : 1) * (3 + Math.random() * 4);
      w.anchor += base * 0.05 * sqrtK * gaussian();
      w.logP += -reversion * (w.logP - w.anchor) - 0.5 * sigma * sigma + sigma * z;
      out[s] = Math.exp(w.logP);
    }
    return out;
  }

  /** Continue the walk from externally set prices (after a crash or a recover). */
  rebase(prices: Record<string, number>): void {
    for (const s of this.symbols) {
      if (!(prices[s] > 0)) continue;
      this.walks[s].logP = Math.log(prices[s]);
      this.walks[s].anchor = this.walks[s].logP;
    }
  }
}

/** float AUSD → 1e18 fixed point (9 significant decimals is plenty for a demo feed). */
export function toWad(price: number): bigint {
  return BigInt(Math.round(price * 1e9)) * BigInt(1_000_000_000);
}

export function fromWad(wad: bigint): number {
  return Number(wad) / 1e18;
}

export interface PriceLoopStatus {
  enabled: boolean;
  running: boolean;
  paused: boolean;
  pauseReason: string | null;
  idle: boolean;
  intervalMs: number;
  idleAfterMs: number;
  pushes: number;
  failures: number;
  lastPush: { txHash: Hex; block: number | null; at: number } | null;
  lastError: string | null;
}

export class PriceLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private paused = false;
  private pauseReason: string | null = null;
  private currentTick: Promise<void> | null = null;
  private readonly inFlight = new Set<Promise<void>>();
  private gasLimit: bigint | null = null;
  private lastActivity = Date.now();
  private pushes = 0;
  private failures = 0;
  private lastPush: PriceLoopStatus["lastPush"] = null;
  private lastError: string | null = null;

  constructor(
    private readonly ctx: KeeperContext,
    readonly sim: PriceSim,
  ) {}

  start(): void {
    if (this.timer || !this.ctx.config.priceLoopEnabled) return;
    this.timer = setInterval(() => {
      if (!this.currentTick) {
        this.currentTick = this.tick().finally(() => {
          this.currentTick = null;
        });
      }
    }, this.ctx.config.priceIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.drain();
  }

  /** Mark user activity (any HTTP request). Keeps the loop out of idle mode. */
  touch(): void {
    this.lastActivity = Date.now();
  }

  private isIdle(): boolean {
    const idleMs = this.ctx.config.priceIdleMs;
    return idleMs > 0 && Date.now() - this.lastActivity > idleMs;
  }

  /**
   * Stop pushing and wait until every push already sent is mined, so no price-pusher write can
   * land in (or after) the block of whatever the caller sends next.
   */
  async pause(reason: string): Promise<void> {
    this.paused = true;
    this.pauseReason = reason;
    await this.drain();
  }

  /** Resume pushing, optionally continuing the random walk from `rebaseTo`. */
  resume(rebaseTo?: Record<string, number>): void {
    if (rebaseTo) this.sim.rebase(rebaseTo);
    this.paused = false;
    this.pauseReason = null;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  private async drain(): Promise<void> {
    if (this.currentTick) await this.currentTick.catch(() => undefined);
    await Promise.allSettled([...this.inFlight]);
  }

  status(): PriceLoopStatus {
    return {
      enabled: this.ctx.config.priceLoopEnabled,
      running: this.timer !== null,
      paused: this.paused,
      pauseReason: this.pauseReason,
      idle: this.isIdle(),
      intervalMs: this.ctx.config.priceIntervalMs,
      idleAfterMs: this.ctx.config.priceIdleMs,
      pushes: this.pushes,
      failures: this.failures,
      lastPush: this.lastPush,
      lastError: this.lastError,
    };
  }

  private async tick(): Promise<void> {
    // At most 2 pushes in flight: never queue a backlog of stale prices behind a slow block.
    if (this.paused || this.isIdle() || this.inFlight.size >= 2) return;
    const { ctx } = this;
    const pusher = ctx.senders.for(ctx.roles.pricePusher);
    try {
      const prices = this.sim.step();
      const data = encodeFunctionData({
        abi: mockOracleAbi,
        functionName: "setPrices",
        args: [ctx.markets.map((m) => m.id), ctx.markets.map((m) => toWad(prices[m.symbol]))],
      });
      if (this.gasLimit === null) {
        // setPrices costs the same every time (non-zero → non-zero slots): estimate once.
        this.gasLimit = (
          await estimateLimit(ctx.client, { account: pusher.address, to: ctx.dep.oracle, data }, ctx.config.gasMarginBps)
        ).limit;
      }
      if (this.paused) return; // paused while we were estimating
      const sub = await pusher.send({ to: ctx.dep.oracle, data, gas: this.gasLimit });
      const pollMs = Math.max(ctx.config.receiptPollMs, 400);
      const p: Promise<void> = waitForReceipt(ctx.client, sub.hash, { pollMs, timeoutMs: 30_000 })
        .then(({ receipt, observedAt }) => {
          if (receipt.status !== "success") {
            this.failures++;
            this.gasLimit = null;
            this.lastError = `setPrices reverted in ${sub.hash}`;
            return;
          }
          this.pushes++;
          this.lastPush = { txHash: sub.hash, block: Number(receipt.blockNumber), at: observedAt };
        })
        .catch((err: unknown) => {
          this.failures++;
          this.lastError = (err as Error)?.message ?? String(err);
        })
        .finally(() => {
          this.inFlight.delete(p);
        });
      this.inFlight.add(p);
    } catch (err) {
      this.failures++;
      this.gasLimit = null;
      const msg = (err as Error)?.message ?? String(err);
      if (msg !== this.lastError) console.error(`[prices] push failed: ${msg.split("\n")[0]}`);
      this.lastError = msg;
    }
  }
}
