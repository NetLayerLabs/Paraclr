import type { CSSProperties, ReactNode } from "react";
import { aboutSeconds, AUCTION, auctionStepBps, README_AT } from "./content";
import b from "./brand/Brand.module.css";
import s from "./Auction.module.css";

type Vars = CSSProperties & Record<`--${string}`, string | number>;

const Y_TICKS = [0, 100, 200, 300, 400, 500];

interface Step {
  n: string;
  title: string;
  code: string;
  line: ReactNode;
}

function steps(step: number): Step[] {
  return [
    {
      n: "01",
      title: "Start",
      code: "startAuctions(lane, accounts)",
      line: <>Anyone can put an account below maintenance margin into auction; it&rsquo;s frozen.</>,
    },
    {
      n: "02",
      title: "Tick",
      code: `d = min(${AUCTION.maxBps}, ${step} × blocks)`,
      line: <>The discount rises with the block number, never with a gas bid.</>,
    },
    {
      n: "03",
      title: "Take",
      code: "backstopTakeBatch · take",
      line: (
        <>
          The taker gets the positions and <b>P = d × notional</b>; the trader keeps <b>E − P</b>.
        </>
      ),
    },
    {
      n: "04",
      title: "Cure or expire",
      code: "cancelAuction · expireBatch",
      line: <>Healthy again: cancelled. Untaken at {AUCTION.maxBps} bps: closed at mark.</>,
    },
  ];
}

/** Discount by block, drawn for the step the page quotes (testnet deployment or contract default). */
function Chart({ step, onTestnet }: { step: number; onTestnet: boolean }) {
  const last = Math.ceil(AUCTION.maxBps / step); // block that reaches the cap
  const take = Math.ceil(AUCTION.backstopMinBps / step); // block that reaches the pool threshold
  const n = last + 1;
  const blocks = Array.from({ length: n }, (_, i) => i);
  const xEvery = last > 40 ? 20 : 5;
  const x = (i: number) => (i + 0.5) / n;
  const yTake = AUCTION.backstopMinBps / AUCTION.maxBps;
  return (
    <figure className={s.chart}>
      <figcaption className={s.head}>
        <h3 className={s.title}>Discount by block after the auction starts</h3>
        <p className={s.sub}>
          {onTestnet ? (
            <>
              As deployed on Monad testnet: +{step} bps per block, cap {AUCTION.maxBps} bps. The contract default is +
              {AUCTION.stepBps}, which reaches the cap at block +{AUCTION.maxBps / AUCTION.stepBps} (
              {aboutSeconds(AUCTION.maxBps / AUCTION.stepBps)}); the testnet step was lowered through the timelock so
              keepers on a public RPC have time to react.
            </>
          ) : (
            <>
              Contract defaults: +{step} bps per block, cap {AUCTION.maxBps} bps. Both are owner-configurable through the
              timelock.
            </>
          )}
        </p>
      </figcaption>

      <div className={s.plot}>
        <div className={s.yAxis} aria-hidden="true">
          {Y_TICKS.filter((t) => Math.abs(t - AUCTION.backstopMinBps) >= 40).map((t) => (
            <span key={t} style={{ "--y": t / AUCTION.maxBps } as Vars}>
              {t}
            </span>
          ))}
        </div>
        <div className={s.area} style={{ "--n": n } as Vars}>
          {Y_TICKS.slice(1).map((t) => (
            <i key={t} className={s.gridLine} style={{ "--y": t / AUCTION.maxBps } as Vars} aria-hidden="true" />
          ))}
          <ol
            className={s.bars}
            aria-label={`Discount rises ${step} basis points per block from 0 to ${AUCTION.maxBps}, reached at block +${last}`}
          >
            {blocks.map((i) => {
              const bps = Math.min(AUCTION.maxBps, i * step);
              return (
                <li key={i} aria-label={`block +${i}: ${bps} bps`}>
                  <span
                    className={i === take ? s.barTake : s.bar}
                    style={{ "--h": bps / AUCTION.maxBps } as Vars}
                  />
                </li>
              );
            })}
          </ol>
          <i className={s.threshold} style={{ "--y": yTake } as Vars} aria-hidden="true" />
          <span className={s.thresholdLabel} style={{ "--y": yTake } as Vars} aria-hidden="true">
            {AUCTION.backstopMinBps}
          </span>
          <span className={s.takeLeader} style={{ "--x": x(take), "--y": yTake } as Vars} aria-hidden="true" />
          <span className={s.takeLabel} style={{ "--x": x(take) } as Vars} aria-hidden="true">
            <b>Backstop pool takes at {AUCTION.backstopMinBps} bps</b>
            block +{take}, {aboutSeconds(take)}
          </span>
          <span className={s.capLabel} aria-hidden="true">
            <b>Cap {AUCTION.maxBps} bps</b>
            block +{last}, {aboutSeconds(last)}
          </span>
        </div>
        <div className={s.xAxis} aria-hidden="true">
          {blocks
            .filter((i) => i % xEvery === 0)
            .map((i) => (
              <span key={i} style={{ "--x": x(i) } as Vars}>
                +{i}
              </span>
            ))}
        </div>
        <p className={s.xLabel}>blocks since the auction started · discount in bps · seconds at ~0.35 s blocks</p>
      </div>

      <dl className={s.keys}>
        <div>
          <dt>Outside taker</dt>
          <dd>
            Any block, at the current discount: an account in the same lane takes if it stays above initial margin.
          </dd>
        </div>
        <div>
          <dt>Backstop pool</dt>
          <dd>
            Takes at its minimum discount, {AUCTION.backstopMinBps} bps by default: block +{take} at this step.
          </dd>
        </div>
        <div>
          <dt>Cap</dt>
          <dd>
            {AUCTION.maxBps} bps at block +{last}. Untaken (say, an empty pool), the auction expires and closes at mark
            through the old fixed-fee path.
          </dd>
        </div>
      </dl>
    </figure>
  );
}

