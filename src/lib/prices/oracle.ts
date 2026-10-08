import { parseAbiItem, type Address, type Hex } from "viem";
import { MARKETS, type MarketSymbol, type PriceTick } from "../types";
import { mockOracleAbi } from "../chain/abi";
import { publicClient, readMany, subscribeBlocks } from "../chain/clients";
import { priceToNumber } from "../chain/units";
import { aggregate } from "./candles";
import type { MarketHistory, PriceSource, TickHandler } from "./source";

/**
 * Chain-mode price source: reads `getPrice(marketId)` from the oracle contract
 * the clearinghouse settles against (MockOracle on testnet, pushed by the
 * keeper), once per new block. These are the exact marks the contract uses for
 * margin and liquidation - not Chainlink, and labelled as such in the UI.
 *
 * Ticks carry the on-chain `updatedAt` (1s resolution) as their timestamp and
 * the block they were read at.
 */
export interface OracleSourceConfig {
  oracle: Address;
  markets: Record<MarketSymbol, Hex>;
  deployBlock: number | null;
}

const PRICE_UPDATED = parseAbiItem(
  "event PriceUpdated(bytes32 indexed marketId, uint256 price, uint256 updatedAt)",
);
/** Conservative eth_getLogs range per request (public Monad RPCs cap it). */
const LOG_CHUNK = BigInt(100);
const MAX_BACKFILL_BLOCKS = BigInt(900);

export class OraclePriceSource implements PriceSource {
  readonly kind = "oracle" as const;
  private readonly bySymbol: Record<MarketSymbol, Hex>;
  private readonly byId: Map<string, MarketSymbol>;

  constructor(private readonly cfg: OracleSourceConfig) {
    this.bySymbol = cfg.markets;
    this.byId = new Map(MARKETS.map((s) => [cfg.markets[s].toLowerCase(), s]));
  }

  /** Best-effort: rebuild recent candles from PriceUpdated logs. */
  async backfill(bucketMs: number, count: number): Promise<Partial<Record<MarketSymbol, MarketHistory>>> {
    const pc = publicClient();
    const latest = await pc.getBlockNumber();
    const floor = this.cfg.deployBlock !== null ? BigInt(this.cfg.deployBlock) : BigInt(0);
    let from = latest > MAX_BACKFILL_BLOCKS ? latest - MAX_BACKFILL_BLOCKS : BigInt(0);
    if (from < floor) from = floor;

    const paths: Record<MarketSymbol, { ts: number; price: number }[]> = {
      "MON/AUSD": [],
      "SOL/AUSD": [],
      "BTC/AUSD": [],
    };
    for (let start = from; start <= latest; start += LOG_CHUNK) {
      const end = start + LOG_CHUNK - BigInt(1) > latest ? latest : start + LOG_CHUNK - BigInt(1);
      let logs;
      try {
        logs = await pc.getLogs({ address: this.cfg.oracle, event: PRICE_UPDATED, fromBlock: start, toBlock: end });
      } catch {
        break; // range limits / rate limits: keep what we have
      }
      for (const log of logs) {
        const symbol = log.args.marketId ? this.byId.get(log.args.marketId.toLowerCase()) : undefined;
        if (!symbol || log.args.price === undefined || log.args.updatedAt === undefined) continue;
        paths[symbol].push({ ts: Number(log.args.updatedAt) * 1000, price: priceToNumber(log.args.price) });
      }
    }

    const out: Partial<Record<MarketSymbol, MarketHistory>> = {};
    for (const s of MARKETS) {
      const path = paths[s];
      if (path.length === 0) continue;
      path.sort((a, b) => a.ts - b.ts);
      out[s] = { candles: aggregate(path, bucketMs, count), dayOpen: path[0].price };
    }
    return out;
  }

  start(onTick: TickHandler): () => void {
    const last = new Map<MarketSymbol, string>();
    let busy = false;
    let pending: bigint | null = null;

    const read = async (block: bigint) => {
      if (busy) {
        pending = block;
        return;
      }
      busy = true;
      try {
        const res = await readMany({
          contracts: MARKETS.map((s) => ({
            address: this.cfg.oracle,
            abi: mockOracleAbi,
            functionName: "getPrice" as const,
            args: [this.bySymbol[s]] as const,
          })),
        });
        res.forEach((r, i) => {
          if (r.status !== "success") return;
          const [price, updatedAt] = r.result as readonly [bigint, bigint];
          if (price === BigInt(0)) return; // no price pushed yet for this market
          const symbol = MARKETS[i];
          const key = `${price}:${updatedAt}`;
          if (last.get(symbol) === key) return;
          last.set(symbol, key);
          const tick: PriceTick = {
            symbol,
            price: priceToNumber(price),
            timestamp: Number(updatedAt) * 1000,
            source: "oracle",
            block: Number(block),
          };
          onTick(tick);
        });
      } catch {
        /* RPC hiccup: the next block retries */
      } finally {
        busy = false;
        if (pending !== null) {
          const b = pending;
          pending = null;
          void read(b);
        }
      }
    };

    return subscribeBlocks((b) => void read(b));
  }
}
