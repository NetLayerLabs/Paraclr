// Event handlers for the Paraclr clearinghouse (contracts/src/prod/ParaclrClearinghouseProd.sol).
// Every handler loads the rows it touches once, then writes them once: entities read from the
// context are read-only, so updates are spreads.

import { indexer } from "envio";
import type { Account, Auction, DailyStat, EvmOnEventContext, Lane, Protocol } from "envio";

const FIELDS = { block: ["timestamp"], transaction: ["hash"] } as const;
const ZERO = 0n;
// size (1e18) × price (1e18) → AUSD (1e6)
const NOTIONAL_SCALE = 10n ** 30n;

type Ctx = EvmOnEventContext;

const abs = (x: bigint) => (x < ZERO ? -x : x);
const lower = (a: string) => a.toLowerCase();

async function loadProtocol(context: Ctx): Promise<Protocol> {
  return (
    (await context.Protocol.get("protocol")) ?? {
      id: "protocol",
      accounts: 0,
      ordersCommitted: 0,
      ordersExecuted: 0,
      ordersFailed: 0,
      ordersCancelled: 0,
      volume: ZERO,
      tradingFees: ZERO,
      executionFeesPaid: ZERO,
      collateralDeposited: ZERO,
      collateralWithdrawn: ZERO,
      auctionsStarted: 0,
      auctionsTaken: 0,
      auctionsTakenByBackstop: 0,
      auctionsCured: 0,
      auctionsExpired: 0,
      auctionPayments: ZERO,
      equityReturned: ZERO,
      badDebt: ZERO,
      insuranceFunded: ZERO,
      backstopDeposited: ZERO,
      backstopWithdrawn: ZERO,
      paused: false,
      lastBlock: ZERO,
      lastTimestamp: 0,
    }
  );
}

async function loadLane(context: Ctx, lane: bigint | number): Promise<Lane> {
  const index = Number(lane);
  return (
    (await context.Lane.get(String(index))) ?? {
      id: String(index),
      index,
      accounts: 0,
      ordersExecuted: 0,
      volume: ZERO,
      auctionsStarted: 0,
      auctionsTaken: 0,
      auctionsTakenByBackstop: 0,
      auctionsCured: 0,
      auctionsExpired: 0,
      backstopEarned: ZERO,
      notionalAbsorbed: ZERO,
      equityReturned: ZERO,
      badDebt: ZERO,
      insuranceFunded: ZERO,
      backstopDeposited: ZERO,
      backstopWithdrawn: ZERO,
    }
  );
}

async function loadDay(context: Ctx, timestamp: number): Promise<DailyStat> {
  const dayStart = Math.floor(timestamp / 86_400) * 86_400;
  const id = new Date(dayStart * 1000).toISOString().slice(0, 10);
  return (
    (await context.DailyStat.get(id)) ?? {
      id,
      dayStart,
      ordersExecuted: 0,
      volume: ZERO,
      tradingFees: ZERO,
      newAccounts: 0,
      auctionsStarted: 0,
      auctionsTaken: 0,
      equityReturned: ZERO,
    }
  );
}

/** The account row, created on first sight (and then counted in the protocol, lane and day totals). */
async function loadAccount(
  context: Ctx,
  address: string,
  lane: bigint | number,
  block: number,
  timestamp: number,
): Promise<{ account: Account; isNew: boolean }> {
  const existing = await context.Account.get(lower(address));
  if (existing) return { account: existing, isNew: false };
  return {
    isNew: true,
    account: {
      id: lower(address),
      lane_id: String(Number(lane)),
      deposited: ZERO,
      withdrawn: ZERO,
      ordersCommitted: 0,
      ordersExecuted: 0,
      volume: ZERO,
      realizedPnl: ZERO,
      tradingFees: ZERO,
      auctions: 0,
      activeAuction: undefined,
      firstBlock: BigInt(block),
      lastTimestamp: timestamp,
    },
  };
}

