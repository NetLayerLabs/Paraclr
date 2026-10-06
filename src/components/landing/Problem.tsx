import ui from "./Landing.module.css";
import styles from "./Problem.module.css";

const ISSUES = [
  {
    tag: "fixed penalty",
    title: "The price is set before the crash",
    what: "The liquidation fee is a constant: the same in a calm market and in a cascade. A taker who would accept less has no way to offer less.",
  },
  {
    tag: "gas bidding",
    title: "Bots compete on gas, not on price",
    what: "Whoever lands first collects the whole fee, so liquidators bid for priority and ordering. None of that competition flows back to the trader.",
  },
  {
    tag: "no discovery",
    title: "Nobody learns what the takeover was worth",
    what: "One winner, one fixed price. The trader pays it whether a taker would have stepped in for a fraction of it or not.",
  },
] as const;

const BOTS = [
  { name: "bot A", fee: 94, wins: true },
  { name: "bot B", fee: 78, wins: false },
  { name: "bot C", fee: 61, wins: false },
] as const;

export function Problem() {
  return (
    <section className={ui.section} aria-labelledby="problem-title">
      <div className={ui.container}>
        <div className={ui.sectionHead}>
          <p className={ui.eyebrow}>The problem</p>
          <h2 id="problem-title" className={ui.h2}>
            Liquidation is a race. <em>The trader pays for it.</em>
          </h2>
          <p className={ui.lede}>
            On a typical on-chain perps venue an underwater account goes to whichever bot lands the liquidation first,
            for a penalty fixed in advance. Bots compete on gas and ordering rather than on price, so the penalty never
            falls when takers would have accepted less, and the trader can pay{" "}
            <strong>more than a competitive price for the takeover</strong>.
          </p>
        </div>

        <div className={styles.grid}>
          <figure className={`${ui.card} ${styles.race}`}>
            <figcaption className={styles.cardHead}>
              <span className={styles.cardTitle}>First bot wins</span>
              <span className={styles.schematic}>Schematic</span>
            </figcaption>

            <div className={styles.account}>
              <span className={styles.accountDot} aria-hidden="true" />
              <span>
                <code>0x4c…e2</code> below maintenance margin
              </span>
              <span className={styles.accountTag}>liquidatable</span>
            </div>

            <ol className={styles.bots} aria-label="Three liquidation bots bidding priority fees for the same account">
              {BOTS.map((b) => (
                <li key={b.name} className={b.wins ? styles.botWin : styles.bot}>
                  <span className={styles.botName}>{b.name}</span>
                  <span className={styles.botTrack}>
                    <span className={styles.botBar} style={{ width: `${b.fee}%` }} />
                  </span>
                  <span className={styles.botOut}>{b.wins ? "lands first" : "too late"}</span>
                </li>
              ))}
            </ol>
            <p className={styles.axis}>
              <span>priority fee bid</span>
              <span aria-hidden="true">→</span>
            </p>

            <div className={styles.fee} aria-label="The penalty is the same in a calm market and in a crash">
              <p className={styles.feeHead}>penalty the trader pays</p>
              {["calm market", "−20% crash"].map((m) => (
                <div key={m} className={styles.feeRow}>
                  <span className={styles.feeKey}>{m}</span>
                  <span className={styles.feeTrack}>
                    <span className={styles.feeBar}>fixed fee</span>
                  </span>
                </div>
              ))}
            </div>

            <div className={styles.payout}>
              <div className={styles.payRow}>
                <span className={styles.payKey}>winner gets</span>
                <span className={styles.payVal}>the fixed penalty, in full</span>
              </div>
              <div className={styles.payRow}>
                <span className={styles.payKey}>trader pays</span>
                <span className={styles.payBad}>the same penalty, however hard the bots competed</span>
              </div>
            </div>
          </figure>

          <ul className={styles.issues}>
            {ISSUES.map((it) => (
              <li key={it.tag} className={`${ui.card} ${styles.issue}`}>
                <code className={styles.issueTag}>{it.tag}</code>
                <h3 className={ui.h3}>{it.title}</h3>
                <p className={ui.body}>{it.what}</p>
              </li>
            ))}
          </ul>
        </div>

        <div className={styles.turn}>
          <span className={styles.turnTag}>Paraclr</span>
          <p>
            Replace the race with a clock. The discount starts at <strong>0</strong> and rises{" "}
            <strong>25 bps per block</strong>; the first taker gets the discount of the block it lands in, and the
            trader keeps the rest of their equity. Paying more gas can&rsquo;t raise the discount, it can only take
            earlier, at a smaller one.
          </p>
        </div>
      </div>
    </section>
  );
}
