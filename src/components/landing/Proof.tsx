import type { ReactNode } from "react";
import { MONAD_TESTNET_CHAIN_ID, type BenchRun, type RepoFacts } from "./benchResults.server";
import { ArrowUpRight } from "./icons";
import { GITHUB_BLOB } from "./content";
import { fmtInt } from "./format";
import ui from "./Landing.module.css";
import styles from "./Proof.module.css";

// Excerpt of contracts/test/ParaclrClearinghouse.t.sol (two setup lines and the
// assertGt guards elided). Keep in sync with the source if the test changes.
const TEST_SOURCE = `function test_ParallelSafety_LaneBatchesTouchDisjointStorage() public {
    address[] memory b3 = _openLaneBook(3, 6);
    address[] memory b5 = _openLaneBook(5, 6);
    vm.prank(admin);
    oracle.shockPrice(MON, 8_000);

    uint256 snap = vm.snapshotState();
    vm.record();
    vm.prank(keeper3);
    ch.liquidateBatch(3, b3);
    (bytes32[] memory r3, bytes32[] memory w3) = vm.accesses(address(ch));

    vm.revertToState(snap);
    vm.record();
    vm.prank(keeper5);
    ch.liquidateBatch(5, b5);
    (bytes32[] memory r5, bytes32[] memory w5) = vm.accesses(address(ch));

    _assertDisjoint(w3, w5, "write/write conflict");
    _assertDisjoint(w3, r5, "lane3 writes vs lane5 reads");
    _assertDisjoint(w5, r3, "lane5 writes vs lane3 reads");
}`;

const KEYWORDS = new Set(["function", "public", "memory", "address", "uint256", "bytes32"]);
const TOKEN = /(\/\/.*$)|("[^"]*")|(\b\d[\d_]*\b)|(\b[A-Za-z_]\w*\b)(?=\s*\()|(\b[A-Za-z_]\w*\b)/gm;

/** Tiny Solidity highlighter: comments, strings, numbers, keywords, calls. */
function highlight(src: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of src.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) out.push(src.slice(last, i));
    const [text, comment, str, num, call, word] = m;
    let cls: string | undefined;
    if (comment) cls = styles.tComment;
    else if (str) cls = styles.tString;
    else if (num) cls = styles.tNumber;
    else if (call) cls = call === "vm" ? styles.tVm : styles.tCall;
    else if (word && KEYWORDS.has(word)) cls = styles.tKeyword;
    else if (word === "vm") cls = styles.tVm;
    out.push(
      cls ? (
        <span key={k++} className={cls}>
          {text}
        </span>
      ) : (
        text
      ),
    );
    last = i + text.length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

// Excerpt of a `forge test` run (Oct 4). Test names only; counts live in the repo.
const FORGE_LINES: { text: string; kind?: "cmd" | "pass" | "dim" | "sum" }[] = [
  { text: "$ forge test", kind: "cmd" },
  { text: "Ran 17 tests for test/ParaclrClearinghouse.t.sol", kind: "dim" },
  { text: "[PASS] testFuzz_PnlMath(uint256,…,bool) (runs: 1024)", kind: "pass" },
  { text: "[PASS] test_FlashCrash_EightKeepersClearEightLanes()", kind: "pass" },
  { text: "[PASS] test_LaneIsolation_BadDebtStaysInLane()", kind: "pass" },
  { text: "[PASS] test_ParallelSafety_LaneBatchesTouchDisjointStorage()", kind: "pass" },
  { text: "[PASS] test_RevertWhen_BatchContainsAccountFromAnotherLane()", kind: "pass" },
  { text: "…", kind: "dim" },
];

export function Proof({ seeded, repo }: { seeded: BenchRun | null; repo: RepoFacts }) {
  return (
    <section id="proof" className={ui.section} aria-labelledby="proof-title">
      <div className={ui.container}>
        <div className={ui.sectionHead}>
          <p className={ui.eyebrow}>Proof, not promises</p>
          <h2 id="proof-title" className={ui.h2}>
            &ldquo;Disjoint storage&rdquo; <em>is a test, not a slogan.</em>
          </h2>
          <p className={ui.lede}>
            Before any chain sees it, a Foundry test runs a lane-3 batch and a lane-5 batch from the same state, records
            every storage slot each one touches with <code className={ui.code}>vm.record</code> /{" "}
            <code className={ui.code}>vm.accesses</code>, and fails on any write/write or read/write overlap. The
            Conflict X-ray is the same check, measured on a whole crash.
          </p>
        </div>

        <div className={styles.grid}>
          <div className={`${ui.panel} ${styles.codePanel}`}>
            <div className={ui.panelBar}>
              <span className={ui.trafficLights} aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className={styles.file}>contracts/test/ParaclrClearinghouse.t.sol</span>
              <a
                className={styles.fileLink}
                href={`${GITHUB_BLOB}/contracts/test/ParaclrClearinghouse.t.sol#L359`}
                target="_blank"
                rel="noreferrer"
              >
                source <ArrowUpRight className={styles.fileIcon} />
              </a>
            </div>
            <pre className={styles.code}>
              <code>{highlight(TEST_SOURCE)}</code>
            </pre>
          </div>

          <div className={styles.side}>
            <div className={`${ui.panel} ${styles.term}`}>
              <div className={ui.panelBar}>
                <span className={ui.trafficLights} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span>contracts/ · excerpt</span>
              </div>
              <pre className={styles.termBody}>
                {FORGE_LINES.map((l, i) => (
                  <span key={i} className={l.kind ? styles[l.kind] : undefined}>
                    {l.kind === "pass" ? (
                      <>
                        <b>[PASS]</b>
                        {l.text.slice(6)}
                      </>
                    ) : (
                      l.text
                    )}
                    {"\n"}
                  </span>
                ))}
              </pre>
            </div>

            <ul className={styles.stats}>
              {repo.foundryTests ? (
                <li className={ui.card}>
                  <span className={styles.statValue}>{fmtInt(repo.foundryTests)}</span>
                  <span className={styles.statLabel}>Foundry tests in the repo</span>
                  <span className={styles.statSub}>
                    {repo.invariantTests
                      ? `plus ${fmtInt(repo.invariantTests)} invariant test${repo.invariantTests === 1 ? "" : "s"} for the solvency identity`
                      : "including a 1,024-run fuzz of the PnL math"}
                  </span>
                </li>
              ) : null}
              <li className={ui.card}>
                <span className={styles.statValue}>Solvent</span>
                <span className={styles.statLabel}>Identity asserted after crashes</span>
                <span className={styles.statSub}>AUSD held = what the 8 lane ledgers say it should be</span>
              </li>
              {seeded?.accountsSeeded ? (
                <li className={ui.card}>
                  <span className={styles.statValue}>{fmtInt(seeded.accountsSeeded)}</span>
                  <span className={styles.statLabel}>Accounts seeded on-chain</span>
                  <span className={styles.statSub}>
                    {seeded.seedTxCount ? `${fmtInt(seeded.seedTxCount)} seedAccounts txs · ` : ""}
                    {seeded.chainId === MONAD_TESTNET_CHAIN_ID ? "Monad testnet" : "local anvil"} · synthetic
                    accounts, not users
                  </span>
                </li>
              ) : null}
            </ul>
          </div>
        </div>

        <p className={styles.limit}>
          <strong>What we can&rsquo;t show from outside:</strong> Monad&rsquo;s internal re-execution count. The on-chain
          evidence is the Conflict X-ray above and the measured runs below: tx hashes, block numbers, and whether the
          lanes&rsquo; transactions landed in the same block.
        </p>
      </div>
    </section>
  );
}
