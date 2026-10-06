import { MARKETS, type MarketSymbol, type PriceTick } from "../types";
import { aggregate } from "./candles";
import { MARKET_META } from "./markets";
import type { MarketHistory, PriceSource, TickHandler } from "./source";

/**
 * Offline / demo price source.
 *
 * Model (per market, in log-price space):
 *   - GBM diffusion with Itô correction:  dlogP = -σ²/2 + σ·Z
 *   - weak Ornstein–Uhlenbeck pull toward a slowly drifting anchor, so a long
 *     demo session doesn't wander off to absurd prices
 *   - stochastic volatility regime (volatility clustering) and rare jumps
 *     (fat tails) so candles look like a real order book, not white noise.
 */

interface WalkState {
  logP: number;
  anchor: number;
  regime: number; // vol multiplier, mean-reverts to 1
}

const REVERSION = 0.0015; // per tick pull toward anchor
const JUMP_PROB = 0.0025; // per tick

function gaussian(): number {
  // Box–Muller
  let u = 0;
  while (u === 0) u = Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class SimulatedSource implements PriceSource {
  readonly kind = "simulated" as const;
  private readonly intervalMs: number;
  private walks: Record<MarketSymbol, WalkState>;
  private dayOpen: Record<MarketSymbol, number>;

  constructor(opts: { intervalMs?: number } = {}) {
    this.intervalMs = opts.intervalMs ?? 250;
    const walks = {} as Record<MarketSymbol, WalkState>;
    const dayOpen = {} as Record<MarketSymbol, number>;
    for (const s of MARKETS) {
      const seed = MARKET_META[s].seedPrice * (1 + (Math.random() - 0.5) * 0.04);
      walks[s] = { logP: Math.log(seed), anchor: Math.log(seed), regime: 1 };
      // A plausible "24h ago" price: -6% … +8% relative to now.
      dayOpen[s] = seed / (1 + (Math.random() * 0.14 - 0.06));
    }
    this.walks = walks;
    this.dayOpen = dayOpen;
  }

  private step(symbol: MarketSymbol): number {
    const w = this.walks[symbol];
    const base = MARKET_META[symbol].tickVol;

    // Volatility clustering: regime does a mean-reverting multiplicative walk.
    w.regime = Math.min(3, Math.max(0.4, w.regime + 0.04 * (1 - w.regime) + 0.06 * gaussian()));
    const sigma = base * w.regime;

    let z = gaussian();
    if (Math.random() < JUMP_PROB) z += (Math.random() < 0.5 ? -1 : 1) * (3 + Math.random() * 4);

    w.anchor += base * 0.05 * gaussian();
    w.logP += -REVERSION * (w.logP - w.anchor) - 0.5 * sigma * sigma + sigma * z;
    return Math.exp(w.logP);
  }

  /** Continue the walk from an externally observed price (used by the fallback wrapper). */
  rebase(symbol: MarketSymbol, price: number) {
    const w = this.walks[symbol];
    w.logP = Math.log(price);
    w.anchor = w.logP;
  }

  /**
   * Pre-generate `count` candles of history that end *now* and leave the live
   * walk exactly where the history ends, so the chart is continuous.
   */
  history(bucketMs: number, count: number): Partial<Record<MarketSymbol, MarketHistory>> {
    const now = Date.now();
    const steps = Math.ceil((bucketMs * count) / this.intervalMs);
    const out: Partial<Record<MarketSymbol, MarketHistory>> = {};
    for (const s of MARKETS) {
      // Generate forward from the seed, then shift the whole path so the
      // latest point equals the current walk price.
      const startLog = this.walks[s].logP;
      const path: { ts: number; price: number }[] = [];
      for (let i = 0; i < steps; i++) {
        path.push({ ts: now - (steps - i) * this.intervalMs, price: this.step(s) });
      }
      const drift = Math.log(path[path.length - 1].price) - startLog;
      for (const p of path) p.price = p.price / Math.exp(drift);
      this.walks[s].logP = startLog;
      this.walks[s].anchor = startLog;
      out[s] = { candles: aggregate(path, bucketMs, count), dayOpen: this.dayOpen[s] };
    }
    return out;
  }

  start(onTick: TickHandler): () => void {
    const emit = () => {
      const now = Date.now();
      for (const s of MARKETS) {
        const tick: PriceTick = {
          symbol: s,
          price: this.step(s),
          // Observation time slightly before delivery, like a real DON report.
          timestamp: now - Math.round(15 + Math.random() * 45),
          source: "simulated",
        };
        onTick(tick);
      }
    };
    emit();
    const id = setInterval(emit, this.intervalMs);
    return () => clearInterval(id);
  }
}
