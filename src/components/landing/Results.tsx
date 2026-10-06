import type { CSSProperties } from "react";
import type { AuctionOutcome, BenchRun, LandingEvidence } from "./benchResults.server";
import { ArrowUpRight } from "./icons";
import { GITHUB_TREE, MONAD_EXPLORER } from "./content";
import { fmtAusd, fmtBlocks, fmtCompact, fmtInt, fmtPct, fmtRunDate, shortHash } from "./format";
import ui from "./Landing.module.css";
import styles from "./Results.module.css";

type Net = "monad" | "anvil";

function shockLabel(bps: number | null): string {
  if (bps === null || bps >= 10_000) return "a price shock";
  return `a −${(10_000 - bps) / 100}% shock`;
}

/** Accounts that went underwater: v1 = liquidated by liquidateBatch, v2 = auctions started. */
function underwaterCount(run: BenchRun): number | null {
  return run.auctions ? run.auctions.started : run.liquidated;
}

function Tiles({ run }: { run: BenchRun }) {
  const oneBlock = run.sameBlock && run.blocks.length === 1;
  const under = underwaterCount(run);
  const uw = run.underwater;
  return (
    <dl className={styles.tiles}>
      <div className={styles.tile}>
        <dt>Accounts scanned</dt>
        <dd className={styles.tileValue}>{fmtInt(run.accountsScanned)}</dd>
        <dd className={styles.tileSub}>
          {run.accountsSeeded
            ? `${fmtInt(run.accountsSeeded)} seeded on-chain${run.seedTxCount ? ` in ${fmtInt(run.seedTxCount)} txs` : ""}`
            : "registered across the 8 lanes"}
        </dd>
      </div>
      <div className={styles.tile}>
        <dt>{run.auctions ? "Went to auction" : "Liquidated"}</dt>
        <dd className={styles.tileValue}>{under === null ? "–" : fmtInt(under)}</dd>
        <dd className={styles.tileSub}>
          {under === null ? "–" : fmtPct(under, run.accountsScanned)} of scanned, after {shockLabel(run.shockBps)}
        </dd>
      </div>
      {run.auctions && uw && uw.maxBlocks !== null ? (
        <div className={styles.tile}>
          <dt>Longest time underwater</dt>
          <dd className={styles.tileValue}>
            {fmtInt(uw.maxBlocks)}
            <span className={styles.tileOf}> blocks</span>
          </dd>
          <dd className={styles.tileSub}>
            {uw.p50Blocks !== null ? `p50 ${fmtInt(uw.p50Blocks)} · ` : ""}
            {uw.p95Blocks !== null ? `p95 ${fmtInt(uw.p95Blocks)} · ` : ""}
            {uw.maxMs !== null ? `max ${fmtInt(uw.maxMs)} ms on the keeper's clock` : "shock block → resolved"}
          </dd>
        </div>
      ) : (
        <div className={styles.tile}>
          <dt>{run.auctions ? "Gas per account" : "Gas per liquidation"}</dt>
          <dd className={styles.tileValue}>
            {run.gasPerLiquidation !== null
              ? fmtInt(run.gasPerLiquidation)
              : under
                ? fmtInt(Math.round(run.totalGasUsed / under))
                : "–"}
          </dd>
          <dd className={styles.tileSub}>
            {fmtCompact(run.totalGasUsed)} gas across {run.batchCount} lane txs
          </dd>
        </div>
      )}
      <div className={styles.tile}>
        <dt>{oneBlock ? "Lane txs in one block" : "Blocks used by lane txs"}</dt>
        <dd className={styles.tileValue}>
          {oneBlock ? (
            <>
              {run.batchCount}
              <span className={styles.tileOf}> / {run.batchCount}</span>
            </>
          ) : (
            run.blocks.length
          )}
        </dd>
        <dd className={styles.tileSub}>{oneBlock ? `all in block #${run.blocks[0]}` : `split across ${fmtBlocks(run.blocks)}`}</dd>
      </div>
    </dl>
  );
}

const OUTCOME_LABEL: Record<AuctionOutcome, string> = {
  backstop: "taken by backstop",
  external: "taken externally",
  cured: "cured",
  expired: "expired",
};

