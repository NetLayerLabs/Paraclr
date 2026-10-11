"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import s from "./HeroVisual.module.css";

type Vars = CSSProperties & Record<`--${string}`, string | number>;
type Kind = "pool" | "taker" | "cure" | "calm";
type State =
  | { t: "healthy" }
  | { t: "auction"; d: number }
  | { t: "pool"; d: number }
  | { t: "taker"; d: number }
  | { t: "cured" };

/** One block of the schematic, slowed down so it can be read (Monad's real blocks are ~0.35 s). */
const TICK_MS = 650;
/** Healthy blocks before a lane's next auction, and blocks a resolution stays on screen. */
const CALM = 6;
const HOLD = 4;
/** How each lane's auctions end; lanes 1 and 6 stay healthy. */
const KINDS: Kind[] = ["pool", "calm", "taker", "pool", "cure", "pool", "calm", "taker"];
/** Static frame for reduced motion and the server render: several lanes mid-auction, one taken, one cured. */
const FRAME = 11;

function laneState(block: number, lane: number, step: number, minBps: number): State {
  const kind = KINDS[lane];
  if (kind === "calm") return { t: "healthy" };
  const take = Math.ceil(minBps / step); // blocks to the pool threshold
  const end = kind === "pool" ? take : kind === "taker" ? Math.max(1, Math.round(take * 0.6)) : Math.max(1, Math.round(take * 0.4));
  // Each lane on its own period, so the 8 lanes drift in and out of phase like real traffic.
  const period = CALM + end + HOLD + lane;
  const offset = Math.round(((lane * 5) % 8) * (period / 8));
  const a = ((block + offset) % period) - CALM;
  if (a < 0) return { t: "healthy" };
  if (a < end - 1) return { t: "auction", d: (a + 1) * step };
  if (a < end - 1 + HOLD) {
    const d = end * step;
    return kind === "pool" ? { t: "pool", d } : kind === "taker" ? { t: "taker", d } : { t: "cured" };
  }
  return { t: "healthy" };
}

function label(st: State): string {
  switch (st.t) {
    case "healthy":
      return "healthy";
    case "auction":
      return `auction ${st.d}`;
    case "pool":
      return `pool took ${st.d}`;
    case "taker":
      return `taker took ${st.d}`;
    case "cured":
      return "cured";
  }
}

/**
 * The live part of the hero instrument: a block counter and 8 lane rules, each lane running its own Dutch auction
 * at `step` bps per block. One interval drives it; it stops while the panel is off screen or the tab is hidden, and
 * doesn't start at all under prefers-reduced-motion (the static frame is complete on its own).
 */
export function AuctionReadout({ step, minBps }: { step: number; minBps: number }) {
  const [block, setBlock] = useState(FRAME);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let visible = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const sync = () => {
      const run = visible && document.visibilityState === "visible";
      if (run && timer === null) timer = setInterval(() => setBlock((b) => b + 1), TICK_MS);
      if (!run && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      sync();
    });
    if (ref.current) io.observe(ref.current);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", sync);
      if (timer !== null) clearInterval(timer);
    };
  }, []);

  const states = KINDS.map((_, lane) => laneState(block, lane, step, minBps));
  const inAuction = states.filter((x) => x.t === "auction").length;
  const top = Math.max(0, ...states.map((x) => (x.t === "auction" ? x.d : 0)));

  return (
    <div ref={ref} className={s.live} style={{ "--tick": `${TICK_MS}ms` } as Vars}>
      <dl className={s.readout}>
        <div>
          <dt>Block</dt>
          <dd>+{block}</dd>
        </div>
        <div>
          <dt>In auction</dt>
          <dd>
            {inAuction}
            <span> / 8 lanes</span>
          </dd>
        </div>
        <div>
          <dt>Top discount</dt>
          <dd>
            {top}
            <span> bps</span>
          </dd>
        </div>
      </dl>

      <ol className={s.lanes}>
        {states.map((st, lane) => {
          const fill =
            st.t === "auction" || st.t === "pool" || st.t === "taker" ? Math.min(1, st.d / minBps) : 0;
          return (
            <li key={lane} className={s[st.t]} style={{ "--k": lane } as Vars}>
              <span className={s.laneName}>L{lane}</span>
              <span className={s.track}>
                <span className={s.fill} style={{ transform: `scaleX(${fill})` }} />
              </span>
              <span className={s.state}>{label(st)}</span>
            </li>
          );
        })}
      </ol>
      <p className={s.scale}>
        <span>discount 0</span>
        <span>pool minimum {minBps} bps</span>
      </p>
    </div>
  );
}
