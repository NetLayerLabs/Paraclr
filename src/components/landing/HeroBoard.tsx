import type { CSSProperties } from "react";
import { AUCTION } from "./content";
import styles from "./HeroBoard.module.css";

const LANES = 8;
const CELLS = 14;
const TICKS = AUCTION.backstopMinBps / AUCTION.stepBps; // blocks to the pool's default threshold (3 at 75 bps)

type Vars = CSSProperties & Record<`--${string}`, string | number>;
type Cell = "ok" | "auction" | "cured";

/** Deterministic board (no Math.random: server and client markup must match). */
function cellKind(lane: number, i: number): Cell {
  if (i >= 12) return "ok"; // keep underwater accounts inside the 12 cells shown on phones
  const h = Math.imul(lane * 131 + i * 977 + 11, 2654435761) >>> 0;
  if (h % 100 >= 17) return "ok";
  return (lane === 2 || lane === 5) && i % 2 === 1 ? "cured" : "auction";
}

const BOARD: Cell[][] = Array.from({ length: LANES }, (_, lane) => {
  const row = Array.from({ length: CELLS }, (_, i) => cellKind(lane, i));
  // every lane gets at least one auction that the backstop takes
  if (!row.includes("auction")) row[(lane * 5 + 3) % 12] = "auction";
  return row;
});

/**
 * Purely illustrative: one price shock, then every lane's underwater accounts
 * sit in a Dutch auction while the discount steps up 25 bps per block; at the
 * backstop pool's default threshold (75 bps, block +3) each lane's pool takes
 * its auctions. CSS-only, one animated timeline (--hb-t); reduced motion shows
 * the settled end state.
 */
export function HeroBoard() {
  return (
    <figure
      className={styles.card}
      aria-label="Illustration: after a price shock, underwater accounts in each of 8 lanes go to an auction whose discount rises 25 basis points per block until each lane's backstop pool takes them at 75 basis points"
    >
      <div className={styles.bar}>
        <span className={styles.barTitle}>
          <span className={styles.live} aria-hidden="true" />
          auction board · 8 lanes
        </span>
        <span className={styles.tag}>Illustration</span>
      </div>

      <div className={styles.shock}>
        <span className={styles.shockCall}>
          MockOracle<span className={styles.dim}>.shockPrices(</span>markets, 8000<span className={styles.dim}>)</span>
        </span>
        <span className={styles.shockBadge}>−20%</span>
      </div>

      <div className={styles.clock} aria-hidden="true">
        <span className={styles.clockLabel}>
          <span>block</span>
          <span>discount</span>
        </span>
        <ol className={styles.ticks}>
          {Array.from({ length: TICKS + 1 }, (_, k) => (
            <li key={k} className={k === TICKS ? styles.tickTake : styles.tick} style={{ "--k": k } as Vars}>
              <span className={styles.tickBlock}>+{k}</span>
              <span className={styles.tickBps}>{k * AUCTION.stepBps}</span>
            </li>
          ))}
        </ol>
        <span className={styles.clockUnit}>bps</span>
      </div>

      <div className={styles.lanes} aria-hidden="true">
        {BOARD.map((row, lane) => (
          <div key={lane} className={styles.lane}>
            <span className={styles.laneLabel}>L{lane}</span>
            <span className={styles.track}>
              {row.map((kind, i) => (
                <i
                  key={i}
                  className={kind === "ok" ? styles.cellOk : kind === "cured" ? styles.cellCured : styles.cellAuction}
                  style={{ "--i": i } as Vars}
                />
              ))}
            </span>
            <span className={styles.status}>
              <span className={styles.stIdle}>healthy</span>
              <span className={styles.stAuction}>auction</span>
              <span className={styles.stTaken}>backstop ✓</span>
            </span>
          </div>
        ))}
      </div>

      <div className={styles.tx} aria-hidden="true">
        <span className={styles.txIdle}>8 lanes · every account above maintenance</span>
        <span className={styles.txStart}>
          block +0 · 8 × <code>startAuctions(lane, …)</code>
        </span>
        <span className={styles.txTake}>
          block +{TICKS} · 8 × <code>backstopTakeBatch(lane, …)</code> · traders keep <b>E − P</b>
        </span>
      </div>

      <figcaption className={styles.foot}>
        <span className={styles.legend}>
          <i className={styles.keyOk} /> healthy
        </span>
        <span className={styles.legend}>
          <i className={styles.keyAuction} /> in auction
        </span>
        <span className={styles.legend}>
          <i className={styles.keyCured} /> cured
        </span>
        <span className={styles.legend}>
          <i className={styles.keyTaken} /> taken by lane backstop
        </span>
      </figcaption>
    </figure>
  );
}
