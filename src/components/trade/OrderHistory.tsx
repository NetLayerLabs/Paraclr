"use client";

// The signed-in account's order history, read from the Envio indexer (indexer/): every delayed
// order with its fill, realized PnL, fee, time to fill and transaction. Positions stay on the
// contract read; this is the record of how they got there.

import { useParaclr } from "@/lib/store";
import { ausd, fetchAccountOrders, INDEXER_ON, usePolled, wad, type IndexedOrder } from "@/lib/indexer";
import { MARKETS, type MarketSymbol } from "@/lib/types";
import { TxLink } from "@/components/chain/ChainUi";
import { fmtAusd, fmtPrice, fmtSigned, fmtSize } from "./format";
import styles from "./OrderHistory.module.css";

const isMarket = (s: string): s is MarketSymbol => (MARKETS as readonly string[]).includes(s);

function when(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
}

const STATUS: Record<IndexedOrder["status"], string> = {
  Pending: "Pending",
  Executed: "Filled",
  Failed: "Not filled",
  Cancelled: "Cancelled",
};

function Row({ o }: { o: IndexedOrder }) {
  const symbol = isMarket(o.market.symbol) ? o.market.symbol : null;
  const size = wad(o.sizeDelta);
  const pnl = ausd(o.realizedPnl);
  const filled = o.status === "Executed";
  return (
    <tr>
      <td className="mono">{when(o.resolvedAt ?? o.committedAt)}</td>
      <td>{o.market.symbol.replace("/AUSD", "")}</td>
      <td className={size >= 0 ? styles.buy : styles.sell}>{size >= 0 ? "Buy" : "Sell"}</td>
      <td className={`mono ${styles.num}`}>{symbol ? fmtSize(symbol, Math.abs(size)) : Math.abs(size).toFixed(4)}</td>
      <td className={`mono ${styles.num}`}>{filled && symbol ? fmtPrice(symbol, wad(o.fillPrice)) : "—"}</td>
      <td className={`mono ${styles.num} ${pnl > 0 ? styles.up : pnl < 0 ? styles.down : ""}`}>
        {filled && o.realizedPnl !== "0" ? fmtSigned(pnl) : "—"}
      </td>
      <td className={`mono ${styles.num}`}>{filled ? fmtAusd(ausd(o.tradingFee), 4) : "—"}</td>
      <td>
        <span className={styles.status} data-status={o.status}>
          {STATUS[o.status]}
        </span>
        {o.latency !== null && filled && <span className={styles.latency}> in {o.latency}s</span>}
      </td>
      <td>
        <TxLink hash={o.resolvedTx ?? o.committedTx} />
      </td>
    </tr>
  );
}

export function OrderHistory() {
  const address = useParaclr((s) => s.session?.address ?? null);
  const { data, error } = usePolled(INDEXER_ON && address ? address : null, () => fetchAccountOrders(address!), 5_000);
  const orders = data?.orders ?? [];

  return (
    <section className={styles.section} aria-labelledby="history-title">
      <header className={styles.head}>
        <h2 id="history-title" className={styles.title}>
          Order history
          {data?.meta && (
            <span className={styles.note} title="Indexed from on-chain events by Envio HyperIndex">
              indexed by Envio · #{data.meta.progressBlock.toLocaleString("en-US")}
            </span>
          )}
        </h2>
      </header>

      {error && !data && <p className={styles.error}>Couldn&apos;t reach the indexer: {error}</p>}

      {data && orders.length === 0 ? (
        <div className={styles.empty}>
          <p>No orders yet</p>
          <span>Every order you commit shows up here with its fill price, realized PnL and fee.</span>
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Time</th>
                <th>Market</th>
                <th>Side</th>
                <th className={styles.num}>Size</th>
                <th className={styles.num}>Fill price</th>
                <th className={styles.num}>Realized PnL</th>
                <th className={styles.num}>Fee</th>
                <th>Status</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {!data && (
                <tr>
                  <td colSpan={9} className={styles.loading}>
                    Loading history…
                  </td>
                </tr>
              )}
              {orders.map((o) => (
                <Row key={o.orderId} o={o} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
