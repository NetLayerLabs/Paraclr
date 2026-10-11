import Link from "next/link";
import type { ReactNode } from "react";
import type { ProductionStatus } from "./production.server";
import { PRODUCTION_FILE } from "./production.server";
import { Chevron } from "./icons";
import { fmtDuration } from "./format";
import { RISK_ANCHORS, RISK_PATH } from "./disclosures";
import { README_AT } from "./content";
import b from "./brand/Brand.module.css";
import s from "./Faq.module.css";

export function Faq({
  monadDeployed,
  production,
  testnetProd = null,
}: {
  monadDeployed: boolean;
  production: ProductionStatus;
  /** deployments/10143.json with "production": true. */
  testnetProd?: ProductionStatus | null;
}) {
  const live = production.live;
  const testnetLive = testnetProd?.live ?? false;
  const maxDelay = production.params.maxExecDelaySeconds;

  const items: { q: string; a: ReactNode }[] = [
    {
      q: "Is it MEV-free?",
      a: (
        <>
          No, and we don&rsquo;t claim it. Pricing is MEV-resistant: the discount is set by the block clock, not by gas
          bidding, so paying more gas can&rsquo;t buy a bigger discount, only an earlier take at a smaller one. Ordering
          still matters when two takers want the same account in the same block, and the backstop pool is a known taker
          at a known threshold that others can try to step in front of. That competition pushes takes earlier, which is
          the direction that helps the trader.
        </>
      ),
    },
    {
      q: "What does a trader actually lose?",
      a: (
        <>
          The payment to the taker, <code className={b.code}>P = discount × notional</code>, at the discount of the
          block the account is taken in. Everything else, <code className={b.code}>E − P</code>, comes back as free
          collateral. If equity is below P and the lane&rsquo;s backstop pool is the taker, the lane&rsquo;s insurance
          fund covers the gap and then lane bad debt does (an outside taker is paid only up to the trader&rsquo;s
          equity, so the lane never subsidizes self-liquidation); a trader never loses more than their equity. An
          account that gets healthy again before it&rsquo;s taken (top-up or price recovery) can be cured and keeps
          everything. One nobody takes by the 500 bps cap expires through the old fixed-fee path (1% of notional).
        </>
      ),
    },
    {
      q: "Who are the backstop LPs?",
      a: (
        <>
          Anyone who deposits AUSD into a lane&rsquo;s backstop pool. The pool takes that lane&rsquo;s auctions at its
          minimum discount (75 bps by default, below the old 1% fixed fee), earns the discount and inherits the
          positions, so its NAV moves with the market until that exposure is reduced. Returns are shown as earned since
          deploy, never as an APY. On testnet the operator seeds each pool with test AUSD.
        </>
      ),
    },
    {
      q: "What does the Conflict X-ray prove, and what doesn't it?",
      a: (
        <>
          <p>
            <strong>It shows</strong> which transactions in one measured crash read or wrote a storage slot that an
            earlier one wrote, for Paraclr and for a naive build of the same code with every per-lane aggregate on one
            key. That read-after-write dependency is the condition under which Monad&rsquo;s optimistic execution
            re-executes a transaction in the same block.
          </p>
          <p>
            <strong>It doesn&rsquo;t show</strong> Monad&rsquo;s internal re-execution count (not observable from
            outside the node) or speed. Each X-ray says how it was collected: a live{" "}
            <code className={b.code}>debug_traceTransaction</code> trace, or a replay on a local anvil fork.
          </p>
        </>
      ),
    },
    {
      q: "Are the 8 lanes Monad's execution threads?",
      a: (
        <>
          No. A contract can&rsquo;t choose which of Monad&rsquo;s threads runs a transaction. Lanes are a storage
          layout: each account&rsquo;s risk state lives in lane <code className={b.code}>uint160(account) % 8</code>, so
          the 8 lanes&rsquo; auction transactions have disjoint write sets and give Monad&rsquo;s optimistic executor no
          reason to re-execute one because of another. 8 is a design choice, not a Monad limit.
        </>
      ),
    },
    {
      q: "Is it audited?",
      a: (
        <>
          No. Not audited: internal review and Slither only. The mainnet beta {live ? "runs" : "would run"} unaudited
          code under hard caps, so use only what you can afford to lose. The{" "}
          <Link className={b.link} href={`${RISK_PATH}#${RISK_ANCHORS.smartContract}`}>
            risk page
          </Link>{" "}
          spells out what that means.
        </>
      ),
    },
    {
      q: "Is this live on mainnet?",
      a: live ? (
        <>
          <p>
            Yes, as a capped, unaudited beta on Monad mainnet (chain 143), with real Agora AUSD as collateral and Pyth
            prices. The contract addresses are in the{" "}
            <a className={b.link} href={README_AT.mainnetContracts} target="_blank" rel="noreferrer">
              README
            </a>
            , read from <code className={b.code}>{PRODUCTION_FILE}</code>; check them on Monadscan before you
            approve anything.
          </p>
          <p>
            The measured runs and the X-ray on this page are from the demo stack (Monad testnet or local anvil, each
            labelled), not from mainnet.
          </p>
        </>
      ) : (
        <>
          <p>
            Not yet. A capped beta with real AUSD launches on Monad mainnet only if every check in the{" "}
            <a className={b.link} href={README_AT.launchGate} target="_blank" rel="noreferrer">
              launch gate
            </a>{" "}
            passes. Until <code className={b.code}>{PRODUCTION_FILE}</code> is committed, Paraclr has no contracts on
            mainnet: anything there that claims to be Paraclr isn&rsquo;t ours.
          </p>
          {testnetLive ? (
            <p>
              The production contracts are live on{" "}
              <a className={b.link} href="#testnet">
                Monad testnet
              </a>{" "}
              (chain 10143) with Agora&rsquo;s testnet AUSD and Pyth prices: test funds, no real value. The measured
              runs on this page come from the demo stack (on Monad testnet, labelled), whose AUSD is{" "}
              <code className={b.code}>MockAUSD</code>, a 6-decimal stand-in, not Agora&rsquo;s token.
            </p>
          ) : (
            <p>
              {monadDeployed
                ? "The demo contracts are deployed on Monad testnet (chain 10143); local anvil is used for development."
                : "Today the demo contracts run on a local anvil chain; the Monad testnet (chain 10143) deploy is next."}{" "}
              No real value is involved in the demo. Its AUSD is <code className={b.code}>MockAUSD</code>, a 6-decimal
              stand-in with a capped faucet, not Agora&rsquo;s token.
            </p>
          )}
        </>
      ),
    },
    {
      q: "What happens if the keepers stop?",
      a: (
        <>
          Keepers execute delayed orders, update funding and run auctions, but they aren&rsquo;t gatekeepers: anyone can
          execute a pending order or start an auction by supplying a Pyth price update. If nobody does, a committed
          order can be cancelled once its window
          {maxDelay !== null ? ` (${fmtDuration(maxDelay)})` : ""} has passed and its margin returns, and liquidations
          run late, which can leave a lane with more bad debt.{" "}
          <Link className={b.link} href={`${RISK_PATH}#${RISK_ANCHORS.keeper}`}>
            Keeper liveness risk
          </Link>
          .
        </>
      ),
    },
    {
      q: "What's real, and what's simulated?",
      a: (
        <>
          <p>
            <strong>The app on Monad testnet:</strong> the production contracts with real Pyth prices verified on
            chain and Agora&rsquo;s testnet AUSD. Orders, positions, funding, auctions, backstop pools and the solvency
            ledgers are all on chain. There is no crash button: prices follow the market, so auctions run when the
            market moves. Test funds, no real value.
          </p>
          <p>
            <strong>The measured crash runs (demo stack, Monad testnet and local anvil):</strong> the demo stack, where the price feed is simulated
            (the keeper pushes it on chain and the flash crash is one oracle transaction), the hundreds of crash-run
            accounts are synthetic (created by a demo-only{" "}
            <code className={b.code}>seedAccounts</code>), and the collateral is MockAUSD. The app&rsquo;s Simulated
            mode is an in-browser model, labelled as such.
          </p>
        </>
      ),
    },
    {
      q: "What doesn't it do yet?",
      a: (
        <>
          <p>
            <strong>Both stacks:</strong> one position per market per account, backstop exposure is reduced by an
            operator/keeper role rather than a market, and there are no scoped session keys.
          </p>
          <p>
            <strong>Demo stack only:</strong> no funding payments or trading fees, a simulated price feed, and orders
            that fill immediately. The production set adds Pyth, delayed orders, fees, funding and caps, and an order
            can&rsquo;t flip a position from long to short in one step.
          </p>
        </>
      ),
    },
  ];

  return (
    <section id="faq" className={`${b.dark} ${b.surface} ${b.section} ${s.section}`} aria-labelledby="faq-title">
      <div className={`${b.container} ${s.wrap}`}>
        <div className={`${b.sectionHead} ${b.sectionHeadCenter} ${s.head}`}>
          <p className={b.eyebrow}>FAQ</p>
          <h2 id="faq-title" className={b.h2}>
            The honest <em>answers.</em>
          </h2>
          <p className={b.lede}>
            Every claim on this page is meant to match the repo. If something here is wrong, the code, the committed
            bench and X-ray JSON and <code className={b.code}>{PRODUCTION_FILE}</code> win.
          </p>
        </div>
        <div className={s.list}>
          {items.map((it, i) => (
            // One shared name: the browser keeps one answer open at a time (exclusive accordion, no JS).
            <details key={it.q} name="faq" className={s.item}>
              <summary className={s.q}>
                <span className={s.n} aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className={s.qText}>{it.q}</span>
                <Chevron className={s.chev} />
              </summary>
              <div className={s.a}>{it.a}</div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
