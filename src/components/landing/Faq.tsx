import type { ReactNode } from "react";
import { Plus } from "./icons";
import ui from "./Landing.module.css";
import styles from "./Closing.module.css";

export function Faq({ monadDeployed }: { monadDeployed: boolean }) {
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
          The payment to the taker, <code className={ui.code}>P = discount × notional</code>, at the discount of the
          block the account is taken in. Everything else, <code className={ui.code}>E − P</code>, comes back as free
          collateral. If equity is below P and the lane&rsquo;s backstop pool is the taker, the lane&rsquo;s insurance
          fund covers the gap and then lane bad debt does (an outside taker is paid only up to the trader&rsquo;s
          equity, so the lane never subsidizes self-liquidation);
          a trader never loses more than their equity. An account that gets healthy again before it&rsquo;s taken
          (top-up or price recovery) can be cured and keeps everything. One nobody takes by the 500 bps cap expires
          through the old fixed-fee path (1% of notional).
        </>
      ),
    },
    {
      q: "Who are the backstop LPs?",
      a: (
        <>
          Anyone who deposits AUSD into a lane&rsquo;s backstop pool. The pool takes that lane&rsquo;s auctions at its
          minimum discount (75 bps by default, below the old 1% fixed fee), earns the discount and inherits the positions, so its NAV moves with the
          market until that exposure is reduced. Returns are shown as earned since deploy, never as an APY. On testnet the
          operator seeds each pool with test AUSD.
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
            <strong>It doesn&rsquo;t show</strong> Monad&rsquo;s internal re-execution count (not observable from outside
            the node) or speed. Each X-ray says how it was collected: a live{" "}
            <code className={ui.code}>debug_traceTransaction</code> trace, or a replay on a local anvil fork.
          </p>
        </>
      ),
    },
    {
      q: "Are the 8 lanes Monad's execution threads?",
      a: (
        <>
          No. A contract can&rsquo;t choose which of Monad&rsquo;s threads runs a transaction. Lanes are a storage
          layout: each account&rsquo;s risk state lives in lane <code className={ui.code}>uint160(account) % 8</code>,
          so the 8 lanes&rsquo; auction transactions have disjoint write sets and give Monad&rsquo;s optimistic executor
          no reason to re-execute one because of another. 8 is a design choice, not a Monad limit.
        </>
      ),
    },
    {
      q: "Is it audited?",
      a: <>No. This is unaudited hackathon code. Don&rsquo;t use it with real funds.</>,
    },
    {
      q: "Is this live on mainnet?",
      a: (
        <>
          No. Paraclr is a hackathon build for testnets only, and nothing is deployed to mainnet.{" "}
          {monadDeployed
            ? "The contracts are deployed on Monad testnet (chain 10143); local anvil is used for development."
            : "Today the contracts run on a local anvil chain; the Monad testnet (chain 10143) deploy is next."}{" "}
          No real funds are involved anywhere. AUSD on testnet is <code className={ui.code}>MockAUSD</code>, a 6-decimal
          stand-in with a capped faucet, not Agora&rsquo;s token.
        </>
      ),
    },
    {
      q: "What's on-chain and what's simulated?",
      a: (
        <>
          <p>
            <strong>On-chain (chain modes):</strong> collateral, positions and margin; auctions, backstop pools and the
            solvency ledgers; every start, take, cure and expiry, sent by the keeper&rsquo;s 8 lane keys or by anyone;
            and the flash crash, which is one oracle transaction.
          </p>
          <p>
            <strong>Simulated or synthetic:</strong> the price feed (a simulated feed the keeper pushes on-chain, not a
            real market), the hundreds of crash-run accounts (synthetic, created by a demo-only{" "}
            <code className={ui.code}>seedAccounts</code>), and the app&rsquo;s Simulated mode, an in-browser model
            labelled as such.
          </p>
        </>
      ),
    },
    {
      q: "What doesn't it do yet?",
      a: (
        <>
          One position per market per account, no funding payments or trading fees, and backstop exposure is reduced by
          an operator/keeper role rather than a market. No scoped session keys. A Chainlink Data Streams adapter is
          written and unit-tested against a mock verifier, but it isn&rsquo;t deployed or used in the demo.
        </>
      ),
    },
  ];

  return (
    <section id="faq" className={`${ui.section} ${ui.sectionAlt}`} aria-labelledby="faq-title">
      <div className={`${ui.container} ${styles.faqWrap}`}>
        <div className={styles.faqHead}>
          <p className={ui.eyebrow}>FAQ</p>
          <h2 id="faq-title" className={ui.h2}>
            The honest <em>answers.</em>
          </h2>
          <p className={ui.lede}>
            Every claim on this page is meant to match the repo. If something here is wrong, the code and the committed
            bench and X-ray JSON win.
          </p>
        </div>
        <div className={styles.faqList}>
          {items.map((it) => (
            <details key={it.q} className={styles.faqItem}>
              <summary className={styles.faqQ}>
                {it.q}
                <span className={styles.faqIcon} aria-hidden="true">
                  <Plus className={styles.faqPlus} />
                </span>
              </summary>
              <div className={styles.faqA}>{it.a}</div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