/** Saves a new account's counters into the protocol, lane and day rows (which the caller then saves). */
function countNewAccount(isNew: boolean, p: Protocol, l: Lane, d: DailyStat): [Protocol, Lane, DailyStat] {
  if (!isNew) return [p, l, d];
  return [{ ...p, accounts: p.accounts + 1 }, { ...l, accounts: l.accounts + 1 }, { ...d, newAccounts: d.newAccounts + 1 }];
}

const stamp = (p: Protocol, block: number, timestamp: number): Protocol => ({
  ...p,
  lastBlock: BigInt(block),
  lastTimestamp: timestamp,
});

// ---- markets, accounts, collateral ---------------------------------------------------------

indexer.onEvent({ contract: "ParaclrClearinghouse", event: "MarketListed" }, async ({ event, context }) => {
  context.Market.set({
    id: lower(event.params.marketId),
    symbol: event.params.symbol,
    feedId: lower(event.params.feedId),
    listedBlock: BigInt(event.block.number),
    ordersExecuted: 0,
    volume: ZERO,
    tradingFees: ZERO,
    fundingRatePerSec: ZERO,
    fundingIndex: ZERO,
    skewNotional: ZERO,
    fundingUpdatedAt: 0,
  });
});

indexer.onEvent(
  { contract: "ParaclrClearinghouse", event: "AccountRegistered", fields: FIELDS },
  async ({ event, context }) => {
    const ts = event.block.timestamp;
    const { account, isNew } = await loadAccount(context, event.params.account, event.params.lane, event.block.number, ts);
    const [p, l, d] = countNewAccount(
      isNew,
      await loadProtocol(context),
      await loadLane(context, event.params.lane),
      await loadDay(context, ts),
    );
    context.Account.set(account);
    context.Lane.set(l);
    context.DailyStat.set(d);
    context.Protocol.set(stamp(p, event.block.number, ts));
  },
);

for (const kind of ["Deposit", "Withdraw"] as const) {
  indexer.onEvent({ contract: "ParaclrClearinghouse", event: kind, fields: FIELDS }, async ({ event, context }) => {
    const ts = event.block.timestamp;
    const { amount, lane } = event.params;
    const { account, isNew } = await loadAccount(context, event.params.account, lane, event.block.number, ts);
    const [p, l, d] = countNewAccount(isNew, await loadProtocol(context), await loadLane(context, lane), await loadDay(context, ts));
    const deposit = kind === "Deposit";
    context.Account.set({
      ...account,
      deposited: deposit ? account.deposited + amount : account.deposited,
      withdrawn: deposit ? account.withdrawn : account.withdrawn + amount,
      lastTimestamp: ts,
    });
    context.CollateralFlow.set({
      id: `${event.block.number}_${event.logIndex}`,
      account: lower(event.params.account),
      lane: Number(lane),
      kind,
      amount,
      block: BigInt(event.block.number),
      timestamp: ts,
      tx: event.transaction.hash,
    });
    context.Lane.set(l);
    context.DailyStat.set(d);
    context.Protocol.set(
      stamp(
        deposit
          ? { ...p, collateralDeposited: p.collateralDeposited + amount }
          : { ...p, collateralWithdrawn: p.collateralWithdrawn + amount },
        event.block.number,
        ts,
      ),
    );
  });
}

// ---- delayed orders and positions ----------------------------------------------------------

