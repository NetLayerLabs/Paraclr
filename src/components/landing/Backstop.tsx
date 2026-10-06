import { AUCTION } from "./content";
import ui from "./Landing.module.css";
import styles from "./Backstop.module.css";

const TERMS = [
  {
    k: "01",
    title: "Deposit per lane",
    body: "Each of the 8 lanes has its own pool. LPs deposit AUSD into a lane's pool for shares in it.",
  },
  {
    k: "02",
    title: "Earn the discount",
    body: `The pool takes that lane's auctions once the discount reaches its threshold (${AUCTION.backstopMinBps} bps by default) and is paid P = d × notional for each.`,
  },
  {
    k: "03",
    title: "Absorb the exposure",
    body: "The pool also inherits the positions, at the mark. If the market keeps moving against them, NAV falls. The discount is the payment for carrying that risk.",
  },
] as const;

const LEDGER: { op: string; effect: string; note?: string }[] = [
  { op: "backstopDeposit(lane, amount)", effect: "cash += amount · mint shares at NAV" },
  { op: "backstopTakeBatch(lane, …)", effect: "cash += P · exposure += inherited positions", note: "only when d ≥ minDiscount and the pool can carry the positions" },
  { op: "backstopReduce(lane, market, size)", effect: "close exposure at mark · realize PnL", note: "operator / keeper role" },
  { op: "backstopWithdraw(lane, shares)", effect: "cash −= amount · burn shares", note: "blocked if it would leave the pool under margin" },
];

export function Backstop() {
  return (
    <section id="backstop" className={ui.section} aria-labelledby="backstop-title">
      <div className={ui.container}>
        <div className={ui.sectionHead}>
          <p className={ui.eyebrow}>Backstop LPs</p>
          <h2 id="backstop-title" className={ui.h2}>
            A taker in every lane, <em>paid to hold the risk.</em>
          </h2>
          <p className={ui.lede}>
            Auctions need someone on the other side when the market is falling hardest. Each lane has a backstop pool
            that takes its auctions at a known threshold, so an underwater account is resolved within a bounded number
            of blocks even if no outside taker shows up. Pool storage is lane-local: 8 pools can take in the same block
            without touching each other&rsquo;s slots.
          </p>
        </div>

        <div className={styles.grid}>
          <ol className={styles.terms}>
            {TERMS.map((t) => (
              <li key={t.k} className={`${ui.card} ${styles.term}`}>
                <span className={styles.k}>{t.k}</span>
                <div>
                  <h3 className={ui.h3}>{t.title}</h3>
                  <p className={ui.body}>{t.body}</p>
                </div>
              </li>
            ))}
            <li className={styles.apy}>
              <span className={styles.apyTag}>No APY</span>
              <p>
                Pool returns are shown as <strong>earned since deploy</strong>: discount collected, notional absorbed,
                realized and unrealized PnL. A crash-driven income stream doesn&rsquo;t annualize honestly, so we
                don&rsquo;t.
              </p>
            </li>
          </ol>

          <figure className={`${ui.panel} ${styles.pool}`}>
            <div className={ui.panelBar}>
              <span className={ui.trafficLights} aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span>lane k · backstop pool</span>
              <span className={styles.local}>lane-local storage</span>
            </div>

            <div className={styles.nav}>
              <span className={styles.navKey}>NAV</span>
              <span className={styles.navEq}>
                = cash + unrealized PnL<span className={styles.dim}>(inherited positions, at mark)</span>
              </span>
            </div>

            <ul className={styles.ledger}>
              {LEDGER.map((l) => (
                <li key={l.op}>
                  <code className={styles.op}>{l.op}</code>
                  <span className={styles.effect}>{l.effect}</span>
                  {l.note ? <span className={styles.note}>{l.note}</span> : null}
                </li>
              ))}
            </ul>

            <div className={styles.lanes} aria-label="8 backstop pools, one per lane">
              {Array.from({ length: 8 }, (_, k) => (
                <span key={k} className={styles.lanePool}>
                  <b>L{k}</b>
                  <small>pool</small>
                </span>
              ))}
            </div>
            <figcaption className={styles.caption}>
              In the app, the Backstop tab shows each lane&rsquo;s NAV, discount earned since deploy, notional absorbed
              and inherited exposure, with deposit and withdraw. On testnet the operator seeds every pool with test
              AUSD.
            </figcaption>
          </figure>
        </div>
      </div>
    </section>
  );
}
