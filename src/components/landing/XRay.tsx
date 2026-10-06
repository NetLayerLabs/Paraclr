import type { CSSProperties } from "react";
import { MONAD_TESTNET_CHAIN_ID, type XrayDesign, type XrayEvidence } from "./benchResults.server";
import { ArrowUpRight } from "./icons";
import { GITHUB_TREE, MONAD_EXPLORER } from "./content";
import { fmtInt, shortHash } from "./format";
import ui from "./Landing.module.css";
import styles from "./XRay.module.css";

type Vars = CSSProperties & Record<`--${string}`, string | number>;

/** Gap around each edge cell, in matrix units (one unit = one transaction). */
const CELL_INSET = 0.08;

interface Band {
  lane: number | null;
  start: number;
  count: number;
}

function bands(design: XrayDesign): Band[] {
  const out: Band[] = [];
  design.txs.forEach((t, i) => {
    const last = out.at(-1);
    if (last && last.lane === t.lane) last.count += 1;
    else out.push({ lane: t.lane, start: i, count: 1 });
  });
  return out;
}

function methodLabel(x: XrayEvidence): string {
  if (x.method === "debug_traceTransaction") return "live trace · debug_traceTransaction (prestateTracer)";
  if (x.method === "anvil-fork-replay") {
    return x.forkedFrom
      ? `local replay · anvil fork of chain ${x.forkedFrom.chainId} at block #${x.forkedFrom.block}`
      : "local replay · anvil fork";
  }
  return x.method;
}

/** Dependency matrix: row = earlier tx that wrote a slot, column = later tx that read or wrote it. */
function Matrix({ design, good }: { design: XrayDesign; good: boolean }) {
  const n = design.txs.length;
  const bs = bands(design);
  const label = `${good ? "Paraclr lanes" : "Naive shared state"}: ${n} transactions, ${design.summary.edges} dependency edges, ${design.crossLaneEdges} across lanes`;
  return (
    <div className={styles.matrixWrap}>
      <div className={styles.topAxis} aria-hidden="true">
        {bs.map((b) => (
          <span key={b.start} style={{ "--a": b.start / n, "--w": b.count / n } as Vars}>
            {b.count / n >= 0.06 ? (b.lane === null ? "shared" : `L${b.lane}`) : ""}
          </span>
        ))}
      </div>
      <svg className={styles.matrix} viewBox={`0 0 ${n} ${n}`} preserveAspectRatio="none" role="img" aria-label={label}>
        <rect x="0" y="0" width={n} height={n} className={styles.mBg} />
        {bs.map((b) => (
          <rect key={`b${b.start}`} x={b.start} y={b.start} width={b.count} height={b.count} className={styles.mBand} />
        ))}
        {bs.slice(1).map((b) => (
          <g key={`l${b.start}`} className={styles.mSep}>
            <line x1={b.start} y1="0" x2={b.start} y2={n} />
            <line x1="0" y1={b.start} x2={n} y2={b.start} />
          </g>
        ))}
        <line x1="0" y1="0" x2={n} y2={n} className={styles.mDiag} />
        {design.edges.map((e, i) => (
          <rect
            key={i}
            x={e.to + CELL_INSET}
            y={e.from + CELL_INSET}
            width={1 - 2 * CELL_INSET}
            height={1 - 2 * CELL_INSET}
            rx={0.12}
            className={e.crossLane ? styles.mCross : good ? styles.mSame : styles.mSameNaive}
          />
        ))}
      </svg>
    </div>
  );
}