indexer.onEvent(
  { contract: "ParaclrClearinghouse", event: "OrderCommitted", fields: FIELDS },
  async ({ event, context }) => {
    const ts = event.block.timestamp;
    const e = event.params;
    const { account, isNew } = await loadAccount(context, e.account, e.lane, event.block.number, ts);
    const [p, l, d] = countNewAccount(isNew, await loadProtocol(context), await loadLane(context, e.lane), await loadDay(context, ts));
    context.Order.set({
      id: e.orderId.toString(),
      orderId: e.orderId,
      account_id: lower(e.account),
      market_id: lower(e.market),
      lane: Number(e.lane),
      status: "Pending",
      sizeDelta: e.sizeDelta,
      marginDelta: e.marginDelta,
      acceptablePrice: e.acceptablePrice,
      executionFee: e.executionFee,
      execAfter: e.execAfter,
      deadline: e.deadline,
      committedBlock: BigInt(event.block.number),
      committedAt: ts,
      committedTx: event.transaction.hash,
      executor: undefined,
      fillPrice: undefined,
      publishTime: undefined,
      tradingFee: undefined,
      realizedPnl: undefined,
      notional: undefined,
      failReason: undefined,
      resolvedBlock: undefined,
      resolvedAt: undefined,
      resolvedTx: undefined,
      latency: undefined,
    });
    context.Account.set({ ...account, ordersCommitted: account.ordersCommitted + 1, lastTimestamp: ts });
    context.Lane.set(l);
    context.DailyStat.set(d);
    context.Protocol.set(stamp({ ...p, ordersCommitted: p.ordersCommitted + 1 }, event.block.number, ts));
  },
);

indexer.onEvent(
  { contract: "ParaclrClearinghouse", event: "OrderExecuted", fields: FIELDS },
  async ({ event, context }) => {
    const ts = event.block.timestamp;
    const e = event.params;
    const order = await context.Order.get(e.orderId.toString());
    if (!order) {
      context.log.warn(`OrderExecuted for unknown order ${e.orderId}`);
      return;
    }
    const notional = (abs(e.sizeDelta) * e.fillPrice) / NOTIONAL_SCALE;
    context.Order.set({
      ...order,
      status: "Executed",
      executor: lower(e.executor),
      fillPrice: e.fillPrice,
      publishTime: e.publishTime,
      tradingFee: e.tradingFee,
      realizedPnl: e.realizedPnl,
      notional,
      resolvedBlock: BigInt(event.block.number),
      resolvedAt: ts,
      resolvedTx: event.transaction.hash,
      latency: ts - order.committedAt,
    });

    const { account, isNew } = await loadAccount(context, e.account, order.lane, event.block.number, ts);
    const [p, l, d] = countNewAccount(isNew, await loadProtocol(context), await loadLane(context, order.lane), await loadDay(context, ts));
    context.Account.set({
      ...account,
      ordersExecuted: account.ordersExecuted + 1,
      volume: account.volume + notional,
      realizedPnl: account.realizedPnl + e.realizedPnl,
      tradingFees: account.tradingFees + e.tradingFee,
      lastTimestamp: ts,
    });
    const market = await context.Market.get(lower(e.market));
    if (market) {
      context.Market.set({
        ...market,
        ordersExecuted: market.ordersExecuted + 1,
        volume: market.volume + notional,
        tradingFees: market.tradingFees + e.tradingFee,
      });
    }
    context.Lane.set({ ...l, ordersExecuted: l.ordersExecuted + 1, volume: l.volume + notional });
    context.DailyStat.set({
      ...d,
      ordersExecuted: d.ordersExecuted + 1,
      volume: d.volume + notional,
      tradingFees: d.tradingFees + e.tradingFee,
    });
    context.Protocol.set(
      stamp(
        {
          ...p,
          ordersExecuted: p.ordersExecuted + 1,
          volume: p.volume + notional,
          tradingFees: p.tradingFees + e.tradingFee,
          executionFeesPaid: p.executionFeesPaid + e.executionFee,
        },
        event.block.number,
        ts,
      ),
    );
  },
);

indexer.onEvent({ contract: "ParaclrClearinghouse", event: "OrderFailed", fields: FIELDS }, async ({ event, context }) => {
  const ts = event.block.timestamp;
  const order = await context.Order.get(event.params.orderId.toString());
  if (order) {
    context.Order.set({
      ...order,
      status: "Failed",
      executor: lower(event.params.executor),
      failReason: event.params.reason,
      resolvedBlock: BigInt(event.block.number),
      resolvedAt: ts,
      resolvedTx: event.transaction.hash,
      latency: ts - order.committedAt,
    });
  }
  const p = await loadProtocol(context);
  context.Protocol.set(stamp({ ...p, ordersFailed: p.ordersFailed + 1 }, event.block.number, ts));
});

