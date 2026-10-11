import { MONAD_TESTNET_CHAIN_ID, type XrayDesign, type XrayEvidence } from "./benchResults.server";
import { AuctionReadout } from "./AuctionReadout";
import { MatrixSvg } from "./XrayMatrix";
import { AUCTION, aboutSeconds, MONAD_BLOCK_S } from "./content";
import { fmtInt } from "./format";
import s from "./HeroVisual.module.css";

function XrayCell({ design, good }: { design: XrayDesign | null; good: boolean }) {
  const name = good ? "Paraclr lanes" : "Naive shared state";
  return (
    <div className={s.xrCell}>
      <div className={s.xrMatrix}>
        {design ? (
          <MatrixSvg
            design={design}
            label={`${name}: ${design.summary.edges} dependency edges, ${design.crossLaneEdges} across lanes`}
            classes={{ svg: s.mxSvg, bg: s.mBg, band: s.mBand, sep: s.mSep, diag: s.mDiag, same: s.mSame, cross: s.mCross }}
          />
        ) : null}
      </div>
      <p className={s.xrFig}>
        <b className={design ? (design.crossLaneEdges === 0 ? s.good : s.bad) : undefined}>
          {design ? fmtInt(design.crossLaneEdges) : "–"}
        </b>
        <span>
          {name}
          <br />
          cross-lane edges
        </span>
      </p>
    </div>
  );
}

/**
 * Hero instrument: one flat panel. Top, a schematic auction readout running across the 8 lanes at the step the page
 * quotes (client loop, see AuctionReadout). Bottom, the measured Conflict X-ray from the committed bench/xray JSON.
 */
export function HeroVisual({ xray, step }: { xray: XrayEvidence | null; step: number }) {
  const take = Math.ceil(AUCTION.backstopMinBps / step);
  const monad = xray?.chainId === MONAD_TESTNET_CHAIN_ID;
  return (
    <figure className={s.wrap}>
      <div className={s.panel}>
        <header className={s.head}>
          <span className={s.kicker}>Auction clock</span>
          <span className={s.headNote}>
            +{step} bps per block · pool takes at {AUCTION.backstopMinBps} bps, block +{take}
          </span>
        </header>

        <AuctionReadout step={step} minBps={AUCTION.backstopMinBps} />

        <p className={s.equity}>
          At a take the taker is paid <i>P</i> = <i>d</i> × notional; the trader keeps <i>E</i> − <i>P</i>.
        </p>

        <div className={s.xr}>
          <header className={s.head}>
            <span className={s.kicker}>Conflict X-ray</span>
            <span className={s.headNote}>
              {xray ? (monad ? "measured on Monad testnet" : "measured on local anvil") : "pending"}
              {xray?.lanes ? ` · ${fmtInt(xray.lanes.summary.txs)} txs` : ""}
            </span>
          </header>
          <div className={s.xrGrid}>
            <XrayCell design={xray?.lanes ?? null} good />
            <XrayCell design={xray?.naive ?? null} good={false} />
          </div>
        </div>
      </div>
      <figcaption className={s.caption}>
        The auction readout is a schematic, slowed down (a real block is ~{MONAD_BLOCK_S} s, so
        block +{take} comes {aboutSeconds(take)} in).{" "}
        {xray ? (
          <>
            The X-ray figures are measured: <code>bench/xray/{xray.file}</code>.
          </>
        ) : (
          <>The X-ray fills in from the first committed bench/xray run.</>
        )}
      </figcaption>
    </figure>
  );
}