export function Auction({ live = false, testnetLive = false }: { live?: boolean; testnetLive?: boolean }) {
  const step = auctionStepBps(live, testnetLive);
  const onTestnet = step !== AUCTION.stepBps;
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
          <Chart step={step} onTestnet={onTestnet} />

          <div className={s.side}>
            <figure className={s.split}>
              <figcaption className={s.head}>
                <h3 className={s.title}>At the take: where the equity goes</h3>
                <p className={s.sub}>
                  <b>E</b> = collateral + PnL at mark. Proportions not to scale.
                </p>
              </figcaption>
              <div className={s.splitBar} aria-hidden="true">
                <span className={s.splitTaker}>P</span>
                <span className={s.splitTrader}>E − P</span>
              </div>
              <p className={s.splitLine}>
                The taker gets <b>P = d × notional</b> and the positions at mark; the trader keeps{" "}
                <b>max(0, E − P)</b>. If <b>E &lt; P</b>, lane insurance, then lane bad debt, pays the rest.
              </p>
            </figure>

            <p className={s.mev}>
              <b>MEV-resistant, not MEV-free.</b> The price comes from the block clock, so out-bidding on gas can&rsquo;t
              buy a bigger discount: it only lands a take earlier, at a smaller one. Ordering still matters when two
              takers want the same block, so we don&rsquo;t claim there&rsquo;s no MEV.
            </p>
          </div>
        </div>

        <h3 className={s.stepsHead}>The lifecycle, in four calls</h3>
        <ol className={s.steps} aria-label="Auction lifecycle">
          {steps(step).map((st) => (
            <li key={st.n} className={s.step}>
              <span className={s.stepNum}>{st.n}</span>
              <h4 className={s.stepTitle}>{st.title}</h4>
              <code className={s.stepCode}>{st.code}</code>
              <p className={s.stepBody}>{st.line}</p>
            </li>
          ))}
        </ol>

        <p id="backstop" className={s.pool}>
          <b>Backstop LPs.</b> Each lane has its own pool. LPs deposit AUSD for shares; the pool takes that lane&rsquo;s
          auctions at {AUCTION.backstopMinBps} bps, earns the discount and carries the positions. Returns are shown as
          earned since deploy, never as an APY.
        </p>
        <p className={s.readMore}>
          <a className={b.link} href={README_AT.auction} target="_blank" rel="noreferrer">
            How the auction works
          </a>
          <a className={b.link} href={README_AT.backstop} target="_blank" rel="noreferrer">
            Backstop LPs in the README
          </a>
        </p>
      </div>
    </section>
  );
}
