import type { CSSProperties } from "react";
import type { AuctionOutcome, BenchRun, LandingEvidence } from "./benchResults.server";
import { ArrowUpRight } from "./icons";
import { GITHUB_TREE, MONAD_EXPLORER } from "./content";
import { fmtAusd, fmtBlocks, fmtCompact, fmtInt, fmtPct, fmtRunDate, shortHash } from "./format";
import b from "./brand/Brand.module.css";
import s from "./Results.module.css";

type Net = "monad" | "anvil";
type Vars = CSSProperties & Record<`--${string}`, string | number>;

function shockLabel(bps: number | null): string {
  if (bps === null || bps >= 10_000) return "a price shock";
  return `a −${(10_000 - bps) / 100}% shock`;
}

/** Accounts that went underwater: v1 = liquidated by liquidateBatch, v2 = auctions started. */
function underwaterCount(run: BenchRun): number | null {
  return run.auctions ? run.auctions.started : run.liquidated;
}

function gasPerAccount(run: BenchRun): string {
  if (run.gasPerLiquidation !== null) return fmtInt(run.gasPerLiquidation);
  const u = underwaterCount(run);
  return u ? fmtInt(Math.round(run.totalGasUsed / u)) : "–";
}

function Tiles({ run }: { run: BenchRun }) {
  const oneBlock = run.sameBlock && run.blocks.length === 1;
  const under = underwaterCount(run);
  const uw = run.underwater;
  return (
    <dl className={s.tiles}>
      <div className={s.tile}>
        <dt>Accounts scanned</dt>
        <dd className={s.tileValue}>{fmtInt(run.accountsScanned)}</dd>
        <dd className={s.tileSub}>
          {run.accountsSeeded
            ? `${fmtInt(run.accountsSeeded)} seeded on-chain${run.seedTxCount ? ` in ${fmtInt(run.seedTxCount)} txs` : ""}`
            : "registered across the 8 lanes"}
        </dd>
      </div>
      <div className={s.tile}>
        <dt>{run.auctions ? "Went to auction" : "Liquidated"}</dt>
        <dd className={s.tileValue}>{under === null ? "–" : fmtInt(under)}</dd>
        <dd className={s.tileSub}>
          {under === null ? "–" : fmtPct(under, run.accountsScanned)} of scanned, after {shockLabel(run.shockBps)}
        </dd>
      </div>
      {run.auctions && uw && uw.maxBlocks !== null ? (
        <div className={s.tile}>
          <dt>Longest time underwater</dt>
          <dd className={s.tileValue}>
            {fmtInt(uw.maxBlocks)}
            <span className={s.unit}> blocks</span>
          </dd>
          <dd className={s.tileSub}>
            {uw.p50Blocks !== null ? `p50 ${fmtInt(uw.p50Blocks)} · ` : ""}
            {uw.p95Blocks !== null ? `p95 ${fmtInt(uw.p95Blocks)} · ` : ""}
            {uw.maxMs !== null ? `max ${fmtInt(uw.maxMs)} ms on the keeper's clock` : "shock block → resolved"}
          </dd>
        </div>
      ) : (
        <div className={s.tile}>
          <dt>{run.auctions ? "Gas per account" : "Gas per liquidation"}</dt>
          <dd className={s.tileValue}>{gasPerAccount(run)}</dd>
          <dd className={s.tileSub}>
            {fmtCompact(run.totalGasUsed)} gas across {run.batchCount} lane txs
          </dd>
        </div>
      )}
      <div className={s.tile}>
        <dt>{oneBlock ? "Lane txs in one block" : "Blocks used by lane txs"}</dt>
        <dd className={s.tileValue}>
          {oneBlock ? (
            <>
              {run.batchCount}
              <span className={s.unit}> / {run.batchCount}</span>
            </>
          ) : (
            run.blocks.length
          )}
        </dd>
        <dd className={s.tileSub}>
          {oneBlock ? `all in block #${run.blocks[0]}` : `split across ${fmtBlocks(run.blocks)}`}
        </dd>
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
const OUTCOMES = Object.keys(OUTCOME_LABEL) as AuctionOutcome[];

function LaneOutcomes({ run }: { run: BenchRun }) {
  const per = run.underwater?.perLane ?? [];
  const totals = per.map((l) => l.backstop + l.external + l.cured + l.expired);
  const max = Math.max(1, ...totals);
  const demo = run.auctions?.externalTakersDemo;
  return (
    <figure className={`${b.card} ${s.chart}`}>
      <figcaption className={s.chartHead}>
        <span className={s.chartTitle}>Auction outcomes per lane</span>
        <span className={s.chartSub}>every underwater account, by how it resolved</span>
      </figcaption>
      <ol className={s.bars}>
        {per.map((l, lane) => {
          const tip = `Lane ${lane}: ${OUTCOMES.map((o) => `${l[o]} ${OUTCOME_LABEL[o]}`).join(", ")}`;
          return (
            <li key={lane} className={s.barRow} aria-label={tip}>
              <span className={s.barLane}>L{lane}</span>
              <span className={s.barTrack}>
                <span className={s.stack} style={{ "--w": `${(totals[lane] / max) * 100}%` } as Vars}>
                  {OUTCOMES.map((o) =>
                    l[o] ? <i key={o} className={s[`seg_${o}`]} style={{ flexGrow: l[o] }} /> : null,
                  )}
                </span>
              </span>
              <span className={s.barValue}>{fmtInt(totals[lane])}</span>
            </li>
          );
        })}
      </ol>
      <p className={s.segLegend}>
        {OUTCOMES.map((o) => (
          <span key={o}>
            <i className={s[`seg_${o}`]} />{" "}
            {o === "external" && demo ? "taken externally (demo bots)" : OUTCOME_LABEL[o]}
          </span>
        ))}
      </p>
    </figure>
  );
}

function LaneBars({ run, net }: { run: BenchRun; net: Net }) {
  const max = Math.max(1, ...run.lanes.map((l) => l.liquidated));
  return (
    <figure className={`${b.card} ${s.chart}`}>
      <figcaption className={s.chartHead}>
        <span className={s.chartTitle}>Liquidations per lane batch</span>
        <span className={s.chartSub}>one liquidateBatch per lane, 8 keeper wallets</span>
      </figcaption>
      <ol className={s.bars}>
        {run.lanes.map((l) => (
          <li
            key={`${l.lane}-${l.txHash}`}
            className={s.barRow}
            aria-label={`Lane ${l.lane}: ${fmtInt(l.liquidated)} of ${fmtInt(l.accounts)} accounts liquidated, ${fmtInt(l.gasUsed)} gas`}
          >
            <span className={s.barLane}>L{l.lane}</span>
            <span className={s.barTrack}>
              <span className={s.stack} style={{ "--w": `${(l.liquidated / max) * 100}%` } as Vars}>
                <i className={s.seg_backstop} style={{ flexGrow: 1 }} />
              </span>
            </span>
            <span className={s.barValue}>{fmtInt(l.liquidated)}</span>
          </li>
        ))}
      </ol>
      <p className={s.chartFoot}>
        {net === "monad"
          ? run.lanes
              .filter((l) => l.txHash)
              .map((l) => (
                <a
                  key={`${l.lane}-${l.txHash}`}
                  href={`${MONAD_EXPLORER}/tx/${l.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  L{l.lane} {shortHash(l.txHash)}
                </a>
              ))
          : "Local anvil tx hashes are in the JSON. They don't resolve on any public explorer."}
      </p>
    </figure>
  );
}

function AuctionMetrics({ run }: { run: BenchRun }) {
  const a = run.auctions;
  if (!a) return <AuctionPending />;
  const counts: [string, number | null, string?][] = [
    ["Taken by backstop", a.takenByBackstop],
    [a.externalTakersDemo ? "Taken externally (demo bots)" : "Taken externally", a.takenExternal],
    ["Cured", a.cured],
    ["Expired", a.expired],
    ["Avg discount at take", a.avgDiscountBps, "bps"],
  ];
  const money: { k: string; v: number | null; sub: string; tone?: "good" | "bad" }[] = [
    {
      k: "Equity returned to traders",
      v: a.traderResidualReturned,
      sub: "Σ max(0, E − P) over taken accounts, plus collateral left on expired ones",
      tone: "good",
    },
    { k: "Paid to backstop pools", v: a.backstopPaid, sub: "the discount the lane pools earned" },
    {
      k: "Lane-funded shortfall",
      v: a.badDebt,
      sub: "where E < P on a backstop take: lane insurance first, then lane bad debt",
      tone: a.badDebt ? "bad" : undefined,
    },
    ...(a.auctionTraderLoss !== null
      ? [
          {
            k: "Taken from traders by the auction",
            v: a.auctionTraderLoss,
            sub: "equity at auction start − equity returned; compare with the next tile",
          },
        ]
      : []),
    {
      k: "Old fixed-penalty path, counterfactual",
      v: a.legacyTraderLoss,
      sub: "what the old fixed-fee path would have taken from the same traders (keeper-computed)",
    },
  ];
  return (
    <div className={s.metrics}>
      <dl className={s.counts}>
        {counts.map(([k, v, unit]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>
              {v === null ? "–" : fmtInt(v)}
              {unit && v !== null ? <span className={s.unit}> {unit}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      <dl className={s.money}>
        {money.map((m) => (
          <div key={m.k} className={`${b.card} ${s.moneyTile}`}>
            <dt>{m.k}</dt>
            <dd className={m.tone === "good" ? s.good : m.tone === "bad" ? s.bad : s.moneyValue}>
              {m.v === null ? "–" : fmtAusd(m.v)}
              <span className={s.unit}> AUSD</span>
            </dd>
            <dd className={s.tileSub}>{m.sub}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function AuctionPending() {
  return (
    <div className={s.metrics}>
      <p className={s.footnote}>
        This run predates auctions: it used the old <code className={b.code}>liquidateBatch</code> path (close at mark,
        1% fee). The next <code className={b.code}>npm run bench</code> writes a RunReport with{" "}
        <code className={b.code}>auctions</code> and <code className={b.code}>underwater</code>, and auction metrics
        fill in from it.
      </p>
    </div>
  );
}

function RunsTable({ runs, net }: { runs: BenchRun[]; net: Net }) {
  return (
    <div
      className={`${b.scrollX} ${s.tableWrap}`}
      tabIndex={0}
      role="region"
      aria-label={net === "monad" ? "Monad testnet runs" : "Local anvil runs"}
    >
      <table className={s.table}>
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
                <span className={s.runDate}>{fmtRunDate(r.startedAt)}</span>
                <span className={s.runFile}>{r.file}</span>
              </th>
              <td>
                <span className={r.auctions ? s.mechAuction : s.mechFixed}>{r.auctions ? "auction" : "fixed fee"}</span>
              </td>
              <td>{fmtInt(r.accountsScanned)}</td>
              <td>{underwaterCount(r) === null ? "–" : fmtInt(underwaterCount(r)!)}</td>
              <td>{r.batchCount}</td>
              <td>{fmtBlocks(r.blocks)}</td>
              <td>{r.sameBlock ? "yes" : "no"}</td>
              <td>{gasPerAccount(r)}</td>
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
    <div className={s.pending}>
      <div className={s.pendingCopy}>
        <span className={b.chip}>
          <span className={`${b.dot} ${s.dotIdle}`} aria-hidden="true" />
          Monad testnet · chain 10143
        </span>
        <h3 className={s.pendingTitle}>Monad testnet: live on real prices</h3>
        <p className={s.pendingBody}>
          The production contracts on Monad testnet run on real Pyth prices, so a crash can&rsquo;t be staged there:
          their auctions run when the market moves. The staged −20% crash runs below are measured on local anvil. A
          crash run committed as <code className={b.code}>bench/results/10143-*.json</code> would fill this card
          automatically, with block numbers and explorer links.
        </p>
      </div>
    </div>
  );
}

export function Results({ evidence }: { evidence: LandingEvidence }) {
  const { anvilHeadline: anvil, monadHeadline: monad } = evidence;
  return (
    <section
      id="results"
      className={`${b.light} ${b.surface} ${b.section} ${s.section}`}
      aria-labelledby="results-title"
    >
      <div className={b.container}>
        <div className={b.sectionHead}>
          <p className={b.eyebrow}>Results</p>
          <h2 id="results-title" className={b.h2}>
            Measured, labelled, <em>committed.</em>
          </h2>
          <p className={b.lede}>
            Every number in this section is read from the RunReport JSON files in{" "}
            <a className={b.link} href={`${GITHUB_TREE}/bench/results`} target="_blank" rel="noreferrer">
              bench/results/
            </a>{" "}
            when the page is built. Each run seeds accounts with <code className={b.code}>seedAccounts</code>, shocks
            every market in one oracle tx, then 8 lane keepers resolve every underwater account, each from its own key.
          </p>
        </div>

        {monad ? (
          <div className={s.block}>
            <div className={`${s.banner} ${s.bannerMonad}`}>
              <span className={`${b.chip} ${b.chipPos}`}>
                <span className={`${b.dot} ${b.dotPos}`} aria-hidden="true" />
                Monad testnet · chain 10143
              </span>
              <p>
                {fmtRunDate(monad.startedAt)} · <span className={b.mono}>{monad.file}</span> · tx links open the Monad
                testnet explorer
              </p>
            </div>
            <div className={s.split}>
              <Tiles run={monad} />
              {monad.auctions && monad.underwater?.accounts ? (
                <LaneOutcomes run={monad} />
              ) : (
                <LaneBars run={monad} net="monad" />
              )}
            </div>
            <AuctionMetrics run={monad} />
            <RunsTable runs={evidence.monadRuns} net="monad" />
          </div>
        ) : (
          <MonadPending />
        )}

        {anvil ? (
          <div className={s.block}>
            <div className={`${s.banner} ${s.bannerAnvil}`} role="note">
              <span className={`${b.chip} ${b.chipWarn}`}>
                <span className={`${b.dot} ${b.dotWarn}`} aria-hidden="true" />
                local anvil — not Monad
              </span>
              <p>
                <b>Measured on local anvil, not Monad.</b>{" "}
                {monad
                  ? "anvil executes sequentially. Kept for reference: these runs check the contracts and the keeper end to end and say nothing about Monad's parallel execution."
                  : "anvil executes sequentially. These runs check the contracts and the keeper end to end. They say nothing about Monad's parallel execution."}
              </p>
              <span className={s.bannerChain}>
                chain {anvil.chainId}
                {anvil.clientVersion ? ` · ${anvil.clientVersion}` : ""}
              </span>
            </div>

            <p className={s.runLabel}>
              {anvil.auctions ? "Largest auction run" : "Largest run"} · {fmtRunDate(anvil.startedAt)} ·{" "}
              <span className={b.mono}>{anvil.file}</span>
            </p>
            <div className={s.split}>
              <Tiles run={anvil} />
              {anvil.auctions && anvil.underwater?.accounts ? (
                <LaneOutcomes run={anvil} />
              ) : (
                <LaneBars run={anvil} net="anvil" />
              )}
            </div>
            <AuctionMetrics run={anvil} />

            <h3 className={s.tableTitle}>All committed anvil runs</h3>
            <RunsTable runs={evidence.anvilRuns} net="anvil" />
            <p className={s.footnote}>
              * Wall-clock runs from the first lane tx submitted to the last receipt, on the keeper&rsquo;s clock. It
              includes RPC round trips and anvil&rsquo;s block interval, so it is not EVM execution time, and on anvil
              it says nothing about Monad. The app&rsquo;s labelled Simulated mode uses modeled costs and is not shown
              here.
            </p>
            <a className={s.evidence} href={`${GITHUB_TREE}/bench/results`} target="_blank" rel="noreferrer">
              Raw RunReports with every tx hash and timing
              <ArrowUpRight className={s.evidenceIcon} />
            </a>
          </div>
        ) : null}
      </div>
    </section>
  );
}
