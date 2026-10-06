import { Check, Cross } from "./icons";
import ui from "./Landing.module.css";
import styles from "./LaneMatrix.module.css";

type Kind = "conflict" | "perLane" | "read" | "transient" | "none";

interface Row {
  slot: string;
  hint: string;
  kind: Kind;
  label?: string;
}

// The naive baseline is the same contract with every per-lane aggregate mapped
// to one shared key (docs/FAIR_LIQUIDATION_PLAN.md, "Naive baseline for X-ray").
const SHARED: Row[] = [
  { slot: "insurance, bad debt", hint: "one global fund", kind: "conflict", label: "written by all 8" },
  { slot: "open interest [m]", hint: "one counter per market", kind: "conflict", label: "written by all 8" },
  { slot: "backstop pool", hint: "one pool for every lane", kind: "conflict", label: "written by all 8" },
  { slot: "auction counters", hint: "one set for every lane", kind: "conflict", label: "written by all 8" },
  { slot: "solvency ledger", hint: "one running total", kind: "conflict", label: "written by all 8" },
  { slot: "accounts, positions", hint: "keyed by account", kind: "perLane" },
];

const LANES: Row[] = [
  { slot: "lane k books", hint: "insurance, bad debt, ledger", kind: "perLane" },
  { slot: "open interest [k]", hint: "per market, summed on read", kind: "perLane" },
  { slot: "backstop pool [k]", hint: "cash, shares, exposure", kind: "perLane" },
  { slot: "auctions [k]", hint: "only lane k's auctions", kind: "perLane" },
  { slot: "accounts, positions", hint: "only lane k's accounts", kind: "perLane" },
  { slot: "oracle, config", hint: "every lane reads it", kind: "read", label: "read by all 8, written by none" },
  { slot: "reentrancy guard", hint: "EIP-1153", kind: "transient", label: "transient storage, not a slot" },
];

const COLS = Array.from({ length: 8 }, (_, i) => i);

const FACTS = [
  {
    title: "Every account gets a lane",
    code: "lane = uint160(account) % 8",
    body: "The last three bits of the address. It never changes, and it decides where all of that account's risk state lives.",
  },
  {
    title: "Each lane keeps its own books",
    code: "insurance · bad debt · OI · pool · auctions",
    body: "Everything a liquidation writes exists once per lane. Global numbers are views that sum the lanes at read time.",
  },
  {
    title: "Nothing shared on the hot path",
    code: "internal balances · transient lock",
    body: "No ERC-20 transfers while resolving auctions, keeper rewards in a per-keeper slot, oracle and config only read.",
  },
] as const;

function Matrix({ rows, prefix, variant }: { rows: Row[]; prefix: string; variant: "shared" | "lanes" }) {
  return (
    <div className={styles.matrix} role="table" aria-label={variant === "shared" ? "Naive shared-state write sets" : "Paraclr lane write sets"}>
      <div className={styles.row} role="row">
        <span className={styles.corner} role="columnheader">
          storage <span aria-hidden="true">╲</span> lane txs
        </span>
        {COLS.map((c) => (
          <span key={c} className={variant === "shared" ? styles.colHeadShared : styles.colHead} role="columnheader">
            {prefix}
            {c}
          </span>
        ))}
      </div>
      {rows.map((r) => (
        <div key={r.slot} className={styles.row} role="row">
          <span className={styles.slot} role="rowheader">
            <code>{r.slot}</code>
            <small>{r.hint}</small>
          </span>
          {r.kind === "perLane" ? (
            COLS.map((c) => (
              <span key={c} className={variant === "shared" ? styles.cellNeutral : styles.cellLane} role="cell">
                <span className={ui.srOnly}>lane {c} writes its own slot</span>
              </span>
            ))
          ) : (
            <span className={styles[r.kind]} role="cell">
              {r.kind === "conflict" && <Cross className={styles.icon} />}
              {r.label}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export function LaneMatrix() {
  return (
    <section id="lanes" className={`${ui.section} ${ui.sectionAlt}`} aria-labelledby="lanes-title">
      <div className={ui.container}>
        <div className={ui.sectionHead}>
          <p className={ui.eyebrow}>The engine: 8 lanes</p>
          <h2 id="lanes-title" className={ui.h2}>
            Why 8 lanes can clear <em>in the same block.</em>
          </h2>
          <p className={ui.lede}>
            Auctions only resolve in seconds if one lane&rsquo;s takes don&rsquo;t wait on another&rsquo;s. Paraclr is
            one clearinghouse with one cross-margin account per trader; what&rsquo;s split is the mutable state that
            resolving an underwater account writes. Monad executes a block optimistically in parallel and re-executes a
            transaction that read a slot an earlier one wrote, so shared writes are what turn a crash into a queue.
          </p>
        </div>

        <ol className={styles.facts}>
          {FACTS.map((f, i) => (
            <li key={f.title} className={`${ui.card} ${styles.fact}`}>
              <span className={styles.factN}>0{i + 1}</span>
              <h3 className={styles.factTitle}>{f.title}</h3>
              <code className={styles.factCode}>{f.code}</code>
              <p className={styles.factBody}>{f.body}</p>
            </li>
          ))}
        </ol>

        <div className={styles.panels}>
          <figure className={`${ui.card} ${styles.panel}`}>
            <figcaption className={styles.panelHead}>
              <span className={styles.panelTitle}>Naive shared state</span>
              <span className={styles.panelSub}>the X-ray baseline: same code, one key</span>
            </figcaption>
            <Matrix rows={SHARED} prefix="L" variant="shared" />
            <p className={styles.verdictBad}>
              <Cross className={styles.verdictIcon} />
              Every lane&rsquo;s takes write the same 5 aggregates, so each depends on the one before.
            </p>
          </figure>

          <figure className={`${ui.card} ${styles.panel} ${styles.panelGood}`}>
            <figcaption className={styles.panelHead}>
              <span className={styles.panelTitle}>Paraclr, 8 lanes</span>
              <span className={styles.panelSub}>
                <code>backstopTakeBatch(k, …)</code>
              </span>
            </figcaption>
            <Matrix rows={LANES} prefix="L" variant="lanes" />
            <p className={styles.verdictGood}>
              <Check className={styles.verdictIcon} />
              Write sets are pairwise disjoint across lanes. Shared state is only read.
            </p>
          </figure>
        </div>

        <div className={styles.legend}>
          <span>
            <i className={styles.keyLane} /> slot written by one lane only
          </span>
          <span>
            <i className={styles.keyConflict} /> slot written by several lanes
          </span>
          <span>
            <i className={styles.keyRead} /> shared, read-only
          </span>
          <span>
            <i className={styles.keyNone} /> not a storage slot
          </span>
        </div>

        <aside className={styles.note}>
          <span className={styles.noteTag}>Lanes ≠ threads</span>
          <p>
            A contract can&rsquo;t choose which of Monad&rsquo;s execution threads runs a transaction. Lanes are a{" "}
            <strong>storage layout</strong>: they give the 8 lanes&rsquo; transactions disjoint write sets, so
            Monad&rsquo;s optimistic executor has no reason to re-execute one lane&rsquo;s take because of another&rsquo;s.
            Transactions within one lane still depend on each other, by design.
          </p>
        </aside>
      </div>
    </section>
  );
}