function LaneOutcomes({ run }: { run: BenchRun }) {
  const per = run.underwater?.perLane ?? [];
  const totals = per.map((l) => l.backstop + l.external + l.cured + l.expired);
  const max = Math.max(1, ...totals);
  return (
    <figure className={`${ui.card} ${styles.chart}`}>
      <figcaption className={styles.chartHead}>
        <span className={styles.chartTitle}>Auction outcomes per lane</span>
        <span className={styles.chartSub}>every underwater account, by how it resolved</span>
      </figcaption>
      <ol className={styles.bars}>
        {per.map((l, lane) => {
          const tip = `Lane ${lane}: ${(Object.keys(OUTCOME_LABEL) as AuctionOutcome[]).map((o) => `${l[o]} ${OUTCOME_LABEL[o]}`).join(", ")}`;
          return (
            <li key={lane} className={styles.barRow} tabIndex={0} aria-label={tip}>
              <span className={styles.barLane}>L{lane}</span>
              <span className={styles.barTrack}>
                <span className={styles.stack} style={{ "--w": `${(totals[lane] / max) * 100}%` } as CSSProperties}>
                  {(Object.keys(OUTCOME_LABEL) as AuctionOutcome[]).map((o) =>
                    l[o] ? <i key={o} className={styles[`seg_${o}`]} style={{ flexGrow: l[o] }} /> : null,
                  )}
                </span>
                <span className={styles.barValue} style={{ "--w": `${(totals[lane] / max) * 100}%` } as CSSProperties}>
                  {fmtInt(totals[lane])}
                </span>
              </span>
              <span className={styles.barGas}>{l.backstop} backstop</span>
              <span className={styles.tip} role="tooltip">
                <b>Lane {lane}</b>
                {(Object.keys(OUTCOME_LABEL) as AuctionOutcome[]).map((o) => (
                  <span key={o}>
                    {fmtInt(l[o])} {OUTCOME_LABEL[o]}
                  </span>
                ))}
              </span>
            </li>
          );
        })}
      </ol>
      <p className={styles.segLegend}>
        {(Object.keys(OUTCOME_LABEL) as AuctionOutcome[]).map((o) => (
          <span key={o}>
            <i className={styles[`seg_${o}`]} /> {OUTCOME_LABEL[o]}
          </span>
        ))}
      </p>
    </figure>
  );
}

