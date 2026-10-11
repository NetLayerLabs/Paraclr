import type { CSSProperties } from "react";
import Link from "next/link";
import { MONAD_TESTNET_CHAIN_ID, type XrayDesign, type XrayEvidence } from "./benchResults.server";
import { bands, MatrixSvg } from "./XrayMatrix";
import { GITHUB_BLOB, GITHUB_TREE, MONAD_EXPLORER, README_AT } from "./content";
import { fmtInt, shortHash } from "./format";
import b from "./brand/Brand.module.css";
import s from "./XRay.module.css";

type Vars = CSSProperties & Record<`--${string}`, string | number>;

function methodLabel(x: XrayEvidence): string {
  if (x.method === "debug_traceTransaction") return "live trace · debug_traceTransaction (prestateTracer)";
  if (x.method === "anvil-fork-replay") {
    return x.forkedFrom
      ? `local replay · anvil fork of chain ${x.forkedFrom.chainId} at block #${x.forkedFrom.block}`
      : "local replay · anvil fork";
  }
  return x.method;
}

/** Lanes are L0-L7 everywhere on the page; say which ones this run has no transactions in. */
function laneNote(x: XrayEvidence): string {
  const seen = new Set<number>();
  for (const d of [x.lanes, x.naive]) d?.txs.forEach((t) => t.lane !== null && seen.add(t.lane));
  const empty = Array.from({ length: 8 }, (_, i) => i).filter((i) => !seen.has(i));
  const base = "Lanes are numbered L0 to L7, as in the contract and the solvency ledgers.";
  if (empty.length === 0) return base;
  const names = empty.map((i) => `L${i}`);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${base} ${list} had no transactions in this run, so ${empty.length === 1 ? "it has" : "they have"} no band.`;
}

function Panel({ design, good, chainId }: { design: XrayDesign; good: boolean; chainId: number }) {
  const n = design.txs.length;
  const sum = design.summary;
  const label = `${good ? "Paraclr lanes" : "Naive shared state"}: ${n} transactions, ${sum.edges} dependency edges, ${design.crossLaneEdges} across lanes`;
  return (
    <figure className={s.panel}>
      <figcaption className={s.panelHead}>
        <span className={s.panelTitle}>{good ? "Paraclr lanes" : "Naive shared state"}</span>
        <span className={s.panelSub}>
          {good ? "per-lane storage keys" : "same code · every aggregate on one key"}
          {design.contract ? (
            chainId === MONAD_TESTNET_CHAIN_ID ? (
              <a
                href={`${MONAD_EXPLORER}/address/${design.contract}`}
                target="_blank"
                rel="noreferrer"
                className={s.addr}
              >
                {shortHash(design.contract, 4, 4)} ↗
              </a>
            ) : (
              <code className={s.addr}>{shortHash(design.contract, 4, 4)}</code>
            )
          ) : null}
        </span>
      </figcaption>

      <div className={s.big}>
        <span className={design.crossLaneEdges === 0 ? s.bigGood : s.bigBad}>{fmtInt(design.crossLaneEdges)}</span>
        <span className={s.bigLabel}>
          dependency edges <b>across lanes</b>
        </span>
      </div>

      <div className={s.matrixWrap}>
        <div className={s.topAxis} aria-hidden="true">
          {bands(design).map((band) => (
            <span key={band.start} style={{ "--a": band.start / n, "--w": band.count / n } as Vars}>
              {band.count / n >= 0.06 ? (band.lane === null ? "shared" : `L${band.lane}`) : ""}
            </span>
          ))}
        </div>
        <MatrixSvg
          design={design}
          label={label}
          classes={{
            svg: s.matrix,
            bg: s.mBg,
            band: s.mBand,
            sep: s.mSep,
            diag: s.mDiag,
            same: good ? s.mSame : s.mSameNaive,
            cross: s.mCross,
          }}
        />
      </div>

      <dl className={s.stats}>
        <div>
          <dt>Transactions</dt>
          <dd>{fmtInt(sum.txs)}</dd>
        </div>
        <div>
          <dt>Dependency edges</dt>
          <dd>{fmtInt(sum.edges)}</dd>
        </div>
        <div>
          <dt>Blocks</dt>
          <dd>{fmtInt(design.blocks.length || new Set(design.txs.map((t) => t.block)).size)}</dd>
        </div>
        <div>
          <dt>Longest chain</dt>
          <dd>{sum.longestChain === null ? "–" : fmtInt(sum.longestChain)}</dd>
        </div>
        <div>
          <dt>Independent txs</dt>
          <dd>{sum.independentTxs === null ? "–" : fmtInt(sum.independentTxs)}</dd>
        </div>
      </dl>

      {design.hotSlots.length ? (
        <div className={s.hot}>
          <span className={s.hotTitle}>{good ? "Slots on the most edges" : "What serializes it"}</span>
          <ul>
            {design.hotSlots.map((h) => (
              <li key={h.slot}>
                <code title={h.slot}>{h.label ?? shortHash(h.slot, 10, 8)}</code>
                <span>{fmtInt(h.edges)} edges</span>
              </li>
            ))}
          </ul>
        </div>
      ) : sum.edges === 0 ? (
        <p className={s.clean}>
          No transaction in this run read or wrote a slot that another transaction in the same block wrote.
        </p>
      ) : null}
    </figure>
  );
}

function PendingPanel({ good }: { good: boolean }) {
  return (
    <figure className={s.panel}>
      <figcaption className={s.panelHead}>
        <span className={s.panelTitle}>{good ? "Paraclr lanes" : "Naive shared state"}</span>
        <span className={s.panelSub}>{good ? "per-lane storage keys" : "same code · every aggregate on one key"}</span>
      </figcaption>
      <div className={s.matrixWrap}>
        <div className={s.ghost} aria-hidden="true" />
        <span className={s.ghostLabel}>pending</span>
      </div>
    </figure>
  );
}

export function XRay({ xray }: { xray: XrayEvidence | null }) {
  const monad = xray?.chainId === MONAD_TESTNET_CHAIN_ID;
  return (
    <section id="xray" className={`${b.dark} ${b.surface} ${b.section} ${s.section}`} aria-labelledby="xray-title">
      <div className={b.container}>
        <div className={b.sectionHead}>
          <p className={b.eyebrow}>Conflict X-ray</p>
          <h2 id="xray-title" className={b.h2}>
            Conflict-free is a claim. <em>Here&rsquo;s the graph.</em>
          </h2>
          <p className={b.lede}>
            After a crash we trace every transaction that resolved it and record which storage slots each one read and
            wrote. Then we run the identical crash on a deliberately naive build of the same contract, where every
            per-lane aggregate shares one storage key, and put the two dependency graphs side by side.
          </p>
        </div>

        {xray ? (
          <dl className={s.meta} aria-label="Where this X-ray comes from">
            <div>
              <dt>Network</dt>
              <dd className={monad ? undefined : s.metaWarn}>
                {monad ? `Monad testnet, chain ${xray.chainId}` : `local anvil, not Monad, chain ${xray.chainId}`}
              </dd>
            </div>
            <div>
              <dt>Method</dt>
              <dd>{methodLabel(xray)}</dd>
            </div>
            <div>
              <dt>Run</dt>
              <dd>{xray.runId}</dd>
            </div>
            <div>
              <dt>Data</dt>
              <dd>
                <a href={`${GITHUB_TREE}/bench/xray/${xray.file}`} target="_blank" rel="noreferrer">
                  bench/xray/{xray.file}
                </a>
              </dd>
            </div>
          </dl>
        ) : (
          <div className={s.metaPending}>
            <span className={`${b.dot} ${b.dotWarn}`} aria-hidden="true" />
            <span>
              <b>X-ray pending.</b> These panels render from{" "}
              <code className={b.code}>bench/xray/&lt;chainId&gt;-&lt;runId&gt;.json</code>, written by{" "}
              <code className={b.code}>npm run bench</code>, the next time the page is built. A Monad testnet X-ray (
              <code className={b.code}>10143-*.json</code>) takes precedence over a local one automatically.
            </span>
          </div>
        )}

        <div className={s.panels}>
          {xray?.lanes ? <Panel design={xray.lanes} good chainId={xray.chainId} /> : <PendingPanel good />}
          {xray?.naive ? (
            <Panel design={xray.naive} good={false} chainId={xray.chainId} />
          ) : (
            <PendingPanel good={false} />
          )}
        </div>

        <div className={s.legend}>
          <span>
            <i className={s.keySame} /> edge within one lane
          </span>
          <span>
            <i className={s.keyCross} /> edge across lanes
          </span>
          <span>
            <i className={s.keyBand} /> one lane&rsquo;s transactions
          </span>
          <span className={s.legendNote}>
            row = earlier tx that wrote a slot · column = later tx that read or wrote it
          </span>
        </div>
        {xray ? <p className={s.laneNote}>{laneNote(xray)}</p> : null}

        {xray && !monad ? (
          <p className={s.next}>
            Measured on local anvil. A Monad testnet X-ray replaces it automatically once{" "}
            <code className={b.code}>bench/xray/10143-*.json</code> is committed.
          </p>
        ) : null}

        <div className={s.arena}>
          <Link href="/arena" className={`${b.btn} ${b.btnInverse}`}>
            Crash it yourself
          </Link>
          <span>
            Press one button in the Arena and watch a live -20% crash on the Monad testnet demo stack resolve lane by lane,
            ending with this X-ray built from that run&rsquo;s transactions. Test funds, no sign-in.
          </span>
        </div>

        <div className={s.read}>
          <div className={s.readCol}>
            <h3 className={b.h3}>What an edge means</h3>
            <p>
              Transaction <b>j</b> read or wrote a storage slot that an earlier transaction <b>i</b> in the same block
              wrote. That is the condition under which Monad&rsquo;s optimistic parallel execution has to re-execute{" "}
              <b>j</b>. Across blocks, consensus already orders transactions, so{" "}
              {xray?.edgeScope === "same-block" || !xray
                ? "edges are only drawn inside a block"
                : "same-block edges are what matter"}
              .
            </p>
            {xray?.exclusions.length ? (
              <details className={s.excl}>
                <summary>Excluded from the graph ({xray.exclusions.length})</summary>
                <ul>
                  {xray.exclusions.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </details>
            ) : (
              <p className={s.exclNote}>
                Excluded: each sender&rsquo;s own nonce and gas balance, the coinbase fee credit, and transient storage.
              </p>
            )}
          </div>
          <div className={s.readCol}>
            <h3 className={b.h3}>What it doesn&rsquo;t show</h3>
            <p>
              These are <b>dependencies, not measured re-executions</b>. Monad&rsquo;s internal re-execution count
              isn&rsquo;t observable from outside the node, and the X-ray says nothing about how fast either design
              runs. It&rsquo;s a measured dependency map of one crash, labelled with how it was collected.
            </p>
          </div>
          <div className={s.readCol}>
            <h3 className={b.h3}>Checked before any chain</h3>
            <p>
              A Foundry test runs a lane-3 batch and a lane-5 batch from the same state, records every slot each touches
              with <code className={b.code}>vm.accesses</code>, and fails on any write/write or read/write overlap.{" "}
              <a
                className={b.link}
                href={`${GITHUB_BLOB}/contracts/test/ParaclrClearinghouse.t.sol#L361`}
                target="_blank"
                rel="noreferrer"
              >
                Read the test
              </a>
              .
            </p>
          </div>
        </div>

        <p className={s.solvency}>
          <b>Solvency is one on-chain check.</b> <code className={b.code}>solvency()</code> returns the AUSD the
          clearinghouse holds against its liabilities summed over the 8 lane ledgers; the app reads it every block.{" "}
          <a className={b.link} href={README_AT.solvency} target="_blank" rel="noreferrer">
            Solvency proof in the README
          </a>
        </p>
      </div>
    </section>
  );
}
