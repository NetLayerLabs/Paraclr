"use client";

// Result of a real flash-crash run (crash run v2: auction liquidations).
// Every number is from the keeper's RunReport (its clock, its receipts) or
// from the clearinghouse's auction events - nothing here is modeled.

import { demoTakers, type RunReport } from "@/lib/chain/keeper";
import type { AuctionRecord } from "@/lib/chain/auctionFeed";
import { fmtBps } from "@/lib/chain/fair";
import { blockUrl } from "@/lib/chain/config";
import { fmtGas, parseAusdString, parseBigIntString, shortHash } from "@/lib/chain/units";
import { TxLink } from "@/components/chain/ChainUi";
import { fmtAusd, fmtCompact as fmtAusdCompact } from "@/components/trade/format";
import { fmtMs } from "./format";
import styles from "./ClearingScreen.module.css";

function BlockRef({ block }: { block: number | null }) {
  if (block === null) return <span className="mono">-</span>;
  const url = blockUrl(block);
  return url ? (
    <a className="mono" href={url} target="_blank" rel="noreferrer">
      #{block} ↗
    </a>
  ) : (
    <span className="mono">#{block}</span>
  );
}

const KIND_LABEL: Record<string, string> = {
  startAuctions: "start",
  backstopTakeBatch: "backstop take",
  expireBatch: "expire",
  cancelAuction: "cancel",
  liquidateBatch: "liquidate",
};

const MAX_ROWS = 24;

