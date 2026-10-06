import type { RepoFacts } from "./benchResults.server";
import { Check } from "./icons";
import { fmtInt } from "./format";
import ui from "./Landing.module.css";
import styles from "./Solvency.module.css";

const TERMS = [
  { sign: "", name: "collateral", hint: "traders' AUSD, incl. returned equity" },
  { sign: "+", name: "insurance", hint: "the lane's insurance fund" },
  { sign: "+", name: "backstop cash", hint: "the lane's pool, excl. unrealized PnL" },
  { sign: "+", name: "keeper rewards owed", hint: "accrued, not yet claimed" },
  { sign: "−", name: "bad debt", hint: "shortfall the lane absorbed" },
] as const;

export function Solvency({ repo }: { repo: RepoFacts }) {
  return (
    <section id="solvency" className={ui.section} aria-labelledby="solvency-title">
      <div className={ui.container}>
        <div className={ui.sectionHead}>
          <p className={ui.eyebrow}>Solvency proof</p>
          <h2 id="solvency-title" className={ui.h2}>
            The books are checked <em>every block.</em>
          </h2>
          <p className={ui.lede}>
            Each lane keeps its own ledger in lane-local storage, so recording a liquidation never touches another
            lane. <code className={ui.code}>solvency()</code> sums the 8 ledgers and compares the total with the AUSD the
            clearinghouse actually holds. The app reads it every block and shows the result in its header.
          </p>
        </div>

        <div className={styles.grid}>
          <figure className={`${ui.panel} ${styles.identity}`}>
            <div className={ui.panelBar}>
              <span className={ui.trafficLights} aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span>the identity</span>
            </div>

            <div className={styles.body}>
              <div className={styles.lhs}>
                <code>
                  AUSD.balanceOf(
                  <wbr />
                  clearinghouse)
                </code>
                <span>what the contract holds</span>
              </div>
              <div className={styles.equals} aria-label="equals">
                ==
              </div>
              <div className={styles.rhs}>
                <span className={styles.sigma}>
                  Σ<sub>lanes</sub>
                </span>
                <ul className={styles.terms}>
                  {TERMS.map((t) => (
                    <li key={t.name}>
                      <span className={t.sign === "−" ? styles.signMinus : styles.sign}>{t.sign}</span>
                      <code>{t.name}</code>
                      <small>{t.hint}</small>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className={styles.lanes} aria-label="8 lane ledgers summed by solvency()">
              {Array.from({ length: 8 }, (_, k) => (
                <span key={k}>
                  <b>L{k}</b> ledger
                </span>
              ))}
              <span className={styles.sum}>→ solvency()</span>
            </div>

            <pre className={styles.sig}>
              <code>
                <span className={styles.kw}>function</span> solvency() <span className={styles.kw}>view returns</span>
                {"\n"}  (uint256 ausdHeld, uint256 liabilities, int256 surplus, bool solvent)
                {"\n"}
                <span className={styles.cm}>
                  {"// surplus = ausdHeld − liabilities (0 unless AUSD is sent in directly); solvent = surplus ≥ 0"}
                </span>
              </code>
            </pre>
          </figure>

          <div className={styles.side}>
            <div className={`${ui.card} ${styles.badgeCard}`}>
              <span className={styles.badgeLabel}>In the app header, every block</span>
              <span className={styles.badge}>
                <span className={styles.badgeDot} aria-hidden="true" />
                Solvent
                <span className={styles.badgeSub}>surplus ≥ 0</span>
              </span>
              <p className={ui.body}>
                Click it for the detail: AUSD held, liabilities, surplus, and each lane&rsquo;s ledger. If the identity
                ever breaks, the badge says so.
              </p>
            </div>

            <ul className={styles.checks}>
              <li>
                <Check className={styles.tick} />
                <span>
                  Read live from the contract, not computed by the app: <code className={ui.code}>solvency()</code> and{" "}
                  <code className={ui.code}>laneLedger(lane)</code>.
                </span>
              </li>
              <li>
                <Check className={styles.tick} />
                <span>
                  {repo.invariantTests ? (
                    <>
                      Covered by {fmtInt(repo.invariantTests)} Foundry invariant test{repo.invariantTests === 1 ? "" : "s"},
                      which re-check the identity after every randomized call.
                    </>
                  ) : (
                    <>Asserted in Foundry tests after every crash scenario.</>
                  )}
                </span>
              </li>
              <li>
                <Check className={styles.tick} />
                <span>Bad debt is explicit: it appears in the identity instead of hiding inside a balance.</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
