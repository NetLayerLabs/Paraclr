"use client";

// Clearinghouse activity since deploy and the latest auctions, read from the Envio indexer
// (indexer/). The live lanes above come from the contract; this is their history.

import Link from "next/link";
import { ausd, fetchActivity, INDEXER_ON, usePolled, type IndexedAuction } from "@/lib/indexer";
import { TxLink } from "@/components/chain/ChainUi";
import { shortAddress } from "@/lib/auth/demo";
import { fmtAusd, fmtCompact } from "@/components/trade/format";
import styles from "./IndexedActivity.module.css";

const OUTCOME: Record<IndexedAuction["status"], string> = {
  Active: "In auction",
  Taken: "Taken",
  Cured: "Cured",
  Expired: "Expired",
};

function outcome(a: IndexedAuction): string {
  if (a.status !== "Taken") return OUTCOME[a.status];
  const by = a.byBackstop ? "by the backstop" : "externally";
  return `Taken ${by} · ${((a.discountBps ?? 0) / 100).toFixed(2)}% after ${a.blocksElapsed ?? 0} blocks`;
}

export function IndexedActivity() {
  const { data, error } = usePolled(INDEXER_ON ? "activity" : null, () => fetchActivity(), 6_000);
  if (!INDEXER_ON) return null;
  const p = data?.protocol ?? null;
  const since = data?.firstDay
    ? new Date(data.firstDay * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : null;

  const tiles: { label: string; value: string; title?: string }[] = p
    ? [
        { label: "Volume", value: `${fmtCompact(ausd(p.volume))} AUSD`, title: "Sum of |size| × fill price over filled orders" },
        { label: "Trades", value: p.ordersExecuted.toLocaleString("en-US") },
        { label: "Accounts", value: p.accounts.toLocaleString("en-US") },
        { label: "Fees to insurance", value: `${fmtAusd(ausd(p.tradingFees))} AUSD` },
        { label: "Auctions", value: p.auctionsStarted.toLocaleString("en-US") },
        {
          label: "Taken · cured · expired",
          value: `${p.auctionsTaken} · ${p.auctionsCured} · ${p.auctionsExpired}`,
          title: `${p.auctionsTakenByBackstop} of the takes by a lane's backstop pool`,
        },
        { label: "Paid to takers", value: `${fmtAusd(ausd(p.auctionPayments))} AUSD`, title: "Discount × notional" },
        { label: "Returned to traders", value: `${fmtAusd(ausd(p.equityReturned))} AUSD`, title: "Equity left after each take" },
      ]
    : [];

  return (
    <section className={styles.section} aria-labelledby="activity-title">
      <header className={styles.head}>
        <h3 id="activity-title" className={styles.title}>
          Since deploy
        </h3>
        {data?.meta && (
          <span className={styles.note} title="Indexed from on-chain events by Envio HyperIndex">
            indexed by Envio · #{data.meta.progressBlock.toLocaleString("en-US")}
            {since ? ` · since ${since}` : ""}
          </span>
        )}
      </header>

      {error && !data && <p className={styles.error}>Couldn&apos;t reach the indexer: {error}</p>}

      {p && (
        <dl className={styles.tiles}>
          {tiles.map((t) => (
            <div key={t.label} className={styles.tile} title={t.title}>
              <dt>{t.label}</dt>
              <dd className="mono">{t.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {data && (
        <div className={styles.auctions}>
          <h4 className={styles.subTitle}>Latest auctions</h4>
          {data.auctions.length === 0 ? (
            <p className={styles.empty}>
              None yet. An account goes to auction when it falls below maintenance margin; on real prices that takes a
              large market move against a leveraged position. To watch auctions clear now, crash the demo market in the{" "}
              <Link href="/arena">Arena</Link>.
            </p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Lane</th>
                    <th>Account</th>
                    <th>Outcome</th>
                    <th className={styles.num}>Notional</th>
                    <th className={styles.num}>Paid to taker</th>
                    <th className={styles.num}>Back to trader</th>
                    <th>Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {data.auctions.map((a) => (
                    <tr key={a.id}>
                      <td className="mono">L{a.lane.index}</td>
                      <td className="mono">{shortAddress(a.account, 6, 4)}</td>
                      <td data-status={a.status} className={styles.outcome}>
                        {outcome(a)}
                      </td>
                      <td className={`mono ${styles.num}`}>{fmtAusd(ausd(a.notional))}</td>
                      <td className={`mono ${styles.num}`}>{a.payment ? fmtAusd(ausd(a.payment)) : "-"}</td>
                      <td className={`mono ${styles.num}`}>{a.traderResidual ? fmtAusd(ausd(a.traderResidual)) : "-"}</td>
                      <td>
                        <TxLink hash={a.resolvedTx ?? a.startTx} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