export function LiveResultCard({
  report,
  records,
  me,
}: {
  report: RunReport;
  records: ReadonlyMap<string, AuctionRecord>;
  me: string | null;
}) {
  const isMonad = report.network === "monad-testnet";
  const where = isMonad ? "Monad testnet" : "local anvil - not Monad";
  const { totals, shock, auctions, underwater } = report;
  const blocks = totals.blocks.length
    ? totals.blocks
    : [...new Set(report.batches.map((b) => b.block).filter((b): b is number => b !== null))].sort((a, b) => a - b);
  const keepers = new Set(report.batches.map((b) => b.keeper.toLowerCase())).size;
  const lanesTouched = new Set(report.batches.map((b) => b.lane)).size;
  const gas = parseBigIntString(totals.totalGasUsed) || report.batches.reduce((s, b) => s + parseBigIntString(b.gasUsed), BigInt(0));
  const shockMs = shock.confirmedAt && shock.submittedAt ? shock.confirmedAt - shock.submittedAt : null;
  const shockPct = Math.round((10_000 - shock.bps) / 100);
  const mine = me ? (records.get(me) ?? null) : null;
  const takes = auctions ? auctions.takenByBackstop + auctions.takenExternal : 0;
  const rows = report.batches.slice().sort((a, b) => (a.block ?? 0) - (b.block ?? 0) || a.lane - b.lane);
  const blockSpan =
    blocks.length === 0 ? "-" : blocks.length <= 3 ? blocks.map((b) => `#${b}`).join(" ") : `#${blocks[0]}–#${blocks[blocks.length - 1]}`;

  return (
    <section className={`${styles.result} ${styles.resultLive}`} data-net={isMonad ? "monad" : "anvil"}>
      <div className={styles.resultMain}>
        <div className={styles.resultKicker} data-net={isMonad ? "monad" : "anvil"}>
          Measured on {where}
          {report.status === "failed" ? " · run failed" : ""}
        </div>
        {auctions ? (
          <h2 className={styles.resultHead}>
            <span className="mono">{auctions.started}</span> underwater account{auctions.started === 1 ? "" : "s"} auctioned
            {underwater && (
              <>
                , resolved within <span className={`${styles.resultMs} mono`}>{underwater.maxBlocks} blocks</span>
              </>
            )}
            {takes > 0 ? (
              <>
                {" "}
                · traders kept <span className="mono">{fmtAusdCompact(parseAusdString(auctions.traderResidualReturned))}</span>{" "}
                AUSD
              </>
            ) : auctions.cured > 0 ? (
              <> · {auctions.cured} cured</>
            ) : null}
          </h2>
        ) : (
          <h2 className={styles.resultHead}>
            <span className="mono">{totals.liquidated}</span> accounts resolved in{" "}
            <span className={`${styles.resultMs} mono`}>{fmtMs(totals.wallClockMs)}</span> wall-clock
          </h2>
        )}

        <div className={styles.resultGrid}>
          <div>
            <small>Shock block</small>
            <b className="mono">{shock.block !== null ? `#${shock.block}` : "-"}</b>
          </div>
          <div>
            <small>Sweeper blocks</small>
            <b className="mono" style={{ fontSize: blockSpan.length > 12 ? 12 : undefined }}>
              {blockSpan}
            </b>
          </div>
          <div>
            <small>Sweeper txs</small>
            <b className="mono">{report.batches.length}</b>
          </div>
          <div>
            <small>Total gas</small>
            <b className="mono">{fmtGas(gas)}</b>
          </div>
          <div>
            <small>Scanned</small>
            <b className="mono">{totals.accountsScanned}</b>
          </div>
          <div>
            <small>Avg discount</small>
            <b className="mono">{takes > 0 && auctions ? fmtBps(auctions.avgDiscountBps) : "-"}</b>
          </div>
        </div>

        <p className={styles.shockRow}>
          Oracle shock −{shockPct}% on all markets in one tx: block <BlockRef block={shock.block} />
          {shockMs !== null && <> · {shockMs} ms submit → receipt</>} · <TxLink hash={shock.txHash} />
          <br />
          Sweeper txs for {lanesTouched} lane{lanesTouched === 1 ? "" : "s"} sent concurrently from {keepers} keeper wallet
          {keepers === 1 ? "" : "s"} (one per lane).
        </p>

        {mine && mine.status !== "active" && <YourOutcome r={mine} />}
      </div>

      {rows.length > 0 && (
        <div className={styles.resultSide}>
          <table className={styles.laneTable}>
            <thead>
              <tr>
                <th>Lane</th>
                <th>Step</th>
                <th>Acc</th>
                <th>Block</th>
                <th>Submit→rcpt</th>
                <th>Gas</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, MAX_ROWS).map((b) => (
                <tr key={b.txHash}>
                  <td>{b.lane + 1}</td>
                  <td>{b.kind ? (KIND_LABEL[b.kind] ?? b.kind) : "-"}</td>
                  <td className="mono">{b.accounts}</td>
                  <td>
                    <BlockRef block={b.block} />
                  </td>
                  <td className="mono">{b.confirmedAt ? `${b.confirmedAt - b.submittedAt} ms` : "-"}</td>
                  <td className="mono">{fmtGas(parseBigIntString(b.gasUsed))}</td>
                  <td>
                    <TxLink hash={b.txHash} label={shortHash(b.txHash, 4, 3)} />
                  </td>
                </tr>
              ))}
              {rows.length > MAX_ROWS && (
                <tr>
                  <td colSpan={7} className={styles.moreRow}>
                    +{rows.length - MAX_ROWS} more sweeper txs in the run report
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <p className={styles.note}>
        Measured by the keeper on {where}. Time underwater runs from the first block an account was liquidatable to
        the block its auction resolved; the milliseconds are the keeper&apos;s clock (submit → receipt seen), so they
        include RPC round-trips and block inclusion - not EVM execution time. Auction prices come from the block
        clock, not from gas bidding.
        {!isMonad && " Anvil executes sequentially - these numbers say nothing about Monad's parallel execution."}
      </p>
    </section>
  );
}

function YourOutcome({ r }: { r: AuctionRecord }) {
  const tone =
    r.status === "cured" ? "var(--long-text)" : r.status === "expired" ? "var(--short-text)" : r.status === "backstop" ? "var(--accent-text)" : "var(--link-text)";
  return (
    <div className={styles.userResult} style={{ borderColor: tone }}>
      <small>Your account · Lane {r.lane + 1}</small>
      <b style={{ color: tone }}>
        {r.status === "backstop" && `Taken by the lane ${r.lane + 1} backstop at ${fmtBps(r.discountBps ?? 0)}`}
        {r.status === "external" &&
          `Taken by ${r.taker && demoTakers.has(r.taker) ? "a keeper-run demo taker bot" : "an external same-lane taker"} at ${fmtBps(r.discountBps ?? 0)}`}
        {r.status === "cured" && "Auction cured - your account is healthy again"}
        {r.status === "expired" && "Auction expired with no taker - closed at mark against the lane"}
      </b>
      <span className="mono">
        {r.traderResidual !== null && <>you kept {fmtAusd(r.traderResidual)} AUSD · </>}
        {r.resolvedBlock !== null && <>block #{r.resolvedBlock} · </>}
        <TxLink hash={r.txHash} />
      </span>
    </div>
  );
}
