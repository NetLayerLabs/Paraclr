"use client";

// Conflict X-ray: the measured storage-dependency map of a crash's
// resolution phase, Paraclr's lane-keyed storage vs the same code with every
// per-lane aggregate mapped to one shared key (NaiveClearinghouseDemo).
//
// Nodes are transactions, grouped by lane (rows) in block order (columns).
// An edge i → j means tx j read or wrote a storage slot an earlier tx i wrote —
// the condition under which Monad's optimistic executor re-executes j. It is
// NOT a measured re-execution count. Data: keeper `GET /runs/:id/xray` or a
// recorded bench/xray/*.json file.

import { useMemo } from "react";
import type { XrayDesign, XrayReport } from "@/lib/chain/keeper";
import { shortHash } from "@/lib/chain/units";
import { MQ_WIDE, useMedia } from "@/components/shell/useMedia";
import styles from "./Xray.module.css";

export type XraySource = { kind: "run"; runId: string } | { kind: "file"; file: string; savedAt?: string | null };

const DESIGN_COPY: Record<XrayDesign["design"], { title: string; sub: string }> = {
  "paraclr-lanes": {
    title: "Paraclr · lane-keyed storage",
    sub: "Insurance, bad debt, open interest, backstop pool, ledger and auction counters live once per lane.",
  },
  "naive-shared": {
    title: "Naive · one shared key",
    sub: "Identical code with every per-lane aggregate mapped to one shared storage key.",
  },
};

function methodLabel(x: XrayReport): string {
  if (x.method === "anvil-fork-replay") {
    if (x.forkedFrom) {
      const net = x.forkedFrom.chainId === 10143 ? "Monad testnet" : `chain ${x.forkedFrom.chainId}`;
      return `Local replay of ${net} block #${x.forkedFrom.block.toLocaleString("en-US")} (anvil fork)`;
    }
    return "Local replay on an anvil fork";
  }
  return "Live trace · debug_traceTransaction (prestateTracer)";
}

