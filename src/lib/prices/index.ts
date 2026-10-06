import { MARKETS, type MarketSymbol } from "../types";
import { ChainlinkStreamsSource, chainlinkConfigFromEnv } from "./chainlink";
import { SimulatedSource } from "./simulated";
import type { PriceSource, TickHandler } from "./source";

export * from "./source";
export * from "./markets";
export * from "./candles";
export { SimulatedSource } from "./simulated";
export { ChainlinkStreamsSource, chainlinkConfigFromEnv, decodeFullReport } from "./chainlink";
export { OraclePriceSource } from "./oracle";

/**
 * Chainlink first, simulator as per-market fallback: a market only receives
 * simulated ticks while its Chainlink stream has been silent for `staleMs`,
 * and the simulator is re-based on every real tick so a failover is seamless.
 */
export class FallbackSource implements PriceSource {
  readonly kind = "chainlink" as const;
  constructor(
    private readonly primary: ChainlinkStreamsSource,
    private readonly fallback: SimulatedSource,
    private readonly staleMs = 3_000,
  ) {}

  start(onTick: TickHandler): () => void {
    const lastReal = {} as Record<MarketSymbol, number>;
    for (const s of MARKETS) lastReal[s] = 0;

    const stopPrimary = this.primary.start((t) => {
      lastReal[t.symbol] = Date.now();
      this.fallback.rebase(t.symbol, t.price);
      onTick(t);
    });
    const stopFallback = this.fallback.start((t) => {
      if (Date.now() - lastReal[t.symbol] > this.staleMs) onTick(t);
    });
    return () => {
      stopPrimary();
      stopFallback();
    };
  }
}

export function createPriceSource(): PriceSource {
  const sim = new SimulatedSource();
  const cfg = chainlinkConfigFromEnv();
  if (!cfg) return sim;
  return new FallbackSource(new ChainlinkStreamsSource(cfg), sim);
}
