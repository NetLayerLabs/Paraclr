import type { CSSProperties, ReactNode } from "react";
import { AUCTION } from "./content";
import ui from "./Landing.module.css";
import styles from "./Auction.module.css";

type Vars = CSSProperties & Record<`--${string}`, string | number>;

const LAST = AUCTION.maxBps / AUCTION.stepBps; // block +20 reaches the cap
const TAKE = AUCTION.backstopMinBps / AUCTION.stepBps; // block +3 reaches the pool threshold
const BLOCKS = Array.from({ length: LAST + 1 }, (_, b) => b);
const Y_TICKS = [0, 100, 200, 300, 400, 500];

const MARKERS: Record<number, { n: string; cls: string }> = {
  2: { n: "1", cls: "markExternal" },
  [TAKE]: { n: "2", cls: "markTake" },
  [LAST]: { n: "3", cls: "markExpire" },
};

function barClass(b: number): string {
  if (b === TAKE) return styles.barTake;
  if (b < TAKE) return styles.barLive;
  if (b === LAST) return styles.barCap;
  return styles.barUntaken;
}

interface Step {
  n: string;
  title: string;
  code: ReactNode;
  body: ReactNode;
}

const STEPS: Step[] = [
  {
    n: "01",
    title: "Start",
    code: <>startAuctions(lane, accounts)</>,
    body: (
      <>
        Anyone can put an account below the {AUCTION.maintenanceBps / 100}% maintenance margin into auction. It&rsquo;s
        frozen: no withdrawals, no new positions. Deposits still work.
      </>
    ),
  },
  {
    n: "02",
    title: "Tick",
    code: (
      <>
        d = min({AUCTION.maxBps}, {AUCTION.stepBps} × blocks)
      </>
    ),
    body: (
      <>
        The discount <b>d</b> starts at 0 and rises {AUCTION.stepBps} bps per block since the start. Only the block
        number moves it; a higher gas bid doesn&rsquo;t.
      </>
    ),
  },
  {
    n: "03",
    title: "Take",
    code: <>backstopTakeBatch(lane, …) · take(account)</>,
    body: (
      <>
        The taker inherits the positions at the mark and is paid <b>P = d × notional</b>. The lane&rsquo;s backstop
        pool takes at its threshold; an account in the same lane can take any block before, if it stays above initial
        margin, but is paid only out of the trader&rsquo;s own equity: <b>min(P, E)</b>. The lane never subsidizes
        an outside taker, so nobody can profit by liquidating their own account.
      </>
    ),
  },
  {
    n: "04",
    title: "Cure or expire",
    code: <>cancelAuction(account) · expireBatch(lane, …)</>,
    body: (
      <>
        Healthy again after a top-up or a price recovery? Anyone can cancel the auction. Still untaken at{" "}
        {AUCTION.maxBps} bps? It closes at mark through the old 1% fee path; any shortfall hits lane insurance, then
        lane bad debt.
      </>
    ),
  },
];