indexer.onEvent(
  { contract: "ParaclrClearinghouse", event: "OrderCancelled", fields: FIELDS },
  async ({ event, context }) => {
    const ts = event.block.timestamp;
    const order = await context.Order.get(event.params.orderId.toString());
    if (order) {
      context.Order.set({
        ...order,
        status: "Cancelled",
        resolvedBlock: BigInt(event.block.number),
        resolvedAt: ts,
        resolvedTx: event.transaction.hash,
        latency: ts - order.committedAt,
      });
    }
    const p = await loadProtocol(context);
    context.Protocol.set(stamp({ ...p, ordersCancelled: p.ordersCancelled + 1 }, event.block.number, ts));
  },
);

indexer.onEvent(
  { contract: "ParaclrClearinghouse", event: "PositionUpdated", fields: FIELDS },
  async ({ event, context }) => {
    const e = event.params;
    context.PositionChange.set({
      id: `${event.block.number}_${event.logIndex}`,
      account: lower(e.account),
      lane: Number(e.lane),
      market_id: lower(e.market),
      isLong: e.isLong,
      size: e.size,
      entryPrice: e.entryPrice,
      entryNotional: e.entryNotional,
      margin: e.margin,
      price: e.price,
      realizedPnl: e.realizedPnl,
      block: BigInt(event.block.number),
      timestamp: event.block.timestamp,
      tx: event.transaction.hash,
    });
  },
);

indexer.onEvent(
  { contract: "ParaclrClearinghouse", event: "FundingUpdated", fields: FIELDS },
  async ({ event, context }) => {
    const market = await context.Market.get(lower(event.params.market));
    if (!market) return;
    context.Market.set({
      ...market,
      fundingRatePerSec: event.params.ratePerSec,
      fundingIndex: event.params.index,
      skewNotional: event.params.skewNotional,
      fundingUpdatedAt: event.block.timestamp,
    });
  },
);

// ---- per-lane auctions ---------------------------------------------------------------------

indexer.onEvent(
  { contract: "ParaclrClearinghouse", event: "AuctionStarted", fields: FIELDS },
  async ({ event, context }) => {
    const ts = event.block.timestamp;
    const e = event.params;
    // Unique per event: an account can be cured and re-auctioned in the same block, so
    // `${account}_${startBlock}` would overwrite the cured row.
    const id = `${lower(e.account)}_${event.block.number}_${event.logIndex}`;
    context.Auction.set({
      id,
      lane_id: String(Number(e.lane)),
      account: lower(e.account),
      status: "Active",
      startBlock: e.startBlock,
      startedAt: ts,
      startTx: event.transaction.hash,
      equityAtStart: e.equity,
      notional: e.notional,
      taker: undefined,
      byBackstop: undefined,
      discountBps: undefined,
      blocksElapsed: undefined,
      payment: undefined,
      traderResidual: undefined,
      badDebt: undefined,
      resolvedBlock: undefined,
      resolvedAt: undefined,
      resolvedTx: undefined,
    });
    const { account, isNew } = await loadAccount(context, e.account, e.lane, event.block.number, ts);
    const [p, l, d] = countNewAccount(isNew, await loadProtocol(context), await loadLane(context, e.lane), await loadDay(context, ts));
    context.Account.set({ ...account, auctions: account.auctions + 1, activeAuction: id, lastTimestamp: ts });
    context.Lane.set({ ...l, auctionsStarted: l.auctionsStarted + 1 });
    context.DailyStat.set({ ...d, auctionsStarted: d.auctionsStarted + 1 });
    context.Protocol.set(stamp({ ...p, auctionsStarted: p.auctionsStarted + 1 }, event.block.number, ts));
  },
);

