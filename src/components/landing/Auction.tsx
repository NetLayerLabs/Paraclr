import type { CSSProperties, ReactNode } from "react";
import { aboutSeconds, AUCTION, auctionStepBps } from "./content";
import b from "./brand/Brand.module.css";
import s from "./Auction.module.css";

type Vars = CSSProperties & Record<`--${string}`, string | number>;

const Y_TICKS = [0, 100, 200, 300, 400, 500];

interface Step {
  n: string;
  title: string;
  code: ReactNode;
  body: ReactNode;
}

function steps(step: number, onTestnet: boolean): Step[] {
  return [
    {
      n: "01",
      title: "Start",
      code: <>startAuctions(lane, accounts)</>,
      body: (
        <>
          Anyone can put an account below the {AUCTION.maintenanceBps / 100}% maintenance margin into auction.
          It&rsquo;s frozen: no withdrawals, no new positions. Deposits still work.
        </>
      ),
    },
    {
      n: "02",
      title: "Tick",
      code: (
        <>
          d = min({AUCTION.maxBps}, {step} × blocks)
        </>
      ),
      body: (
        <>
          The discount <b>d</b> starts at 0 and rises {step} bps per block since the start
          {onTestnet ? <> ({AUCTION.stepBps} is the contract default)</> : null}. Only the block number moves it; a
          higher gas bid doesn&rsquo;t.
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
          can take any block before the pool, if it stays above initial margin, but is paid only out of the
          trader&rsquo;s own equity, <b>min(P, E)</b>, so nobody profits by liquidating their own account.
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
}

const POOL = [
  {
    title: "Deposit per lane",
    body: "Each of the 8 lanes has its own pool. LPs deposit AUSD into a lane's pool for shares in it, and pool storage is lane-local: 8 pools can take in the same block without touching each other's slots.",
  },
  {
    title: "Earn the discount",
    body: `The pool takes that lane's auctions once the discount reaches its threshold (${AUCTION.backstopMinBps} bps by default, below the old 1% fixed fee) and is paid P = d × notional for each.`,
  },
  {
    title: "Absorb the exposure",
    body: "The pool also inherits the positions, at the mark. If the market keeps moving against them, NAV falls. The discount is the payment for carrying that risk.",
  },
] as const;

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

            <p className={s.mev}>
              <b>MEV-resistant, not MEV-free.</b> The price comes from the block clock, so out-bidding on gas can&rsquo;t
              buy a bigger discount: it only lands a take earlier, at a smaller one. Ordering still matters when two
              takers want the same block, so we don&rsquo;t claim there&rsquo;s no MEV.
            </p>
          </div>
        </div>

        <h3 className={s.stepsHead}>The lifecycle, in four calls</h3>
        <ol className={s.steps} aria-label="Auction lifecycle">
          {steps(step, onTestnet).map((st) => (
            <li key={st.n} className={s.step}>
              <span className={s.stepNum}>{st.n}</span>
              <h4 className={b.h3}>
                <span className={b.srOnly}>Step {st.n}: </span>
                {st.title}
              </h4>
              <code className={s.stepCode}>{st.code}</code>
              <p className={s.stepBody}>{st.body}</p>
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
          <ul className={s.poolRows}>
            {POOL.map(({ title, body }) => (
              <li key={title}>
                <h4 className={b.h3}>{title}</h4>
                <p className={b.body}>{body}</p>
              </li>
            ))}
            <li>
              <h4 className={b.h3}>No APY</h4>
              <p className={b.body}>
                Pool returns are shown as <strong>earned since deploy</strong>: discount collected, notional absorbed,
                realized and unrealized PnL. A crash-driven income stream doesn&rsquo;t annualize honestly, so we
                don&rsquo;t. On testnet the operator seeds every pool with test AUSD.
              </p>
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