export function Auction() {
  return (
    <section id="auction" className={`${ui.section} ${ui.sectionAlt}`} aria-labelledby="auction-title">
      <div className={ui.container}>
        <div className={ui.sectionHead}>
          <p className={ui.eyebrow}>How the auction works</p>
          <h2 id="auction-title" className={ui.h2}>
            A Dutch auction per account, <em>priced by the block clock.</em>
          </h2>
          <p className={ui.lede}>
            Every block, the sweeper starts auctions for newly underwater accounts in all 8 lanes. The discount a taker
            earns climbs block by block until someone takes the account, and whatever equity the taker isn&rsquo;t
            paid goes <strong>back to the trader</strong> as free collateral.
          </p>
        </div>

        <div className={styles.grid}>
          <figure className={`${ui.card} ${styles.chartCard}`}>
            <figcaption className={styles.chartHead}>
              <span className={styles.chartTitle}>Discount by block after the auction starts</span>
              <span className={styles.chartSub}>
                +{AUCTION.stepBps} bps / block · cap {AUCTION.maxBps} bps · contract defaults
              </span>
            </figcaption>

            <div className={styles.plot}>
              <div className={styles.yAxis} aria-hidden="true">
                {Y_TICKS.map((t) => (
                  <span key={t} style={{ "--y": t / AUCTION.maxBps } as Vars}>
                    {t}
                  </span>
                ))}
                <span className={styles.yTake} style={{ "--y": AUCTION.backstopMinBps / AUCTION.maxBps } as Vars}>
                  {AUCTION.backstopMinBps}
                </span>
              </div>
              <div className={styles.area}>
                {Y_TICKS.map((t) => (
                  <i key={t} className={styles.gridLine} style={{ "--y": t / AUCTION.maxBps } as Vars} aria-hidden="true" />
                ))}
                <i
                  className={styles.threshold}
                  style={{ "--y": AUCTION.backstopMinBps / AUCTION.maxBps } as Vars}
                  aria-hidden="true"
                />
                <ol className={styles.bars} aria-label={`Discount rises ${AUCTION.stepBps} basis points per block from 0 to ${AUCTION.maxBps}`}>
                  {BLOCKS.map((b) => {
                    const bps = Math.min(AUCTION.maxBps, b * AUCTION.stepBps);
                    const m = MARKERS[b];
                    return (
                      <li key={b} className={styles.col} aria-label={`block +${b}: ${bps} bps`}>
                        <span className={barClass(b)} style={{ "--h": bps / AUCTION.maxBps } as Vars}>
                          {m ? (
                            <span className={`${styles.mark} ${styles[m.cls]}`} aria-hidden="true">
                              {m.n}
                            </span>
                          ) : null}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </div>
              <div className={styles.xAxis} aria-hidden="true">
                {BLOCKS.filter((b) => b % 5 === 0 || b === TAKE).map((b) => (
                  <span
                    key={b}
                    style={{ "--x": (b + 0.5) / (LAST + 1) } as Vars}
                    className={b === TAKE ? styles.xTake : b === TAKE - 1 ? styles.xNearTake : undefined}
                  >
                    +{b}
                  </span>
                ))}
              </div>
              <p className={styles.xLabel}>blocks since start · discount in bps</p>
            </div>

            <ol className={styles.keys}>
              <li>
                <span className={`${styles.mark} ${styles.markExternal}`}>1</span>
                <span>
                  <b>External taker</b>, any block: an account in the same lane takes at the current discount if it stays
                  above initial margin.
                </span>
              </li>
              <li>
                <span className={`${styles.mark} ${styles.markTake}`}>2</span>
                <span>
                  <b>Backstop pool</b> takes at its minimum discount (dashed line): {AUCTION.backstopMinBps} bps by default,
                  block +{TAKE}, ≈ {((TAKE * 400) / 1000).toFixed(1)} s at 400 ms blocks.
                </span>
              </li>
              <li>
                <span className={`${styles.mark} ${styles.markExpire}`}>3</span>
                <span>
                  <b>Cap</b> at {AUCTION.maxBps} bps, block +{LAST}. Untaken (say, an empty pool), it expires and closes at
                  mark through the old fixed-fee path.
                </span>
              </li>
            </ol>
          </figure>

          <div className={styles.side}>
            <figure className={`${ui.card} ${styles.split}`}>
              <figcaption className={styles.chartHead}>
                <span className={styles.chartTitle}>At the take: where the equity goes</span>
                <span className={styles.schematic}>Schematic</span>
              </figcaption>
              <p className={styles.eq}>
                <span>E</span> = collateral + PnL at mark
              </p>
              <div className={styles.splitBar} aria-hidden="true">
                <span className={styles.splitTaker}>
                  <b>P</b> to taker
                </span>
                <span className={styles.splitTrader}>
                  <b>E − P</b> back to trader
                </span>
              </div>
              <dl className={styles.splitRows}>
                <div>
                  <dt>Taker</dt>
                  <dd>
                    gets <b>P = d × notional</b> (outside takers: capped at the trader&rsquo;s equity) and the
                    positions, entered at the mark
                  </dd>
                </div>
                <div>
                  <dt>Trader</dt>
                  <dd>
                    keeps <b>max(0, E − P)</b> as free collateral; account unfrozen
                  </dd>
                </div>
                <div>
                  <dt>E &lt; P</dt>
                  <dd>lane insurance pays the shortfall, then lane bad debt. The trader never loses more than E.</dd>
                </div>
              </dl>
            </figure>

            <aside className={styles.mev}>
              <span className={styles.mevTag}>MEV-resistant, not MEV-free</span>
              <p>
                The price comes from the block clock, so out-bidding on gas can&rsquo;t buy a bigger discount: it only
                lands a take earlier, at a smaller one. Ordering still matters when two takers want the same block, so we
                don&rsquo;t claim there&rsquo;s no MEV.
              </p>
            </aside>
          </div>
        </div>

        <ol className={styles.steps}>
          {STEPS.map((s) => (
            <li key={s.n} className={`${ui.card} ${styles.step}`}>
              <div className={styles.stepHead}>
                <span className={styles.n}>{s.n}</span>
                <h3 className={ui.h3}>{s.title}</h3>
              </div>
              <code className={styles.stepCode}>{s.code}</code>
              <p className={styles.stepBody}>{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
