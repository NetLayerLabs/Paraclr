import type { ReactNode } from "react";
import type { BenchRun, LandingEvidence, XrayEvidence } from "./benchResults.server";
import type { ProductionStatus } from "./production.server";
import { AddressPager } from "./AddressPager";
import { GITHUB_BLOB, README_AT } from "./content";
import { fmtAusd, fmtInt } from "./format";
import b from "./brand/Brand.module.css";
import s from "./Results.module.css";
import { MINUS } from "@/lib/format";

/** The runs the headline figures cite (README "Results"). Each figure is read from its file at build time. */
const AUCTION_RUN = "10143-2026-10-10T22-40-07Z.json";
const ARENA_XRAY = "10143-run-mv2ze6l6-xzyi6.json";

interface Figure {
  value: ReactNode;
  claim: ReactNode;
  detail: string;
  file: string;
}

function shock(run: BenchRun): string {
  return run.shockBps !== null && run.shockBps < 10_000 ? `${MINUS}${(10_000 - run.shockBps) / 100}% shock` : "price shock";
}

function figures(run: BenchRun | null, xray: XrayEvidence | null): Figure[] {
  const out: Figure[] = [];
  const a = run?.auctions;
  if (run && a && a.auctionTraderLoss !== null && a.legacyTraderLoss) {
    const less = Math.round((1 - a.auctionTraderLoss / a.legacyTraderLoss) * 100);
    out.push({
      value: <>{less}%</>,
      claim: <>less taken from traders than the old fixed 1% fee would have taken in the same crash</>,
      detail: `${fmtAusd(a.auctionTraderLoss)} vs ${fmtAusd(a.legacyTraderLoss)} AUSD, ${fmtInt(a.started)} accounts, ${shock(run)}`,
      file: `bench/results/${run.file}`,
    });
  }
  if (xray?.lanes && xray.naive) {
    out.push({
      value: (
        <>
          {fmtInt(xray.lanes.crossLaneEdges)} <span className={s.vs}>vs</span> {fmtInt(xray.naive.crossLaneEdges)}
        </>
      ),
      claim: <>cross-lane conflicts: Paraclr&rsquo;s lanes against a naive shared-state build of the same code</>,
      detail: "first public Arena crash on Monad testnet, live debug_traceTransaction",
      file: `bench/xray/${xray.file}`,
    });
  }
  if (run && a) {
    out.push({
      value: (
        <>
          {fmtInt(run.blocks.length)}
          <span className={s.unit}> blocks</span>
        </>
      ),
      claim: (
        <>
          for every auction in the Monad testnet run to resolve: {fmtInt(a.takenByBackstop)} taken by backstop pools,{" "}
          {fmtInt(a.takenExternal)} by {a.externalTakersDemo ? "demo takers" : "outside takers"}, {fmtInt(a.expired)}{" "}
          expired
        </>
      ),
      detail: `${(run.wallClockMs / 1000).toFixed(1)} s from the first submit to the last receipt`,
      file: `bench/results/${run.file}`,
    });
  }
  return out;
}

/**
 * `production`: deployments/143.json; `testnet`: deployments/10143.json with "production": true. The contract list
 * shows the mainnet set once it is live, else the testnet one.
 */
export function Results({
  evidence,
  production,
  testnet,
}: {
  evidence: LandingEvidence;
  production: ProductionStatus;
  testnet: ProductionStatus;
}) {
  const mainnet = production.live;
  const deployment = mainnet ? production : testnet;
  const run = evidence.monadRuns.find((r) => r.file === AUCTION_RUN) ?? null;
  const xray = evidence.xrays.find((x) => x.file === ARENA_XRAY) ?? null;
  const figs = figures(run, xray);
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
            Measured on Monad testnet. <em>Every number has a file.</em>
          </h2>
          <p className={b.lede}>
            Each figure is read from a committed JSON report when the page is built. The README has every run, including
            the local anvil ones, and how each was collected.
          </p>
        </div>

        {figs.length ? (
          <ol className={s.figures}>
            {figs.map((f) => (
              <li key={f.file + String(f.detail)} className={s.figure}>
                <p className={s.value}>{f.value}</p>
                <p className={s.claim}>{f.claim}</p>
                <p className={s.detail}>{f.detail}</p>
                <a className={s.file} href={`${GITHUB_BLOB}/${f.file}`} target="_blank" rel="noreferrer">
                  {f.file}
                </a>
              </li>
            ))}
          </ol>
        ) : (
          <p className={s.pending}>The cited bench files aren&rsquo;t in this build.</p>
        )}
        <p className={s.more}>
          <a className={b.link} href={README_AT.results} target="_blank" rel="noreferrer">
            All runs and X-rays in the README
          </a>
        </p>

        {deployment.live ? (
          <div id={mainnet ? "contracts" : "testnet"} className={s.contracts}>
            <div className={s.contractsHead}>
              <h3 className={s.contractsTitle}>
                {mainnet ? "Contracts on Monad mainnet" : "Production contracts on Monad testnet"}
              </h3>
              <p className={s.contractsSub}>
                {mainnet ? (
                  <>Capped, unaudited beta on chain 143. Check every address before you approve anything.</>
                ) : (
                  <>
                    The contract set the mainnet beta would run, on chain 10143 with Agora&rsquo;s testnet AUSD. Test
                    funds, no real value. Nothing of ours is on Monad mainnet yet.
                  </>
                )}
              </p>
            </div>
            <AddressPager
              rows={deployment.contracts.map((c) => ({
                name: c.name,
                role: c.role,
                address: c.address,
                external: c.external,
              }))}
              explorer={deployment.explorer}
              label={mainnet ? "Monad mainnet contract addresses" : "Monad testnet contract addresses"}
            />
            <p className={s.contractsFoot}>
              <a
                className={b.link}
                href={mainnet ? README_AT.mainnetContracts : README_AT.testnetContracts}
                target="_blank"
                rel="noreferrer"
              >
                All {deployment.contracts.length} addresses in the README
              </a>
              <span>
                From <code className={b.code}>{deployment.file}</code>
                {deployment.deployBlock !== null ? <>, deploy block #{fmtInt(deployment.deployBlock)}</> : null}.
              </span>
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