function AuctionMetrics({ run }: { run: BenchRun }) {
  const a = run.auctions;
  if (!a) return <AuctionPending />;
  const money: { k: string; v: number | null; sub: string; tone?: "good" | "bad" }[] = [
    { k: "Equity returned to traders", v: a.traderResidualReturned, sub: "Σ max(0, E − P) over taken accounts", tone: "good" },
    { k: "Paid to backstop pools", v: a.backstopPaid, sub: "the discount the lane pools earned" },
    { k: "Bad debt", v: a.badDebt, sub: "beyond lane insurance", tone: a.badDebt ? "bad" : undefined },
    {
      k: "Old fixed-penalty path, counterfactual",
      v: a.legacyTraderLoss,
      sub: "what the old fixed-fee liquidation path would have taken from the same traders (keeper-computed)",
    },
  ];
  return (
    <div className={styles.auctionBlock}>
      <p className={styles.tableTitle}>Auction outcome</p>
      <dl className={styles.outcomes}>
        {(
          [
            ["Taken by backstop", a.takenByBackstop],
            ["Taken externally", a.takenExternal],
            ["Cured", a.cured],
            ["Expired", a.expired],
            ["Avg discount at take", a.avgDiscountBps],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className={styles.outcome}>
            <dt>{k}</dt>
            <dd>
              {v === null ? "–" : fmtInt(v)}
              {k === "Avg discount at take" && v !== null ? <span className={styles.tileOf}> bps</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      <dl className={styles.money}>
        {money.map((m) => (
          <div key={m.k} className={styles.moneyTile}>
            <dt>{m.k}</dt>
            <dd className={m.tone === "good" ? styles.good : m.tone === "bad" ? styles.bad : undefined}>
              {m.v === null ? "–" : fmtAusd(m.v)}
              <span className={styles.unit}> AUSD</span>
            </dd>
            <dd className={styles.tileSub}>{m.sub}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function AuctionPending() {
  return (
    <div className={styles.auctionBlock}>
      <p className={styles.tableTitle}>
        Auction outcome <span className={styles.pendingInline}>pending</span>
      </p>
      <dl className={styles.ghostRow} aria-label="Auction metrics, not measured yet">
        {[
          "Taken by backstop",
          "Cured",
          "Expired",
          "Time underwater (max)",
          "Equity returned to traders",
          "Old fixed-penalty path, counterfactual",
        ].map((k) => (
          <div key={k} className={styles.ghostTile}>
            <dt>{k}</dt>
            <dd>pending</dd>
          </div>
        ))}
      </dl>
      <p className={styles.footnote}>
        This run predates auctions: it used the old <code className={ui.code}>liquidateBatch</code> path (close at
        mark, 1% fee). The next <code className={ui.code}>npm run bench</code> writes a RunReport with{" "}
        <code className={ui.code}>auctions</code> and <code className={ui.code}>underwater</code>, and these tiles fill
        in from it.
      </p>
    </div>
  );
}

function LaneBars({ run, net }: { run: BenchRun; net: Net }) {
  const max = Math.max(1, ...run.lanes.map((l) => l.liquidated));
  return (
    <figure className={`${ui.card} ${styles.chart}`}>
      <figcaption className={styles.chartHead}>
        <span className={styles.chartTitle}>Liquidations per lane batch</span>
        <span className={styles.chartSub}>one liquidateBatch per lane, 8 keeper wallets</span>
      </figcaption>
      <ol className={styles.bars}>
        {run.lanes.map((l) => {
          const tip = `Lane ${l.lane}: ${fmtInt(l.liquidated)} of ${fmtInt(l.accounts)} accounts liquidated · ${fmtInt(l.gasUsed)} gas · block ${l.block === null ? "–" : `#${l.block}`}`;
          return (
            <li key={l.lane} className={styles.barRow} tabIndex={0} aria-label={tip}>
              <span className={styles.barLane}>L{l.lane}</span>
              <span className={styles.barTrack}>
                <span className={styles.bar} style={{ "--w": `${(l.liquidated / max) * 100}%` } as CSSProperties} />
                <span className={styles.barValue} style={{ "--w": `${(l.liquidated / max) * 100}%` } as CSSProperties}>
                  {fmtInt(l.liquidated)}
                </span>
              </span>
              <span className={styles.barGas}>{fmtCompact(l.gasUsed)} gas</span>
              <span className={styles.tip} role="tooltip">
                <b>Lane {l.lane}</b>
                <span>
                  {fmtInt(l.liquidated)} / {fmtInt(l.accounts)} accounts liquidated
                </span>
                <span>{fmtInt(l.gasUsed)} gas used</span>
                <span>block {l.block === null ? "–" : `#${l.block}`}</span>
                {l.txHash ? <span className={styles.tipHash}>tx {shortHash(l.txHash, 8, 6)}</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
      {net === "monad" ? (
        <p className={styles.chartFoot}>
          {run.lanes
            .filter((l) => l.txHash)
            .map((l) => (
              <a key={l.lane} href={`${MONAD_EXPLORER}/tx/${l.txHash}`} target="_blank" rel="noreferrer" className={styles.txLink}>
                L{l.lane} {shortHash(l.txHash)}
              </a>
            ))}
        </p>
      ) : (
        <p className={styles.chartFoot}>
          Local anvil tx hashes are in the JSON. They don&rsquo;t resolve on any public explorer.
        </p>
      )}
    </figure>
  );
}

function RunsTable({ runs, net }: { runs: BenchRun[]; net: Net }) {
  return (
    <div className={styles.tableWrap} tabIndex={0} role="region" aria-label={net === "monad" ? "Monad testnet runs" : "Local anvil runs"}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Run (UTC)</th>
            <th scope="col">Mechanism</th>
            <th scope="col">Accounts</th>
            <th scope="col">Underwater</th>
            <th scope="col">Lane txs</th>
            <th scope="col">Block(s)</th>
            <th scope="col">One block?</th>
            <th scope="col">Gas / acct.</th>
            <th scope="col">Total gas</th>
            <th scope="col">Wall-clock*</th>
          </tr>
        </thead>
        <tbody>
          {[...runs].reverse().map((r) => (
            <tr key={r.file}>
              <th scope="row">
                <span className={styles.runDate}>{fmtRunDate(r.startedAt)}</span>
                <span className={styles.runFile}>{r.file}</span>
              </th>
              <td className={styles.mech}>{r.auctions ? "auction" : "fixed fee"}</td>
              <td>{fmtInt(r.accountsScanned)}</td>
              <td>{underwaterCount(r) === null ? "–" : fmtInt(underwaterCount(r)!)}</td>
              <td>{r.batchCount}</td>
              <td>{fmtBlocks(r.blocks)}</td>
              <td>
                <span className={r.sameBlock ? styles.yes : styles.no}>{r.sameBlock ? "yes" : "no"}</span>
              </td>
              <td>
                {r.gasPerLiquidation !== null
                  ? fmtInt(r.gasPerLiquidation)
                  : underwaterCount(r)
                    ? fmtInt(Math.round(r.totalGasUsed / underwaterCount(r)!))
                    : "–"}
              </td>
              <td>{fmtInt(r.totalGasUsed)}</td>
              <td>{fmtInt(r.wallClockMs)} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MonadPending() {
  return (
    <div className={styles.pending}>
      <div className={styles.pendingCopy}>
        <span className={styles.pendingPill}>
          <span className={styles.pendingDot} aria-hidden="true" />
          Monad testnet · chain 10143
        </span>
        <h3 className={styles.pendingTitle}>Monad testnet run: pending</h3>
        <p className={styles.pendingBody}>
          The headline numbers will come from a real −20% crash on Monad testnet. When that run is committed as{" "}
          <code className={ui.code}>bench/results/10143-*.json</code>, this card fills in from it automatically: accounts,
          auctions and how they resolved, time underwater, equity returned to traders, block numbers and explorer links.
        </p>
      </div>
      <dl className={styles.ghostTiles} aria-label="Monad testnet metrics, not measured yet">
        {["Accounts scanned", "Went to auction", "Longest time underwater", "Equity returned to traders"].map((k) => (
          <div key={k} className={styles.ghostTile}>
            <dt>{k}</dt>
            <dd>pending</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function Results({ evidence }: { evidence: LandingEvidence }) {
  const { anvilHeadline: anvil, monadHeadline: monad } = evidence;
  return (
    <section id="results" className={`${ui.section} ${ui.sectionAlt}`} aria-labelledby="results-title">
      <div className={ui.container}>
        <div className={ui.sectionHead}>
          <p className={ui.eyebrow}>Results</p>
          <h2 id="results-title" className={ui.h2}>
            Measured, labelled, <em>committed.</em>
          </h2>
          <p className={ui.lede}>
            Every number in this section is read from the RunReport JSON files in{" "}
            <a className={ui.link} href={`${GITHUB_TREE}/bench/results`} target="_blank" rel="noreferrer">
              bench/results/
            </a>{" "}
            when the page is built. Each run seeds accounts with <code className={ui.code}>seedAccounts</code>, shocks
            every market in one oracle tx, then 8 lane keepers resolve every underwater account, each from its own
            key.
          </p>
        </div>

        {/* ---- Monad testnet ---------------------------------------------------- */}
        {monad ? (
          <div className={styles.block}>
            <div className={styles.bannerMonad}>
              <span className={styles.bannerIcon} aria-hidden="true">
                ◆
              </span>
              <div>
                <p className={styles.bannerTitle}>Measured on Monad testnet (chain 10143)</p>
                <p className={styles.bannerSub}>
                  {fmtRunDate(monad.startedAt)} · {monad.file} · tx links open the Monad testnet explorer
                </p>
              </div>
            </div>
            <div className={styles.split}>
              <Tiles run={monad} />
              {monad.auctions && monad.underwater?.accounts ? <LaneOutcomes run={monad} /> : <LaneBars run={monad} net="monad" />}
            </div>
            <AuctionMetrics run={monad} />
            <RunsTable runs={evidence.monadRuns} net="monad" />
          </div>
        ) : (
          <MonadPending />
        )}

        {/* ---- Local anvil ------------------------------------------------------ */}
        {anvil ? (
          <div className={styles.block}>
            <div className={styles.bannerAnvil} role="note">
              <span className={styles.bannerIconWarn} aria-hidden="true">
                !
              </span>
              <div>
                <p className={styles.bannerTitle}>Measured on local anvil — not Monad.</p>
                <p className={styles.bannerSub}>
                  {monad
                    ? "anvil executes sequentially. Kept for reference: these runs check the contracts and the keeper end to end and say nothing about Monad's parallel execution. The Monad testnet run is above."
                    : "anvil executes sequentially; Monad testnet numbers coming. These runs check the contracts and the keeper end to end. They say nothing about Monad's parallel execution."}
                </p>
              </div>
              <span className={styles.bannerChip}>
                chain {anvil.chainId}
                {anvil.clientVersion ? ` · ${anvil.clientVersion}` : ""}
              </span>
            </div>

            <p className={styles.runLabel}>
              {anvil.auctions ? "Largest auction run" : "Largest run"} · {fmtRunDate(anvil.startedAt)} · <span className={ui.mono}>{anvil.file}</span>
            </p>
            <div className={styles.split}>
              <Tiles run={anvil} />
              {anvil.auctions && anvil.underwater?.accounts ? <LaneOutcomes run={anvil} /> : <LaneBars run={anvil} net="anvil" />}
            </div>
            <AuctionMetrics run={anvil} />

            <div className={styles.tableCol}>
              <p className={styles.tableTitle}>All committed anvil runs</p>
              <RunsTable runs={evidence.anvilRuns} net="anvil" />
              <p className={styles.footnote}>
                * Wall-clock runs from the first lane tx submitted to the last receipt, on the keeper&rsquo;s
                clock. It includes RPC round trips and anvil&rsquo;s block interval, so it is not EVM execution time, and
                on anvil it says nothing about Monad. The app&rsquo;s labelled Simulated mode uses modeled costs and is
                not shown here.
              </p>
            </div>

            <a className={styles.evidence} href={`${GITHUB_TREE}/bench/results`} target="_blank" rel="noreferrer">
              Raw RunReports with every tx hash and timing
              <ArrowUpRight className={styles.evidenceIcon} />
            </a>
          </div>
        ) : null}
      </div>
    </section>
  );
}
