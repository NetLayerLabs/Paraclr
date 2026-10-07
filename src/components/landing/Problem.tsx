import { ArrowDown, EyeOff, Flame, Lock } from "./icons";
import { AUCTION } from "./content";
import b from "./brand/Brand.module.css";
import s from "./Problem.module.css";

const ISSUES = [
  {
    icon: Lock,
    tag: "fixed penalty",
    title: "The price is set before the crash",
    body: "The liquidation fee is a constant: the same in a calm market and in a cascade. A taker who would accept less has no way to offer less.",
  },
  {
    icon: Flame,
    tag: "gas bidding",
    title: "Bots compete on gas, not on price",
    body: "Whoever lands first collects the whole fee, so liquidators bid for priority and ordering. None of that competition flows back to the trader.",
  },
  {
    icon: EyeOff,
    tag: "no discovery",
    title: "Nobody learns what the takeover was worth",
    body: "One winner, one fixed price. The trader pays it whether a taker would have stepped in for a fraction of it or not.",
  },
] as const;

const BOTS = [
  { name: "bot A", bid: 92, wins: true },
  { name: "bot B", bid: 74, wins: false },
  { name: "bot C", bid: 58, wins: false },
] as const;

export function Problem() {
  return (
    <section className={`${b.dark} ${b.surface} ${b.section} ${s.section}`} aria-labelledby="problem-title">
      <div className={`${b.container} ${s.grid}`}>
        <div className={s.left}>
          <p className={b.eyebrow}>The problem</p>
          <h2 id="problem-title" className={b.h2}>
            Liquidation is a race. <em>The trader pays for it.</em>
          </h2>
          <p className={b.lede}>
            On a typical on-chain perps venue an underwater account goes to whichever bot lands the liquidation first,
            for a penalty fixed in advance. Bots compete on gas and ordering rather than on price, so the penalty never
            falls when takers would have accepted less, and the trader can pay{" "}
            <strong>more than a competitive price for the takeover</strong>.
          </p>

          <figure className={`${b.card} ${s.race}`}>
            <figcaption className={s.raceHead}>
              <span className={s.raceTitle}>First bot wins</span>
              <span className={b.tagIllustration}>Schematic</span>
            </figcaption>
            <ol
              className={s.bots}
              aria-label="Three bots bid priority fees for the same liquidatable account; the highest bid lands first"
            >
              {BOTS.map((bot) => (
                <li key={bot.name} className={bot.wins ? s.botWin : undefined}>
                  <span className={s.botName}>{bot.name}</span>
                  <span className={s.botTrack}>
                    <span className={s.botBar} style={{ width: `${bot.bid}%` }} />
                  </span>
                  <span className={s.botOut}>{bot.wins ? "lands first" : "too late"}</span>
                </li>
              ))}
            </ol>
            <p className={s.raceFoot}>
              <span>priority fee bid →</span>
              <span>
                winner takes the <b>fixed penalty</b>, in full
              </span>
            </p>
          </figure>

          <a href="#auction" className={s.turn}>
            <span className={s.turnTag}>Paraclr</span>
            <span>
              Replace the race with a clock: the discount starts at 0 and rises {AUCTION.stepBps} bps per block.
            </span>
            <ArrowDown className={s.turnIcon} />
          </a>
        </div>

        <ul className={s.issues}>
          {ISSUES.map(({ icon: Icon, tag, title, body }) => (
            <li key={tag} className={`${b.card} ${b.cardPad} ${s.issue}`}>
              <div className={s.issueHead}>
                <span className={b.iconTile}>
                  <Icon />
                </span>
                <code className={s.issueTag}>{tag}</code>
              </div>
              <h3 className={b.h3}>{title}</h3>
              <p className={b.body}>{body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
