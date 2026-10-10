// Read-side client for the Envio indexer (indexer/): its GraphQL API over plain fetch.
// Optional: without NEXT_PUBLIC_ENVIO_GRAPHQL_URL the history and activity panels don't render.
// Amounts arrive as decimal strings in the contract's units (AUSD 6 decimals, size and price 18).

import { useEffect, useRef, useState } from "react";

export const INDEXER_URL = process.env.NEXT_PUBLIC_ENVIO_GRAPHQL_URL ?? "";
export const INDEXER_ON = INDEXER_URL !== "";

const AUSD = 1e6;
const WAD = 1e18;
export const ausd = (s: string | null | undefined): number => (s == null ? 0 : Number(s) / AUSD);
export const wad = (s: string | null | undefined): number => (s == null ? 0 : Number(s) / WAD);

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(INDEXER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`indexer HTTP ${res.status}`);
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors[0]!.message);
  if (!body.data) throw new Error("indexer returned no data");
  return body.data;
}

export type IndexedOrderStatus = "Pending" | "Executed" | "Failed" | "Cancelled";

export interface IndexedOrder {
  orderId: string;
  status: IndexedOrderStatus;
  sizeDelta: string;
  marginDelta: string;
  fillPrice: string | null;
  realizedPnl: string | null;
  tradingFee: string | null;
  notional: string | null;
  committedAt: number;
  resolvedAt: number | null;
  latency: number | null;
  committedTx: string;
  resolvedTx: string | null;
  market: { symbol: string };
}

export interface IndexerMeta {
  progressBlock: number;
  isReady: boolean;
}

const META = "_meta { progressBlock isReady }";

/** An account's orders, newest first. */
export async function fetchAccountOrders(account: string, limit = 30): Promise<{ orders: IndexedOrder[]; meta: IndexerMeta | null }> {
  const data = await gql<{ Order: IndexedOrder[]; _meta: IndexerMeta[] }>(
    `query ($a: String!, $n: Int!) {
      Order(where: { account_id: { _eq: $a } }, order_by: { committedBlock: desc }, limit: $n) {
        orderId status sizeDelta marginDelta fillPrice realizedPnl tradingFee notional
        committedAt resolvedAt latency committedTx resolvedTx market { symbol }
      }
      ${META}
    }`,
    { a: account.toLowerCase(), n: limit },
  );
  return { orders: data.Order, meta: data._meta[0] ?? null };
}

/** One finished auction of an account, with what the "what you kept" comparison needs. */
export interface IndexedAccountAuction {
  id: string;
  status: "Taken" | "Cured" | "Expired";
  startBlock: string;
  startedAt: number;
  /** Equity and notional at AuctionStarted (AUSD, 6 decimals; equity is signed). */
  equityAtStart: string;
  notional: string;
  byBackstop: boolean | null;
  taker: string | null;
  discountBps: number | null;
  blocksElapsed: number | null;
  payment: string | null;
  traderResidual: string | null;
  badDebt: string | null;
  resolvedAt: number | null;
  resolvedTx: string | null;
  lane: { index: number };
}

const ACCOUNT_AUCTION_FIELDS = `id status startBlock startedAt equityAtStart notional byBackstop taker discountBps
  blocksElapsed payment traderResidual badDebt resolvedAt resolvedTx lane { index }`;

/** An account's orders and finished auctions, newest first (one round trip). */
export async function fetchAccountHistory(
  account: string,
  limit = 30,
): Promise<{ orders: IndexedOrder[]; auctions: IndexedAccountAuction[]; meta: IndexerMeta | null }> {
  const data = await gql<{ Order: IndexedOrder[]; Auction: IndexedAccountAuction[]; _meta: IndexerMeta[] }>(
    `query ($a: String!, $n: Int!) {
      Order(where: { account_id: { _eq: $a } }, order_by: { committedBlock: desc }, limit: $n) {
        orderId status sizeDelta marginDelta fillPrice realizedPnl tradingFee notional
        committedAt resolvedAt latency committedTx resolvedTx market { symbol }
      }
      Auction(where: { account: { _eq: $a }, status: { _neq: Active } }, order_by: { startBlock: desc }, limit: $n) {
        ${ACCOUNT_AUCTION_FIELDS}
      }
      ${META}
    }`,
    { a: account.toLowerCase(), n: limit },
  );
  return { orders: data.Order, auctions: data.Auction, meta: data._meta[0] ?? null };
}

