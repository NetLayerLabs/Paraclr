import type { CSSProperties } from "react";
import { MONAD_TESTNET_CHAIN_ID, type XrayDesign, type XrayEvidence } from "./benchResults.server";
import { MatrixSvg } from "./XrayMatrix";
import { Lanes } from "./icons";
import { AUCTION } from "./content";
import { fmtInt } from "./format";
import b from "./brand/Brand.module.css";
import s from "./HeroVisual.module.css";

type Vars = CSSProperties & Record<`--${string}`, string | number>;
type Row = "take3" | "take2" | "cured" | "healthy";

/** Schematic board: which lanes have an auction, and how each one resolves. */
const ROWS: Row[] = ["take3", "healthy", "take2", "take3", "cured", "take3", "healthy", "take3"];
const TICKS = AUCTION.backstopMinBps / AUCTION.stepBps; // 3 blocks to the pool threshold

const STATUS: Record<Row, [string, string]> = {
  take3: ["auction", "backstop ✓"],
  take2: ["auction", `taken · ${2 * AUCTION.stepBps}`],
  cured: ["auction", "cured"],
  healthy: ["healthy", "healthy"],
};

function networkLabel(x: XrayEvidence): string {
  return x.chainId === MONAD_TESTNET_CHAIN_ID ? "Monad testnet" : "local anvil — not Monad";
}

function MiniMatrix({ design, good }: { design: XrayDesign | null; good: boolean }) {
  return (
    <figure className={s.mx}>
      <div className={s.mxFrame}>
        {design ? (
          <MatrixSvg
            design={design}
            label={`${good ? "Paraclr lanes" : "Naive shared state"}: ${design.summary.edges} dependency edges, ${design.crossLaneEdges} across lanes`}
            classes={{
              svg: s.mxSvg,
              bg: s.mBg,
              band: s.mBand,
              sep: s.mSep,
              diag: s.mDiag,
              same: s.mSame,
              cross: s.mCross,
            }}
          />
        ) : (
          <span className={s.mxPending}>pending</span>
        )}
      </div>
      <figcaption className={s.mxCap}>
        <span className={s.mxName}>{good ? "Paraclr lanes" : "Naive shared state"}</span>
        <span className={s.mxStat}>
          <b className={design ? (design.crossLaneEdges === 0 ? s.good : s.bad) : undefined}>
            {design ? fmtInt(design.crossLaneEdges) : "–"}
          </b>
          cross-lane edges
        </span>
      </figcaption>
    </figure>
  );
}

/**
 * Hero visual: a light "auction board" (schematic, animated) behind a dark
 * Conflict X-ray card whose two matrices are drawn from the committed X-ray.
 * Reduced motion shows the board's settled state.
 */
export function HeroVisual({ xray }: { xray: XrayEvidence | null }) {
  const txs = xray?.lanes?.summary.txs ?? xray?.naive?.summary.txs ?? null;
  const blocks = xray?.lanes?.blocks.length ?? null;
  return (
    <figure className={s.wrap}>
      <div className={s.stage}>
        {/* Back: auction board (light) */}
        <div className={s.board} aria-hidden="true">
          <div className={s.boardBar}>
            <span className={b.chrome}>
              <i />
              <i />
              <i />
            </span>
            <span className={s.boardTitle}>Auction board</span>
            <span className={s.boardTag}>8 lanes</span>
          </div>
          <div className={s.clock}>
            <span className={s.clockKey}>block</span>
            <span className={s.ticker}>
              {Array.from({ length: TICKS + 1 }, (_, k) => (
                <i key={k} style={{ "--k": k } as Vars}>
                  +{k}
                </i>
              ))}
            </span>
            <span className={s.clockKey}>discount</span>
            <span className={`${s.ticker} ${s.tickerBps}`}>
              {Array.from({ length: TICKS + 1 }, (_, k) => (
                <i key={k} style={{ "--k": k } as Vars}>
                  {k * AUCTION.stepBps}
                </i>
              ))}
            </span>
            <span className={s.clockUnit}>bps</span>
          </div>
          <ol className={s.rows}>
            {ROWS.map((row, lane) => (
              <li key={lane} className={s[row]}>
                <span className={s.lane}>L{lane}</span>
                <span className={s.track}>
                  <span className={s.fill} />
                </span>
                <span className={s.status}>
                  <i>{STATUS[row][0]}</i>
                  <i>{STATUS[row][1]}</i>
                </span>
              </li>
            ))}
          </ol>
        </div>

        {/* Front: Conflict X-ray (dark), real data */}
        <div className={s.xray}>
          <div className={s.xrBar}>
            <span className={s.xrIcon} aria-hidden="true">
              <Lanes />
            </span>
            <span className={s.xrTitle}>Conflict X-ray</span>
            <span className={s.xrNet}>
              {xray ? (xray.chainId === MONAD_TESTNET_CHAIN_ID ? "testnet" : "anvil") : "pending"}
            </span>
          </div>
          <p className={s.xrSub}>Same crash, two builds of the same contract</p>
          <div className={s.xrGrid}>
            <MiniMatrix design={xray?.lanes ?? null} good />
            <MiniMatrix design={xray?.naive ?? null} good={false} />
          </div>
          <div className={s.xrLegend} aria-hidden="true">
            <span>
              <i className={s.keySame} /> same lane
            </span>
            <span>
              <i className={s.keyCross} /> across lanes
            </span>
            {txs !== null ? (
              <span className={s.xrCount}>
                {fmtInt(txs)} txs{blocks ? ` · ${fmtInt(blocks)} blocks` : ""}
              </span>
            ) : null}
          </div>
        </div>

        <span className={`${s.float} ${s.floatKeep}`} aria-hidden="true">
          <span className={`${b.dot} ${b.dotPos}`} />
          trader keeps <b>E − P</b>
        </span>
        <span className={`${s.float} ${s.floatClock}`} aria-hidden="true">
          +{AUCTION.stepBps} bps / block
        </span>
      </div>
      <figcaption className={s.caption}>
        <span className={b.tagIllustration}>Illustration</span>
        <span>
          Auction board is schematic.{" "}
          {xray ? (
            <>
              X-ray matrices are measured: <code>bench/xray/{xray.file}</code>, {networkLabel(xray)}.
            </>
          ) : (
            <>X-ray matrices fill in from the first committed bench/xray run.</>
          )}
        </span>
      </figcaption>
    </figure>
  );
}