function DesignPanel({ design, good, chainId }: { design: XrayDesign; good: boolean; chainId: number }) {
  const s = design.summary;
  return (
    <figure className={`${ui.card} ${styles.panel} ${good ? styles.panelGood : ""}`}>
      <figcaption className={styles.panelHead}>
        <span className={styles.panelTitle}>{good ? "Paraclr lanes" : "Naive shared state"}</span>
        <span className={styles.panelSub}>
          {good ? "per-lane storage keys" : "same code · every aggregate on one key"}
          {design.contract ? (
            chainId === MONAD_TESTNET_CHAIN_ID ? (
              <a href={`${MONAD_EXPLORER}/address/${design.contract}`} target="_blank" rel="noreferrer" className={styles.addr}>
                {shortHash(design.contract, 4, 4)} ↗
              </a>
            ) : (
              <code className={styles.addrLocal}>{shortHash(design.contract, 4, 4)}</code>
            )
          ) : null}
        </span>
      </figcaption>
      <Matrix design={design} good={good} />
      <dl className={styles.stats}>
        <div>
          <dt>Transactions</dt>
          <dd>{fmtInt(s.txs)}</dd>
        </div>
        <div>
          <dt>Dependency edges</dt>
          <dd className={s.edges === 0 ? styles.zero : undefined}>{fmtInt(s.edges)}</dd>
        </div>
        <div>
          <dt>Across lanes</dt>
          <dd className={design.crossLaneEdges === 0 ? styles.zero : styles.bad}>{fmtInt(design.crossLaneEdges)}</dd>
        </div>
        <div>
          <dt>Blocks</dt>
          <dd>{fmtInt(design.blocks.length || new Set(design.txs.map((t) => t.block)).size)}</dd>
        </div>
        <div>
          <dt>Longest chain</dt>
          <dd>{s.longestChain === null ? "–" : fmtInt(s.longestChain)}</dd>
        </div>
        <div>
          <dt>Independent txs</dt>
          <dd>{s.independentTxs === null ? "–" : fmtInt(s.independentTxs)}</dd>
        </div>
      </dl>
      {design.hotSlots.length ? (
        <div className={styles.hot}>
          <span className={styles.hotTitle}>{good ? "Slots on the most edges" : "What serializes it"}</span>
          <ul>
            {design.hotSlots.map((h) => (
              <li key={h.slot}>
                <code title={h.slot}>{h.label ?? shortHash(h.slot, 10, 8)}</code>
                <span>{fmtInt(h.edges)} edges</span>
              </li>
            ))}
          </ul>
        </div>
      ) : s.edges === 0 ? (
        <p className={styles.clean}>
          No transaction in this run read or wrote a slot that another transaction in the same block wrote.
        </p>
      ) : null}
    </figure>
  );
}

function PendingPanel({ good }: { good: boolean }) {
  return (
    <figure className={`${ui.card} ${styles.panel} ${styles.panelPending}`}>
      <figcaption className={styles.panelHead}>
        <span className={styles.panelTitle}>{good ? "Paraclr lanes" : "Naive shared state"}</span>
        <span className={styles.panelSub}>{good ? "per-lane storage keys" : "same code · every aggregate on one key"}</span>
      </figcaption>
      <div className={styles.matrixWrap}>
        <div className={styles.ghost} aria-hidden="true" />
        <span className={styles.ghostLabel}>pending</span>
      </div>
      <dl className={styles.stats} aria-label="Not measured yet">
        {["Transactions", "Dependency edges", "Across lanes", "Blocks", "Longest chain", "Independent txs"].map((k) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className={styles.ghostValue}>–</dd>
          </div>
        ))}
      </dl>
    </figure>
  );
}