/** The account's finished auction resolved in `tx` (for its start equity / notional), or null. */
export async function fetchAuctionByTx(account: string, tx: string): Promise<IndexedAccountAuction | null> {
  const data = await gql<{ Auction: IndexedAccountAuction[] }>(
    `query ($a: String!, $t: String!) {
      Auction(where: { account: { _eq: $a }, resolvedTx: { _eq: $t } }, limit: 1) { ${ACCOUNT_AUCTION_FIELDS} }
    }`,
    { a: account.toLowerCase(), t: tx.toLowerCase() },
  );
  return data.Auction[0] ?? null;
}

export interface IndexedProtocol {
  accounts: number;
  ordersExecuted: number;
  ordersFailed: number;
  ordersCancelled: number;
  volume: string;
  tradingFees: string;
  auctionsStarted: number;
  auctionsTaken: number;
  auctionsTakenByBackstop: number;
  auctionsCured: number;
  auctionsExpired: number;
  auctionPayments: string;
  equityReturned: string;
  badDebt: string;
}

export interface IndexedAuction {
  id: string;
  account: string;
  status: "Active" | "Taken" | "Cured" | "Expired";
  startBlock: string;
  startedAt: number;
  notional: string;
  byBackstop: boolean | null;
  discountBps: number | null;
  blocksElapsed: number | null;
  payment: string | null;
  traderResidual: string | null;
  resolvedTx: string | null;
  startTx: string;
  lane: { index: number };
}

export interface IndexedActivity {
  protocol: IndexedProtocol | null;
  auctions: IndexedAuction[];
  firstDay: number | null;
  meta: IndexerMeta | null;
}

/** Clearinghouse totals since deploy and the latest auctions. */
export async function fetchActivity(limit = 12): Promise<IndexedActivity> {
  const data = await gql<{
    Protocol: IndexedProtocol[];
    Auction: IndexedAuction[];
    DailyStat: { dayStart: number }[];
    _meta: IndexerMeta[];
  }>(
    `query ($n: Int!) {
      Protocol {
        accounts ordersExecuted ordersFailed ordersCancelled volume tradingFees
        auctionsStarted auctionsTaken auctionsTakenByBackstop auctionsCured auctionsExpired
        auctionPayments equityReturned badDebt
      }
      Auction(order_by: { startBlock: desc }, limit: $n) {
        id account status startBlock startedAt notional byBackstop discountBps blocksElapsed
        payment traderResidual resolvedTx startTx lane { index }
      }
      DailyStat(order_by: { dayStart: asc }, limit: 1) { dayStart }
      ${META}
    }`,
    { n: limit },
  );
  return {
    protocol: data.Protocol[0] ?? null,
    auctions: data.Auction,
    firstDay: data.DailyStat[0]?.dayStart ?? null,
    meta: data._meta[0] ?? null,
  };
}

/**
 * Polls `load` every `ms` while mounted and the tab is visible (and once right away).
 * `key` restarts the polling when it changes; null disables it.
 */
export function usePolled<T>(key: string | null, load: () => Promise<T>, ms = 5_000) {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (key === null) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          const data = await loadRef.current();
          if (live) setState({ data, error: null });
        } catch (e) {
          if (live) setState((s) => ({ data: s.data, error: (e as Error).message }));
        }
      }
      if (live) timer = setTimeout(tick, ms);
    };
    setState({ data: null, error: null });
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, ms]);

  return state;
}