/** The account's open auction, or undefined (and a warning) if its start wasn't indexed. */
async function openAuction(context: Ctx, accountAddress: string): Promise<{ account: Account; auction: Auction } | undefined> {
  const account = await context.Account.get(lower(accountAddress));
  const auction = account?.activeAuction ? await context.Auction.get(account.activeAuction) : undefined;
  if (!account || !auction) {
    context.log.warn(`auction outcome for ${accountAddress} without an open auction`);
    return undefined;
  }
  return { account, auction };
}

indexer.onEvent({ contract: "ParaclrClearinghouse", event: "AuctionTaken", fields: FIELDS }, async ({ event, context }) => {
  const ts = event.block.timestamp;
  const e = event.params;
  const open = await openAuction(context, e.account);
  if (open) {
    context.Auction.set({
      ...open.auction,
      status: "Taken",
      taker: lower(e.taker),
      byBackstop: e.backstop,
      discountBps: Number(e.discountBps),
      blocksElapsed: Number(e.blocksElapsed),
      payment: e.payment,
      traderResidual: e.traderResidual,
      badDebt: e.badDebt,
      resolvedBlock: BigInt(event.block.number),
      resolvedAt: ts,
      resolvedTx: event.transaction.hash,
    });
    context.Account.set({ ...open.account, activeAuction: undefined, lastTimestamp: ts });
  }
  const l = await loadLane(context, e.lane);
  context.Lane.set({
    ...l,
    auctionsTaken: l.auctionsTaken + 1,
    auctionsTakenByBackstop: l.auctionsTakenByBackstop + (e.backstop ? 1 : 0),
    backstopEarned: l.backstopEarned + (e.backstop ? e.payment : ZERO),
    notionalAbsorbed: l.notionalAbsorbed + (e.backstop ? e.notional : ZERO),
    equityReturned: l.equityReturned + e.traderResidual,
  });
  const d = await loadDay(context, ts);
  context.DailyStat.set({ ...d, auctionsTaken: d.auctionsTaken + 1, equityReturned: d.equityReturned + e.traderResidual });
  const p = await loadProtocol(context);
  context.Protocol.set(
    stamp(
      {
        ...p,
        auctionsTaken: p.auctionsTaken + 1,
        auctionsTakenByBackstop: p.auctionsTakenByBackstop + (e.backstop ? 1 : 0),
        auctionPayments: p.auctionPayments + e.payment,
        equityReturned: p.equityReturned + e.traderResidual,
      },
      event.block.number,
      ts,
    ),
  );
});

for (const kind of ["AuctionCancelled", "AuctionExpired"] as const) {
  indexer.onEvent({ contract: "ParaclrClearinghouse", event: kind, fields: FIELDS }, async ({ event, context }) => {
    const ts = event.block.timestamp;
    const cured = kind === "AuctionCancelled";
    const open = await openAuction(context, event.params.account);
    if (open) {
      context.Auction.set({
        ...open.auction,
        status: cured ? "Cured" : "Expired",
        badDebt: "badDebt" in event.params ? event.params.badDebt : undefined,
        resolvedBlock: BigInt(event.block.number),
        resolvedAt: ts,
        resolvedTx: event.transaction.hash,
      });
      context.Account.set({ ...open.account, activeAuction: undefined, lastTimestamp: ts });
    }
    const l = await loadLane(context, event.params.lane);
    context.Lane.set(cured ? { ...l, auctionsCured: l.auctionsCured + 1 } : { ...l, auctionsExpired: l.auctionsExpired + 1 });
    const p = await loadProtocol(context);
    context.Protocol.set(
      stamp(
        cured ? { ...p, auctionsCured: p.auctionsCured + 1 } : { ...p, auctionsExpired: p.auctionsExpired + 1 },
        event.block.number,
        ts,
      ),
    );
  });
}