export function XrayPanel({
  xray,
  source,
  pending,
  error,
  recordedElsewhere = false,
}: {
  xray: XrayReport | null;
  source: XraySource | null;
  /** Computing (keeper still tracing the naive replay). */
  pending?: boolean;
  error?: string | null;
  /** Production: the report is recorded evidence from another network, not this deployment. */
  recordedElsewhere?: boolean;
}) {
  const ordered = useMemo(() => {
    if (!xray) return [];
    const order: XrayDesign["design"][] = ["paraclr-lanes", "naive-shared"];
    return [...xray.designs].sort((a, b) => order.indexOf(a.design) - order.indexOf(b.design));
  }, [xray]);

  return (
    <section className={styles.panel} aria-label="Conflict X-ray">
      <header className={styles.head}>
        <div>
          <h2 className={styles.title}>Conflict X-ray</h2>
          <p className={styles.sub}>
            Storage dependencies between the crash&apos;s resolution transactions: lanes vs a naive shared-state design
          </p>
        </div>
        {xray && (
          <div className={styles.tags}>
            <span className={styles.tag} data-k="method">
              {methodLabel(xray)}
            </span>
            <span className={styles.tag} data-k={xray.network === "monad-testnet" ? "monad" : "anvil"}>
              {xray.network === "monad-testnet" ? "Monad testnet" : "Local anvil — not Monad"}
            </span>
          </div>
        )}
      </header>

      {recordedElsewhere && xray && (
        <p className={styles.explain} data-recorded="">
          <b>Recorded evidence, not this deployment.</b> This X-ray was measured on{" "}
          {xray.network === "monad-testnet" ? "Monad testnet" : "a local anvil chain (not Monad)"} during a benchmark
          crash run of the demo contracts. Nothing is crashed on mainnet to produce it.
        </p>
      )}
      <p className={styles.explain}>
        An edge <b>i → j</b> means tx <i>j</i> read or wrote a storage slot that an earlier tx <i>i</i> wrote — the
        condition under which Monad&apos;s optimistic executor re-executes <i>j</i>. Edges are storage dependencies,
        not measured re-executions. The lane design&apos;s claim is <b>zero edges across lanes</b>; txs within one lane
        (its pool take, a taker&apos;s take and close) can still depend on that lane&apos;s own storage.
      </p>

      {!xray ? (
        <div className={styles.empty} data-pending={pending ? "" : undefined}>
          {pending
            ? "Computing the X-ray: the keeper replays the identical crash on the naive shared-state contract and traces every resolution tx of both runs…"
            : (error ?? "No X-ray yet. Run a flash crash: the keeper records both designs and traces their storage reads/writes.")}
        </div>
      ) : (
        <>
          <Comparison designs={ordered} />
          <div className={styles.graphs}>
            {ordered.map((d) => (
              <DesignGraph key={d.design} d={d} labels={xray.slotLabels ?? {}} />
            ))}
            {ordered.length === 1 && (
              <div className={styles.missing}>
                <b>{ordered[0].design === "paraclr-lanes" ? "Naive · one shared key" : "Paraclr · lane-keyed storage"}</b>
                <span>
                  Not in this report: the {ordered[0].design === "paraclr-lanes" ? "naive shared-state baseline" : "lane-sharded design"}{" "}
                  wasn&apos;t deployed alongside on this chain, so there is nothing to compare against. Nothing is
                  extrapolated.
                </span>
              </div>
            )}
          </div>
          <div className={styles.legend}>
            <span>
              <i data-k="node" /> tx with no dependency
            </span>
            <span>
              <i data-k="hit" /> tx in a dependency
            </span>
            <span>
              <i data-k="edge" /> edge, same block
            </span>
            {xray.edgeScope !== "same-block" && (
              <span>
                <i data-k="cross" /> edge across blocks
              </span>
            )}
            {xray.edgeScope === "same-block" && <span>Edges are only drawn between txs of the same block.</span>}
            <span>Rows = lanes (L1–L8), columns = block order. Hover for tx / slot details.</span>
          </div>
          <footer className={styles.foot}>
            <span>
              {source?.kind === "file" ? (
                <>
                  Recorded bench run <span className="mono">{xray.runId || source.file}</span>
                  {source.savedAt ? <> · {source.savedAt}</> : null} · <span className="mono">bench/xray/{source.file}</span>
                </>
              ) : (
                <>
                  Run <span className="mono">{xray.runId}</span> · chain {xray.chainId} · from the keeper
                  {xray.generatedAt ? <> · generated {xray.generatedAt.replace("T", " ").slice(0, 19)} UTC</> : null}
                </>
              )}
            </span>
            {(xray.exclusions.length > 0 || (xray.notes?.length ?? 0) > 0) && (
              <details className={styles.exclusions}>
                <summary>
                  Method notes{xray.exclusions.length > 0 ? ` · ${xray.exclusions.length} exclusions` : ""}
                </summary>
                {xray.notes && xray.notes.length > 0 && (
                  <ul>
                    {xray.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                )}
                {xray.exclusions.length > 0 && (
                  <>
                    <b>Excluded from edges</b>
                    <ul>
                      {xray.exclusions.map((e) => (
                        <li key={e}>{e}</li>
                      ))}
                    </ul>
                  </>
                )}
              </details>
            )}
          </footer>
        </>
      )}
    </section>
  );
}

function Comparison({ designs }: { designs: XrayDesign[] }) {
  const lanes = designs.find((d) => d.design === "paraclr-lanes");
  const naive = designs.find((d) => d.design === "naive-shared");
  if (!lanes || !naive) return null;
  const max = Math.max(1, lanes.summary.crossLaneEdges, naive.summary.crossLaneEdges);
  return (
    <div className={styles.compare}>
      {[lanes, naive].map((d) => (
        <div key={d.design} className={styles.compareRow} data-design={d.design}>
          <span>{d.design === "paraclr-lanes" ? "Paraclr lanes" : "Naive shared"}</span>
          <div className={styles.compareTrack}>
            <i
              style={{
                width: `${d.summary.crossLaneEdges === 0 ? 0 : Math.max(1.5, (d.summary.crossLaneEdges / max) * 100)}%`,
              }}
            />
          </div>
          <b className="mono">
            {d.summary.crossLaneEdges.toLocaleString("en-US")} <small>cross-lane edges</small>
          </b>
        </div>
      ))}
    </div>
  );
}

function DesignGraph({ d, labels }: { d: XrayDesign; labels: Record<string, string> }) {
  const copy = DESIGN_COPY[d.design];
  const hot = useMemo(() => hotSlots(d, labels), [d, labels]);
  return (
    <article className={styles.design} data-design={d.design}>
      <header className={styles.designHead}>
        <h3>{copy.title}</h3>
        <span className="mono" title={d.contract}>
          {shortHash(d.contract, 6, 4)}
        </span>
      </header>
      <p className={styles.designSub}>{copy.sub}</p>
      <ConflictGraph d={d} labels={labels} />
      {hot.length > 0 && (
        <p className={styles.hot}>
          <span>Most-shared slots:</span>{" "}
          {hot.map((h, i) => (
            <span key={h.slot}>
              {i > 0 && " · "}
              <code title={h.slot}>{h.label}</code> ({h.edges})
            </span>
          ))}
        </p>
      )}
      <dl className={styles.summary}>
        <div>
          <dt>Txs</dt>
          <dd className="mono">{d.summary.txs}</dd>
        </div>
        <div>
          <dt>Cross-lane edges</dt>
          <dd
            className="mono"
            data-bad={d.summary.crossLaneEdges > 0 ? "" : undefined}
            data-good={d.summary.crossLaneEdges === 0 ? "" : undefined}
          >
            {d.summary.crossLaneEdges.toLocaleString("en-US")}
          </dd>
        </div>
        <div>
          <dt>Within-lane edges</dt>
          <dd className="mono">{d.summary.sameLaneEdges.toLocaleString("en-US")}</dd>
        </div>
        <div>
          <dt>Longest chain</dt>
          <dd className="mono">{d.summary.longestChain}</dd>
        </div>
        <div>
          <dt>Independent</dt>
          <dd className="mono" data-good="">
            {d.summary.independentTxs}
          </dd>
        </div>
      </dl>
    </article>
  );
}

const ROW_H = 17;
const TOP = 18;
const BOTTOM = 6;

/** Slots that appear on the most edges, with their storage-layout labels when the keeper had them. */
function hotSlots(d: XrayDesign, labels: Record<string, string>): { slot: string; label: string; edges: number }[] {
  const counts = new Map<string, number>();
  for (const e of d.edges) for (const s of new Set(e.slots)) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([slot, edges]) => ({ slot, edges, label: slotName(slot, labels) }));
}

