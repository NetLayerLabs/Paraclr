import type { RepoFacts } from "./benchResults.server";
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
                Read live from the contract, not computed by the app: <code className={b.code}>solvency()</code> and{" "}
                <code className={b.code}>laneLedger(lane)</code>.
              </li>
              <li>
                {repo.invariantTests ? (
                  <>
                    Covered by {fmtInt(repo.invariantTests)} Foundry invariant test
                    {repo.invariantTests === 1 ? "" : "s"}, which re-check the books after every randomized call.
                  </>
                ) : (
                  <>Asserted in Foundry tests after every crash scenario.</>
                )}
              </li>
              <li>Bad debt is explicit: it appears in the identity instead of hiding inside a balance.</li>
            </ul>
            <p className={s.preview}>
              In the app header, every block:{" "}
              <span className={s.badge}>
                <span className={`${b.dot} ${b.dotPos}`} aria-hidden="true" />
                Solvent · surplus ≥ 0
              </span>
              . If the identity ever breaks, the badge says so.
            </p>
          </div>

          <figure className={s.identity}>
            <figcaption className={s.idHead}>
              <span className={s.kicker}>The identity</span>
              <span className={s.idNote}>solvent while this holds</span>
            </figcaption>

            <table className={s.terms}>
              <caption className={b.srOnly}>
                Solvent while the AUSD held by the clearinghouse is at least the sum over the 8 lanes of collateral,
                insurance, backstop cash and keeper rewards owed, minus bad debt
              </caption>
              <tbody>
                <tr className={s.lhs}>
                  <td aria-hidden="true" />
                  <th scope="row">
                    <code>AUSD.balanceOf(clearinghouse)</code>
                  </th>
                  <td>what the contract holds</td>
                </tr>
                <tr className={s.sumRow}>
                  <td className={s.op}>≥</td>
                  <td colSpan={2}>
                    <span className={s.sigma}>Σ</span> over the 8 lane ledgers, L0 to L7, of
                  </td>
                </tr>
                {TERMS.map((t) => (
                  <tr key={t.name}>
                    <td className={t.sign === "−" ? `${s.op} ${s.minus}` : s.op}>{t.sign}</td>
                    <th scope="row">
                      <code>{t.name}</code>
                    </th>
                    <td>{t.hint}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <pre className={s.sig}>
              <code>
                <span className={s.kw}>function</span> solvency() <span className={s.kw}>external view returns</span> (
                {"\n"}  uint256 ausdHeld,
                {"\n"}  uint256 liabilities,
                {"\n"}  int256 surplus,
                {"\n"}  bool solvent
                {"\n"});
                {"\n"}
                <span className={s.cm}>{"// surplus = ausdHeld - liabilities; solvent = surplus >= 0"}</span>
              </code>
            </pre>
          </figure>
        </div>
      </div>
    </section>
  );
}