// Bad debt is counted once, from the event the lane emits when it absorbs it (the auction
// outcome events carry the same amount for their own row).
indexer.onEvent(
  { contract: "ParaclrClearinghouse", event: "BadDebtRealized", fields: FIELDS },
  async ({ event, context }) => {
    const l = await loadLane(context, event.params.lane);
    context.Lane.set({ ...l, badDebt: l.badDebt + event.params.amount });
    const p = await loadProtocol(context);
    context.Protocol.set(stamp({ ...p, badDebt: p.badDebt + event.params.amount }, event.block.number, event.block.timestamp));
  },
);

// ---- lane insurance and backstop pools -----------------------------------------------------

indexer.onEvent({ contract: "ParaclrClearinghouse", event: "LaneFunded", fields: FIELDS }, async ({ event, context }) => {
  const e = event.params;
  context.BackstopFlow.set({
    id: `${event.block.number}_${event.logIndex}`,
    lane: Number(e.lane),
    lp: lower(e.funder),
    kind: "Deposit",
    insurance: true,
    amount: e.amount,
    shares: ZERO,
    readyAt: undefined,
    block: BigInt(event.block.number),
    timestamp: event.block.timestamp,
    tx: event.transaction.hash,
  });
  const l = await loadLane(context, e.lane);
  context.Lane.set({ ...l, insuranceFunded: l.insuranceFunded + e.amount });
  const p = await loadProtocol(context);
  context.Protocol.set(stamp({ ...p, insuranceFunded: p.insuranceFunded + e.amount }, event.block.number, event.block.timestamp));
});

for (const kind of ["BackstopDeposit", "BackstopWithdraw"] as const) {
  indexer.onEvent({ contract: "ParaclrClearinghouse", event: kind, fields: FIELDS }, async ({ event, context }) => {
    const e = event.params;
    const deposit = kind === "BackstopDeposit";
    context.BackstopFlow.set({
      id: `${event.block.number}_${event.logIndex}`,
      lane: Number(e.lane),
      lp: lower(e.lp),
      kind: deposit ? "Deposit" : "Withdraw",
      insurance: false,
      amount: e.amount,
      shares: e.shares,
      readyAt: undefined,
      block: BigInt(event.block.number),
      timestamp: event.block.timestamp,
      tx: event.transaction.hash,
    });
    const l = await loadLane(context, e.lane);
    context.Lane.set(
      deposit
        ? { ...l, backstopDeposited: l.backstopDeposited + e.amount }
        : { ...l, backstopWithdrawn: l.backstopWithdrawn + e.amount },
    );
    const p = await loadProtocol(context);
    context.Protocol.set(
      stamp(
        deposit
          ? { ...p, backstopDeposited: p.backstopDeposited + e.amount }
          : { ...p, backstopWithdrawn: p.backstopWithdrawn + e.amount },
        event.block.number,
        event.block.timestamp,
      ),
    );
  });
}

indexer.onEvent(
  { contract: "ParaclrClearinghouse", event: "BackstopWithdrawRequested", fields: FIELDS },
  async ({ event, context }) => {
    const e = event.params;
    context.BackstopFlow.set({
      id: `${event.block.number}_${event.logIndex}`,
      lane: Number(e.lane),
      lp: lower(e.lp),
      kind: "WithdrawRequested",
      insurance: false,
      amount: ZERO,
      shares: e.shares,
      readyAt: e.readyAt,
      block: BigInt(event.block.number),
      timestamp: event.block.timestamp,
      tx: event.transaction.hash,
    });
  },
);

// ---- guardian ------------------------------------------------------------------------------

for (const kind of ["Paused", "Unpaused"] as const) {
  indexer.onEvent({ contract: "ParaclrClearinghouse", event: kind, fields: FIELDS }, async ({ event, context }) => {
    const paused = kind === "Paused";
    context.GuardianAction.set({
      id: `${event.block.number}_${event.logIndex}`,
      paused,
      by: lower(event.params.by),
      block: BigInt(event.block.number),
      timestamp: event.block.timestamp,
      tx: event.transaction.hash,
    });
    const p = await loadProtocol(context);
    context.Protocol.set(stamp({ ...p, paused }, event.block.number, event.block.timestamp));
  });
}
