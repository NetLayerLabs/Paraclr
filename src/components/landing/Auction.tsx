import type { CSSProperties, ReactNode } from "react";
import { Layers, Percent, Shield } from "./icons";
import { AUCTION, TESTNET_AUCTION_STEP_BPS } from "./content";
import b from "./brand/Brand.module.css";
import s from "./Auction.module.css";

type Vars = CSSProperties & Record<`--${string}`, string | number>;

const LAST = AUCTION.maxBps / AUCTION.stepBps; // block +20 reaches the cap
const TAKE = AUCTION.backstopMinBps / AUCTION.stepBps; // block +3 reaches the pool threshold
const BLOCKS = Array.from({ length: LAST + 1 }, (_, i) => i);
const Y_TICKS = [0, 100, 200, 300, 400, 500];

const MARKERS: Record<number, { n: string; cls: string }> = {
  2: { n: "1", cls: "markExternal" },
  [TAKE]: { n: "2", cls: "markTake" },
  [LAST]: { n: "3", cls: "markCap" },
};

function barClass(i: number): string {
  if (i === TAKE) return s.barTake;
  if (i < TAKE) return s.barLive;
  if (i === LAST) return s.barCap;
  return s.barIdle;
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
        The taker inherits the positions at the mark and is paid <b>P = d × notional</b>. An account in the same lane
        can take any block before the pool, if it stays above initial margin, but is paid only out of the trader&rsquo;s
        own equity, <b>min(P, E)</b>, so nobody profits by liquidating their own account.
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

const POOL = [
  {
    icon: Layers,
    title: "Deposit per lane",
    body: "Each of the 8 lanes has its own pool. LPs deposit AUSD into a lane's pool for shares in it, and pool storage is lane-local: 8 pools can take in the same block without touching each other's slots.",
  },
  {
    icon: Percent,
    title: "Earn the discount",
    body: `The pool takes that lane's auctions once the discount reaches its threshold (${AUCTION.backstopMinBps} bps by default, below the old 1% fixed fee) and is paid P = d × notional for each.`,
  },
  {
    icon: Shield,
    title: "Absorb the exposure",
    body: "The pool also inherits the positions, at the mark. If the market keeps moving against them, NAV falls. The discount is the payment for carrying that risk.",
  },
] as const;

export function Auction() {
  return (
    <section
      id="auction"
      className={`${b.light} ${b.surface} ${b.section} ${s.section}`}
      aria-labelledby="auction-title"
    >
      <div className={b.container}>
        <div className={b.sectionHead}>
          <p className={b.eyebrow}>How the auction works</p>
          <h2 id="auction-title" className={b.h2}>
            A Dutch auction per account, <em>priced by the block clock.</em>
          </h2>
          <p className={b.lede}>
            Every block, the sweeper starts auctions for newly underwater accounts in all 8 lanes. The discount a taker
            earns climbs block by block until someone takes the account, and whatever equity the taker isn&rsquo;t paid
            goes <strong>back to the trader</strong> as free collateral.
          </p>
        </div>

        <div className={s.grid}>
          <figure className={`${b.card} ${s.chart}`}>
            <figcaption className={s.cardHead}>
              <span className={s.cardTitle}>Discount by block after the auction starts</span>
              <span className={s.cardSub}>
                +{AUCTION.stepBps} bps / block · cap {AUCTION.maxBps} bps · contract defaults
              </span>
            </figcaption>

            <div className={s.plot}>
              <div className={s.yAxis} aria-hidden="true">
                {Y_TICKS.map((t) => (
                  <span key={t} style={{ "--y": t / AUCTION.maxBps } as Vars}>
                    {t}
                  </span>
                ))}
                <span className={s.yTake} style={{ "--y": AUCTION.backstopMinBps / AUCTION.maxBps } as Vars}>
                  {AUCTION.backstopMinBps}
                </span>
              </div>
              <div className={s.area}>
                {Y_TICKS.map((t) => (
                  <i key={t} className={s.gridLine} style={{ "--y": t / AUCTION.maxBps } as Vars} aria-hidden="true" />
                ))}
                <i
                  className={s.threshold}
                  style={{ "--y": AUCTION.backstopMinBps / AUCTION.maxBps } as Vars}
                  aria-hidden="true"
                />
                <ol
                  className={s.bars}
                  aria-label={`Discount rises ${AUCTION.stepBps} basis points per block from 0 to ${AUCTION.maxBps}`}
                >
                  {BLOCKS.map((i) => {
                    const bps = Math.min(AUCTION.maxBps, i * AUCTION.stepBps);
                    const m = MARKERS[i];
                    return (
                      <li key={i} className={s.col} aria-label={`block +${i}: ${bps} bps`}>
                        <span className={barClass(i)} style={{ "--h": bps / AUCTION.maxBps } as Vars}>
                          {m ? (
                            <span className={`${s.mark} ${s[m.cls]}`} aria-hidden="true">
                              {m.n}
                            </span>
                          ) : null}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </div>
              <div className={s.xAxis} aria-hidden="true">
                {BLOCKS.filter((i) => i % 5 === 0 || i === TAKE).map((i) => (
                  <span
                    key={i}
                    style={{ "--x": (i + 0.5) / (LAST + 1) } as Vars}
                    className={i === TAKE ? s.xTake : undefined}
                  >
                    +{i}
                  </span>
                ))}
              </div>
              <p className={s.xLabel}>blocks since start · discount in bps</p>
            </div>

            <ol className={s.keys}>
              <li>
                <span className={`${s.mark} ${s.markExternal}`}>1</span>
                <span>
                  <b>Outside taker</b>, any block: an account in the same lane takes at the current discount if it stays
                  above initial margin.
                </span>
              </li>
              <li>
                <span className={`${s.mark} ${s.markTake}`}>2</span>
                <span>
                  <b>Backstop pool</b> takes at its minimum discount (dashed line): {AUCTION.backstopMinBps} bps by
                  default, block +{TAKE}, about {((TAKE * 400) / 1000).toFixed(1)} s at 400 ms blocks.
                </span>
              </li>
              <li>
                <span className={`${s.mark} ${s.markCap}`}>3</span>
                <span>
                  <b>Cap</b> at {AUCTION.maxBps} bps, block +{LAST}. Untaken (say, an empty pool), it expires and closes
                  at mark through the old fixed-fee path.
                </span>
              </li>
            </ol>
            <p className={s.deployNote}>
              On the Monad testnet deployment the step is {TESTNET_AUCTION_STEP_BPS} bps per block, set through the
              timelock: Monad&rsquo;s blocks come every ~0.35 s, so the pool&rsquo;s {AUCTION.backstopMinBps} bps minimum
              arrives after {AUCTION.backstopMinBps / TESTNET_AUCTION_STEP_BPS} blocks (about{" "}
              {Math.round((AUCTION.backstopMinBps / TESTNET_AUCTION_STEP_BPS) * 0.35)} s) and the cap after{" "}
              {AUCTION.maxBps / TESTNET_AUCTION_STEP_BPS} (about {Math.round((AUCTION.maxBps / TESTNET_AUCTION_STEP_BPS) * 0.35)} s),
              which leaves the keepers time to react.
            </p>
          </figure>

          <div className={s.side}>
            <figure className={`${b.card} ${s.split}`}>
              <figcaption className={s.cardHead}>
                <span className={s.cardTitle}>At the take: where the equity goes</span>
                <span className={b.tagIllustration}>Schematic</span>
              </figcaption>
              <p className={s.eq}>
                <b>E</b> = collateral + PnL at mark
              </p>
              <div className={s.splitBar} aria-hidden="true">
                <span className={s.splitTaker}>
                  <b>P</b> taker
                </span>
                <span className={s.splitTrader}>
                  <b>E − P</b> back to the trader
                </span>
              </div>
              <dl className={s.splitRows}>
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

            <aside className={s.mev}>
              <span className={b.chip}>MEV-resistant, not MEV-free</span>
              <p>
                The price comes from the block clock, so out-bidding on gas can&rsquo;t buy a bigger discount: it only
                lands a take earlier, at a smaller one. Ordering still matters when two takers want the same block, so
                we don&rsquo;t claim there&rsquo;s no MEV.
              </p>
            </aside>
          </div>
        </div>

        <ol className={s.steps} aria-label="Auction lifecycle">
          {STEPS.map((step) => (
            <li key={step.n} className={s.step}>
              <span className={s.stepNode} aria-hidden="true">
                {step.n}
              </span>
              <div className={`${b.card} ${s.stepCard}`}>
                <h3 className={b.h3}>
                  <span className={b.srOnly}>Step {step.n}: </span>
                  {step.title}
                </h3>
                <code className={s.stepCode}>{step.code}</code>
                <p className={s.stepBody}>{step.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div id="backstop" className={s.pool}>
          <div className={s.poolHead}>
            <p className={b.eyebrow}>Backstop LPs</p>
            <h3 className={s.poolTitle}>
              A taker in every lane, <em>paid to hold the risk.</em>
            </h3>
            <p className={b.body}>
              Auctions need someone on the other side when the market is falling hardest. Each lane has a backstop pool
              that takes its auctions at a known threshold, so an underwater account is resolved within a bounded number
              of blocks even if no outside taker shows up.
            </p>
          </div>
          <ul className={s.poolCards}>
            {POOL.map(({ icon: Icon, title, body }) => (
              <li key={title} className={`${b.card} ${b.cardPad} ${s.poolCard}`}>
                <span className={b.iconTile}>
                  <Icon />
                </span>
                <h4 className={b.h3}>{title}</h4>
                <p className={b.body}>{body}</p>
              </li>
            ))}
          </ul>
          <p className={s.noApy}>
            <span className={`${b.chip} ${b.chipAccent}`}>No APY</span>
            <span>
              Pool returns are shown as <strong>earned since deploy</strong>: discount collected, notional absorbed,
              realized and unrealized PnL. A crash-driven income stream doesn&rsquo;t annualize honestly, so we
              don&rsquo;t. On testnet the operator seeds every pool with test AUSD.
            </span>
          </p>
        </div>
      </div>
    </section>
  );
}
