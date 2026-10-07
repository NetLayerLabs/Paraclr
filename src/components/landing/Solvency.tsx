import type { RepoFacts } from "./benchResults.server";
import { Check } from "./icons";
import { fmtInt } from "./format";
import b from "./brand/Brand.module.css";
import s from "./Solvency.module.css";

const TERMS = [
  { sign: "", name: "collateral", hint: "traders' AUSD, incl. returned equity" },
  { sign: "+", name: "insurance", hint: "the lane's insurance fund" },
  { sign: "+", name: "backstop cash", hint: "the lane's pool, excl. unrealized PnL" },
  { sign: "+", name: "keeper rewards owed", hint: "accrued, not yet claimed" },
  { sign: "−", name: "bad debt", hint: "shortfall the lane absorbed" },
] as const;

export function Solvency({ repo }: { repo: RepoFacts }) {
  return (
    <section
      id="solvency"
      className={`${b.dark} ${b.surface} ${b.section} ${s.section}`}
      aria-labelledby="solvency-title"
    >
      <div className={b.container}>
        <div className={s.grid}>
          <div className={s.copy}>
            <p className={b.eyebrow}>Solvency proof</p>
            <h2 id="solvency-title" className={b.h2}>
              The books are checked <em>every block.</em>
            </h2>
            <p className={b.lede}>
              Each lane keeps its own ledger in lane-local storage, so recording a liquidation never touches another
              lane. <code className={b.code}>solvency()</code> sums the 8 ledgers and compares the total with the AUSD
              the clearinghouse actually holds. The app reads it every block and shows the result in its header.
            </p>
            <ul className={s.checks}>
              <li>
                <Check className={s.tick} />
                <span>
                  Read live from the contract, not computed by the app: <code className={b.code}>solvency()</code> and{" "}
                  <code className={b.code}>laneLedger(lane)</code>.
                </span>
              </li>
              <li>
                <Check className={s.tick} />
                <span>
                  {repo.invariantTests ? (
                    <>
                      Covered by {fmtInt(repo.invariantTests)} Foundry invariant test
                      {repo.invariantTests === 1 ? "" : "s"}, which re-check the books after every randomized call.
                    </>
                  ) : (
                    <>Asserted in Foundry tests after every crash scenario.</>
                  )}
                </span>
              </li>
              <li>
                <Check className={s.tick} />
                <span>Bad debt is explicit: it appears in the identity instead of hiding inside a balance.</span>
              </li>
            </ul>
            <p className={s.preview}>
              <span>In the app header, every block</span>
              <span className={`${b.chip} ${b.chipPos}`}>
                <span className={`${b.dot} ${b.dotPos}`} aria-hidden="true" />
                Solvent · surplus ≥ 0
              </span>
              <span>If the identity ever breaks, the badge says so.</span>
            </p>
          </div>

          <figure className={`${b.card} ${s.identity}`}>
            <div className={s.bar}>
              <span className={b.chrome} aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className={s.barTitle}>the identity</span>
            </div>

            <div className={s.body}>
              <div className={s.lhs}>
                <code>
                  AUSD.balanceOf(
                  <wbr />
                  clearinghouse)
                </code>
                <span>what the contract holds</span>
              </div>
              <div className={s.equals} aria-label="equals">
                ==
              </div>
              <div className={s.rhs}>
                <span className={s.sigma}>
                  Σ<sub>8 lanes</sub>
                </span>
                <ul className={s.terms}>
                  {TERMS.map((t) => (
                    <li key={t.name}>
                      <span className={t.sign === "−" ? s.minus : s.sign}>{t.sign}</span>
                      <code>{t.name}</code>
                      <small>{t.hint}</small>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className={s.lanes} aria-label="8 lane ledgers summed by solvency()">
              {Array.from({ length: 8 }, (_, k) => (
                <span key={k}>L{k}</span>
              ))}
              <span className={s.sum}>→ solvency()</span>
            </div>

            <pre className={s.sig}>
              <code>
                <span className={s.kw}>function</span> solvency() <span className={s.kw}>view returns</span>
                {"\n"} (uint256 ausdHeld, uint256 liabilities, int256 surplus, bool solvent)
                {"\n"}
                <span className={s.cm}>{"// surplus = ausdHeld − liabilities; solvent = surplus ≥ 0"}</span>
              </code>
            </pre>
          </figure>
        </div>
      </div>
    </section>
  );
}
