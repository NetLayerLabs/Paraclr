import { describe, it } from "vitest";
import { createTestIndexer, TestHelpers } from "envio";

// Handler logic on simulated events (no network). The auction path has no live data on testnet yet:
// with real prices, an auction needs a large market move against a leveraged account.

const TRADER = TestHelpers.Addresses.mockAddresses[0]!;
const POOL_KEEPER = TestHelpers.Addresses.mockAddresses[1]!;
const SOL = "0x71404ecadb92f5a36fa398992a182993209814fdb029f79c89cc01dad48a01f6";
const C = "ParaclrClearinghouse" as const;
const CLEARINGHOUSE = "0xbC1fD0165FBfF4EF32337E42D0e2Ad59bF52b203" as const;

const ev = <E extends string, P>(event: E, params: P, block: number, logIndex?: number) => ({
  contract: C,
  event,
  srcAddress: CLEARINGHOUSE,
  params,
  logIndex,
  // After the config's start_block, or the indexer skips the event.
  block: { number: 69_100_000 + block, timestamp: 1_791_400_000 + block },
  transaction: { hash: `0x${block.toString(16).padStart(64, "0")}` },
});

describe("Paraclr indexer", () => {
  it("tracks an order from commit to fill, with volume and fees", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        10143: {
          simulate: [
            ev("MarketListed", { marketId: SOL, symbol: "SOL/AUSD", feedId: "0x" + "ef".repeat(32) }, 1),
            ev("Deposit", { account: TRADER, lane: 3n, amount: 40_000_000n }, 2),
            ev(
              "OrderCommitted",
              {
                orderId: 7n,
                account: TRADER,
                market: SOL,
                lane: 3n,
                sizeDelta: 500_000_000_000_000_000n, // 0.5 SOL
                marginDelta: 20_000_000n,
                acceptablePrice: 120n * 10n ** 18n,
                executionFee: 10n ** 17n,
                execAfter: 0n,
                deadline: 0n,
              },
              3,
            ),
            ev(
              "OrderExecuted",
              {
                orderId: 7n,
                account: TRADER,
                market: SOL,
                executor: POOL_KEEPER,
                fillPrice: 116n * 10n ** 18n,
                publishTime: 0n,
                sizeDelta: 500_000_000_000_000_000n,
                tradingFee: 29_000n,
                realizedPnl: 0n,
                executionFee: 10n ** 17n,
              },
              5,
            ),
          ],
        },
      },
    });

    const order = await indexer.Order.getOrThrow("7");
    t.expect(order.status).toBe("Executed");
    t.expect(order.notional).toBe(58_000_000n); // 0.5 × 116 AUSD
    t.expect(order.latency).toBe(2);
    t.expect(order.account_id).toBe(TRADER.toLowerCase());

    const account = await indexer.Account.getOrThrow(TRADER.toLowerCase());
    t.expect(account.deposited).toBe(40_000_000n);
    t.expect(account.ordersExecuted).toBe(1);
    t.expect(account.lane_id).toBe("3");

    const market = await indexer.Market.getOrThrow(SOL);
    t.expect(market.volume).toBe(58_000_000n);

    const p = await indexer.Protocol.getOrThrow("protocol");
    t.expect(p.accounts).toBe(1);
    t.expect(p.ordersExecuted).toBe(1);
    t.expect(p.tradingFees).toBe(29_000n);
    t.expect(p.collateralDeposited).toBe(40_000_000n);
  });

  it("follows an auction to a backstop take and counts what the trader got back", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        10143: {
          simulate: [
            ev("AuctionStarted", { lane: 5n, account: TRADER, startBlock: 100n, equity: 3_000_000n, notional: 150_000_000n }, 100),
            ev(
              "AuctionTaken",
              {
                lane: 5n,
                account: TRADER,
                taker: POOL_KEEPER,
                backstop: true,
                discountBps: 75n,
                blocksElapsed: 3n,
                notional: 150_000_000n,
                traderResidual: 1_875_000n,
                payment: 1_125_000n,
                badDebt: 0n,
              },
              103,
            ),
          ],
        },
      },
    });

    const auctions = await indexer.Auction.getAll();
    t.expect(auctions).toHaveLength(1);
    const a = auctions[0]!;
    t.expect(a.status).toBe("Taken");
    t.expect(a.byBackstop).toBe(true);
    t.expect(a.discountBps).toBe(75);
    t.expect(a.traderResidual).toBe(1_875_000n);

    const lane = await indexer.Lane.getOrThrow("5");
    t.expect(lane.auctionsTakenByBackstop).toBe(1);
    t.expect(lane.backstopEarned).toBe(1_125_000n);
    t.expect(lane.equityReturned).toBe(1_875_000n);

    const account = await indexer.Account.getOrThrow(TRADER.toLowerCase());
    t.expect(account.activeAuction).toBeUndefined();

    const p = await indexer.Protocol.getOrThrow("protocol");
    t.expect(p.auctionsStarted).toBe(1);
    t.expect(p.auctionsTaken).toBe(1);
    t.expect(p.equityReturned).toBe(1_875_000n);
  });

  it("marks a cured auction and frees the account", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        10143: {
          simulate: [
            ev("AuctionStarted", { lane: 2n, account: TRADER, startBlock: 50n, equity: 1_000_000n, notional: 90_000_000n }, 50),
            ev("AuctionCancelled", { lane: 2n, account: TRADER }, 52),
          ],
        },
      },
    });
    const [a] = await indexer.Auction.getAll();
    t.expect(a!.status).toBe("Cured");
    t.expect((await indexer.Lane.getOrThrow("2")).auctionsCured).toBe(1);
    t.expect((await indexer.Account.getOrThrow(TRADER.toLowerCase())).activeAuction).toBeUndefined();
  });

  it("keeps both auctions when an account is cured and re-auctioned in one block", async (t) => {
    const indexer = createTestIndexer();
    const started = { lane: 4n, account: TRADER, startBlock: 70n, equity: 2_000_000n, notional: 120_000_000n };
    const taken = {
      lane: 4n,
      account: TRADER,
      taker: POOL_KEEPER,
      backstop: false,
      discountBps: 50n,
      blocksElapsed: 0n,
      notional: 120_000_000n,
      traderResidual: 1_400_000n,
      payment: 600_000n,
      badDebt: 0n,
    };
    await indexer.process({
      chains: {
        10143: {
          simulate: [
            ev("AuctionStarted", started, 70, 0),
            ev("AuctionCancelled", { lane: 4n, account: TRADER }, 70, 1),
            ev("AuctionStarted", started, 70, 2),
            ev("AuctionTaken", taken, 70, 3),
          ],
        },
      },
    });

    const auctions = (await indexer.Auction.getAll()).sort((x, y) => x.id.localeCompare(y.id));
    t.expect(auctions).toHaveLength(2);
    t.expect(auctions.map((a) => a.status)).toEqual(["Cured", "Taken"]);
    t.expect(auctions.map((a) => a.id)).toEqual([`${TRADER.toLowerCase()}_69100070_0`, `${TRADER.toLowerCase()}_69100070_2`]);

    const lane = await indexer.Lane.getOrThrow("4");
    t.expect(lane.auctionsStarted).toBe(2);
    t.expect(lane.auctionsCured).toBe(1);
    t.expect(lane.auctionsTaken).toBe(1);

    const account = await indexer.Account.getOrThrow(TRADER.toLowerCase());
    t.expect(account.auctions).toBe(2);
    t.expect(account.activeAuction).toBeUndefined();
  });
});