function slotName(slot: string, labels: Record<string, string>): string {
  const l = labels[slot.toLowerCase()];
  if (l) return l.replace(/^(paraclr|naive)\./, "");
  const parts = slot.split(":");
  return parts.length === 2 ? `slot ${shortHash(parts[1], 6, 4)}` : shortHash(slot, 8, 4);
}

function ConflictGraph({ d, labels }: { d: XrayDesign; labels: Record<string, string> }) {
  const wide = useMedia(MQ_WIDE, true);
  const W = wide ? 640 : 360;
  const gutter = wide ? 30 : 24;

  const g = useMemo(() => {
    const txs = [...d.txs].sort((a, b) => a.block - b.block || a.index - b.index);
    const hasNull = txs.some((t) => t.lane === null);
    const laneRows = [...new Set(txs.map((t) => t.lane).filter((l): l is number => l !== null))].sort((a, b) => a - b);
    const rows: (number | null)[] = hasNull ? [null, ...Array.from({ length: 8 }, (_, i) => i)] : Array.from({ length: 8 }, (_, i) => i);
    // Keep all 8 lanes visible even when some had no tx; add any lane id beyond 0..7.
    for (const l of laneRows) if (!rows.includes(l)) rows.push(l);
    const rowOf = new Map<number | null, number>(rows.map((r, i) => [r, i]));

    const blocks = [...new Set(txs.map((t) => t.block))].sort((a, b) => a - b);
    const n = Math.max(1, txs.length);
    const usable = W - gutter - 8;
    const gap = Math.min(14, usable / (n + blocks.length * 1.2)) * 1.2;
    const col = (usable - gap * Math.max(0, blocks.length - 1)) / n;

    const pos = new Map<string, { x: number; y: number }>();
    const groups: { block: number; x0: number; x1: number }[] = [];
    let x = gutter;
    let lastBlock: number | null = null;
    for (const t of txs) {
      if (lastBlock !== null && t.block !== lastBlock) x += gap;
      if (t.block !== lastBlock) groups.push({ block: t.block, x0: x, x1: x });
      const cx = x + col / 2;
      pos.set(t.hash, { x: cx, y: TOP + (rowOf.get(t.lane) ?? 0) * ROW_H + ROW_H / 2 });
      x += col;
      groups[groups.length - 1].x1 = x;
      lastBlock = t.block;
    }

    const blockOf = new Map(txs.map((t) => [t.hash, t.block]));
    const touched = new Set<string>();
    const edges = d.edges
      .map((e) => {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) return null;
        touched.add(e.from);
        touched.add(e.to);
        const span = Math.abs(b.x - a.x);
        const lift = Math.min(ROW_H * 2.2, 6 + span * 0.18);
        const same = blockOf.get(e.from) === blockOf.get(e.to);
        return {
          key: `${e.from}-${e.to}`,
          d: `M${a.x.toFixed(1)} ${a.y.toFixed(1)} C${a.x.toFixed(1)} ${(a.y - lift).toFixed(1)} ${b.x.toFixed(1)} ${(b.y - lift).toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`,
          same,
          title: `${shortHash(e.from, 6, 4)} → ${shortHash(e.to, 6, 4)}${same ? "" : " (different blocks)"}\n${e.slots
            .slice(0, 4)
            .map((x) => slotName(x, labels))
            .join("\n")}${e.slots.length > 4 ? `\n+${e.slots.length - 4} more slots` : ""}`,
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    const r = Math.max(2.1, Math.min(4.6, col * 0.34));
    const H = TOP + rows.length * ROW_H + BOTTOM;
    return { txs, rows, pos, groups, edges, touched, r, H };
  }, [d, W, gutter, labels]);

  return (
    <svg
      className={styles.graph}
      viewBox={`0 0 ${W} ${g.H}`}
      role="img"
      aria-label={`${d.summary.txs} transactions, ${d.summary.crossLaneEdges} cross-lane and ${d.summary.sameLaneEdges} within-lane storage-dependency edges`}
    >
      {/* lane rows */}
      {g.rows.map((lane, i) => (
        <g key={`row-${lane ?? "x"}`}>
          <line className={styles.rowLine} x1={gutter - 4} x2={W - 4} y1={TOP + i * ROW_H + ROW_H / 2} y2={TOP + i * ROW_H + ROW_H / 2} />
          <text className={styles.rowLabel} x={gutter - 7} y={TOP + i * ROW_H + ROW_H / 2 + 3} textAnchor="end">
            {lane === null ? "—" : `L${lane + 1}`}
          </text>
        </g>
      ))}
      {/* block groups */}
      {g.groups.map((b, i) => (
        <g key={`blk-${b.block}`}>
          {i > 0 && <line className={styles.blockSep} x1={b.x0 - 3} x2={b.x0 - 3} y1={TOP - 4} y2={g.H - BOTTOM} />}
          {(b.x1 - b.x0 > 34 || g.groups.length <= 6) && (
            <text className={styles.blockLabel} x={(b.x0 + b.x1) / 2} y={11} textAnchor="middle">
              #{b.block}
            </text>
          )}
        </g>
      ))}
      {/* edges: red; cross-block edges dimmer */}
      <g className={styles.edges}>
        {g.edges.map((e) => (
          <path key={e.key} d={e.d} className={e.same ? styles.edge : styles.edgeCross}>
            <title>{e.title}</title>
          </path>
        ))}
      </g>
      {/* txs */}
      {g.txs.map((t) => {
        const p = g.pos.get(t.hash);
        if (!p) return null;
        const hit = g.touched.has(t.hash);
        return (
          <circle key={t.hash} cx={p.x} cy={p.y} r={g.r} className={hit ? styles.nodeHit : styles.node}>
            <title>
              {`${t.kind} · ${t.lane === null ? "no lane" : `lane ${t.lane + 1}`} · block #${t.block} tx ${t.index}\n${t.reads} slots read · ${t.writes} written\n${t.hash}`}
            </title>
          </circle>
        );
      })}
    </svg>
  );
}
