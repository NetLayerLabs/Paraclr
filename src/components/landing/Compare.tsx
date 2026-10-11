import { Check, Minus } from "./icons";
import { AUCTION, auctionStepBps } from "./content";
import b from "./brand/Brand.module.css";
import s from "./Compare.module.css";

/** Only claims the contracts support. "Typical" = the first-bot-wins, fixed-penalty pattern, not one venue. */
function rows(step: number): { feature: string; typical: string; paraclr: string }[] {
  return [
  {
    feature: "Who takes the account",
    typical: "The first bot to land a transaction",
    paraclr: "The first taker at the current discount, or the lane's backstop pool at its threshold",
  },
  {
    feature: "How the price is set",
    typical: "A fixed fee, set before the crash",
    paraclr: `A discount set by the block clock: 0, then +${step} bps per block${step === AUCTION.stepBps ? "" : ` on testnet (contract default ${AUCTION.stepBps})`}. The trader keeps E − P`,
  },
  {
    feature: "What a higher gas bid buys",
    typical: "Priority for the whole fee",
    paraclr: "Only an earlier take, at a smaller discount",
  },
  {
    feature: "Where a shortfall lands",
    typical: "Usually a venue-wide insurance fund or pool",
    paraclr: "Its own lane: lane insurance first, then lane bad debt",
  },
  {
    feature: "State layout",
    typical: "Shared global state: one set of aggregates",
    paraclr: "8 lanes with lane-local ledgers, pools and open interest",
  },
  {
    feature: "Parallel execution",
    typical: "“Parallel” as a claim",
    paraclr: "A measured Conflict X-ray of each crash (dependencies, not re-executions)",
  },
  {
    feature: "Solvency",
    typical: "Up to each venue",
    paraclr: "solvency(): AUSD held vs. the 8 lane ledgers, read every block",
  },
  ];
}

export function Compare({ live, testnetLive = false }: { live: boolean; testnetLive?: boolean }) {
  return (
    <section className={`${b.light} ${b.surface} ${b.section} ${s.section}`} aria-labelledby="compare-title">
      <div className={b.container}>
        <div className={`${b.sectionHead} ${b.sectionHeadCenter}`}>
          <p className={b.eyebrow}>Side by side</p>
          <h2 id="compare-title" className={`${b.h2} ${b.breakEm}`}>
            Typical perp liquidation <em>vs. Paraclr</em>
          </h2>
          <p className={b.lede}>
            The difference is who sets the price of a takeover, and what the trader gets back after it.
          </p>
        </div>

        <div className={s.wrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">Feature</th>
                <th scope="col">Typical perp liquidation</th>
                <th scope="col" className={s.us}>
                  Paraclr
                </th>
              </tr>
            </thead>
            <tbody>
              {rows(auctionStepBps(live, testnetLive)).map((r) => (
                <tr key={r.feature}>
                  <th scope="row">{r.feature}</th>
                  <td data-label="Typical">
                    <Minus className={s.iconNo} />
                    <span>{r.typical}</span>
                  </td>
                  <td data-label="Paraclr" className={s.us}>
                    <Check className={s.iconYes} />
                    <span>{r.paraclr}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={s.note}>
          &ldquo;Typical&rdquo; is the common first-bot-wins, fixed-penalty pattern, not any one venue. Paraclr&rsquo;s
          column describes the contracts in the repo;{" "}
          {live ? (
            <>
              the mainnet beta runs them{" "}
              <a className={b.link} href="#beta">
                under hard caps
              </a>
              .
            </>
          ) : (
            <>
              the contracts are live on Monad testnet and the mainnet beta is{" "}
              <a className={b.link} href="#beta">
                pending
              </a>
              .
            </>
          )}
        </p>
      </div>
    </section>
  );
}