export function XRay({ xray }: { xray: XrayEvidence | null }) {
  const monad = xray?.chainId === MONAD_TESTNET_CHAIN_ID;
  return (
    <section id="xray" className={`${ui.section} ${ui.sectionAlt}`} aria-labelledby="xray-title">
      <div className={ui.container}>
        <div className={ui.sectionHead}>
          <p className={ui.eyebrow}>Conflict X-ray</p>
          <h2 id="xray-title" className={ui.h2}>
            Conflict-free is a claim. <em>Here&rsquo;s the graph.</em>
          </h2>
          <p className={ui.lede}>
            After a crash we trace every transaction that resolved it and record which storage slots each one read and
            wrote. Then we run the identical crash on a deliberately naive build of the same contract, where every
            per-lane aggregate shares one storage key, and put the two dependency graphs side by side.
          </p>
        </div>

        {xray ? (
          <div className={monad ? styles.metaMonad : styles.metaAnvil}>
            <span className={styles.metaNet}>
              {monad ? "Monad testnet · chain 10143" : `local anvil — not Monad · chain ${xray.chainId}`}
            </span>
            <span className={styles.metaItem}>
              <span className={styles.metaKey}>method</span> {methodLabel(xray)}
            </span>
            <span className={styles.metaItem}>
              <span className={styles.metaKey}>run</span> <code>{xray.runId}</code>
            </span>
            <a className={styles.metaLink} href={`${GITHUB_TREE}/bench/xray/${xray.file}`} target="_blank" rel="noreferrer">
              bench/xray/{xray.file}
              <ArrowUpRight className={styles.metaIcon} />
            </a>
          </div>
        ) : (
          <div className={styles.metaPending}>
            <span className={styles.pendingDot} aria-hidden="true" />
            <span>
              <b>X-ray pending.</b> These panels render from <code className={ui.code}>bench/xray/&lt;chainId&gt;-&lt;runId&gt;.json</code>,
              written by <code className={ui.code}>npm run bench</code>, the next time the page is built. A Monad testnet
              X-ray (<code className={ui.code}>10143-*.json</code>) takes precedence over a local one automatically.
            </span>
          </div>
        )}

        <div className={styles.panels}>
          {xray?.lanes ? <DesignPanel design={xray.lanes} good chainId={xray.chainId} /> : <PendingPanel good />}
          {xray?.naive ? <DesignPanel design={xray.naive} good={false} chainId={xray.chainId} /> : <PendingPanel good={false} />}
        </div>

        <div className={styles.legend}>
          <span>
            <i className={styles.keySame} /> edge within one lane
          </span>
          <span>
            <i className={styles.keyCross} /> edge across lanes
          </span>
          <span>
            <i className={styles.keyBand} /> one lane&rsquo;s transactions
          </span>
          <span className={styles.legendNote}>
            row = earlier tx that wrote a slot · column = later tx that read or wrote it
          </span>
        </div>

        {xray && !monad ? (
          <p className={styles.monadNext}>
            Monad testnet X-ray: pending. It replaces this local one automatically once{" "}
            <code className={ui.code}>bench/xray/10143-*.json</code> is committed.
          </p>
        ) : null}

        <div className={styles.read}>
          <div className={styles.readCol}>
            <h3 className={styles.readTitle}>What an edge means</h3>
            <p>
              Transaction <b>j</b> read or wrote a storage slot that an earlier transaction <b>i</b> in the same
              block wrote. That is the condition under which Monad&rsquo;s optimistic parallel execution has to
              re-execute <b>j</b>. Across blocks, consensus already orders transactions, so{" "}
              {xray?.edgeScope === "same-block" || !xray ? "edges are only drawn inside a block" : "same-block edges are what matter"}.
            </p>
            {xray?.exclusions.length ? (
              <details className={styles.excl}>
                <summary>Excluded from the graph ({xray.exclusions.length})</summary>
                <ul>
                  {xray.exclusions.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </details>
            ) : (
              <p className={styles.exclNote}>
                Excluded: each sender&rsquo;s own nonce and gas balance, the coinbase fee credit, and transient storage.
              </p>
            )}
          </div>
          <div className={styles.readCol}>
            <h3 className={styles.readTitle}>What it doesn&rsquo;t show</h3>
            <p>
              Monad&rsquo;s internal re-execution count, which isn&rsquo;t observable from outside the node, or how
              fast either design runs. It&rsquo;s a measured dependency map of one crash, labelled with how it was
              collected: a live trace, or a local replay on an anvil fork.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
