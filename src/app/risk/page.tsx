import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { AUCTION } from "@/components/landing/content";
import { fmtDuration, fmtNum } from "@/components/landing/format";
import { Callout, LegalShell, Placeholder, type LegalSection } from "@/components/landing/LegalShell";
import { AUDIT_STATUS, RISK_ANCHORS as A, TERMS_PATH } from "@/components/landing/disclosures";
import { loadProductionStatus, MONADSCAN, PRODUCTION_FILE } from "@/components/landing/production.server";

// Light page, so the browser chrome matches it (the app keeps its dark theme colour).
export const viewport: Viewport = { themeColor: "#ffffff" };

export const metadata: Metadata = {
  title: "Risk disclosure (draft)",
  description:
    "Plain-language risks of the Paraclr mainnet beta: smart-contract, oracle, liquidation, funding, caps, keeper " +
    "liveness, stablecoin and regulatory risk. Draft, pending legal review.",
};

const UPDATED = "Oct 7, 2026";

/** " (currently 24 h)" when the deployment file has it, else " (set at launch)". */
function cur(text: string | null): string {
  return text ? ` (currently ${text})` : " (set at launch)";
}

// Prerendered at build time; reads deployments/143.json for the live values.
export default async function RiskPage() {
  const status = await loadProductionStatus();
  const p = status.params;
  const ausd = (n: number | null) => (n === null ? null : `${fmtNum(n)} AUSD`);
  const caps = [
    p.maxLeverage !== null ? `${fmtNum(p.maxLeverage)}x max leverage` : null,
    p.depositCapPerAccount !== null ? `${ausd(p.depositCapPerAccount)} per account` : null,
    p.tvlCapPerLane !== null ? `${ausd(p.tvlCapPerLane)} per lane` : null,
    p.oiCapPerLaneMarket !== null ? `${ausd(p.oiCapPerLaneMarket)} open interest per lane and market` : null,
    p.minPositionSize !== null ? `${ausd(p.minPositionSize)} minimum position` : null,
  ].filter((x): x is string => x !== null);

  const sections: LegalSection[] = [
    {
      id: A.smartContract,
      title: "Smart-contract risk",
      body: (
        <>
          <p>
            Paraclr&rsquo;s production contracts are new code. <strong>{AUDIT_STATUS}.</strong> No independent firm has
            audited them. Before a mainnet launch they must pass a launch gate: the full Foundry test suite including
            fuzz and invariant tests, Slither with every high and medium finding fixed or justified in writing, an
            adversarial internal review with every critical finding fixed, and a rehearsal on a fork of Monad mainnet.
            Those checks reduce risk. They don&rsquo;t remove it: tests only catch the problems someone thought to test
            for.
          </p>
          <p>
            A bug in the clearinghouse, the oracle checks, the auctions, the backstop pools, the fee and funding
            accounting or the admin wiring could let someone take funds, lock funds, misprice positions, or liquidate
            accounts that should be healthy. Losses could be total, and could hit accounts that did nothing wrong.
          </p>
          <p>
            The contracts depend on contracts we don&rsquo;t control, AUSD and Pyth. A change or fault in those can
            affect Paraclr. The on-chain <code>solvency()</code> check compares the AUSD the contract holds with what
            its ledgers say it owes. It checks the books; it can&rsquo;t catch a bug that records the wrong amounts.
          </p>
        </>
      ),
    },
    {
      id: A.oracle,
      title: "Oracle risk",
      body: (
        <>
          <p>
            Prices come from Pyth, a third-party oracle network. Each price update is signed off chain by Pyth and
            verified on chain through Pyth&rsquo;s contract on Monad. Paraclr rejects a price that is too old
            {cur(p.maxPriceAgeSeconds !== null ? fmtDuration(p.maxPriceAgeSeconds) : null)}, not positive, or whose
            confidence interval is too wide a share of the price
            {cur(p.maxConfBps !== null ? `${fmtNum(p.maxConfBps)} bps` : null)}. While prices are rejected, orders,
            withdrawals and liquidations that need a price wait.
          </p>
          <p>
            A price can pass every check and still be wrong or late: during an outage at the venues Pyth&rsquo;s
            publishers watch, in a thin or manipulated market, or after a publisher fault. Your position is valued and
            liquidated at the oracle price, not at a price you might have got elsewhere. Keepers and the app fetch price
            updates from Pyth&rsquo;s price service; if it is unavailable, executions and liquidations can stall.
          </p>
        </>
      ),
    },
    {
      id: A.execution,
      title: "Order execution risk",
      body: (
        <>
          <p>
            Orders don&rsquo;t fill when you submit them. You commit an order with a size, margin and the worst price
            you&rsquo;ll accept, and it fills at the first Pyth price published at least the minimum delay after your
            commit{cur(p.minExecDelaySeconds !== null ? fmtDuration(p.minExecDelaySeconds) : null)}. You can&rsquo;t
            see that price when you submit.
          </p>
          <ul>
            <li>
              If the fill price is worse than your worst price, the order doesn&rsquo;t fill. Once the execution window
              has passed{cur(p.maxExecDelaySeconds !== null ? fmtDuration(p.maxExecDelaySeconds) : null)} it can be
              cancelled and the escrowed margin returns to you.
            </li>
            <li>
              Prices can move a lot between commit and fill. The delay exists to stop oracle front-running; it
              doesn&rsquo;t protect you from the market.
            </li>
            <li>
              Each order costs an execution fee in MON
              {cur(p.executionFee !== null ? `${fmtNum(p.executionFee)} MON` : null)} and a trading fee in AUSD
              {cur(p.tradingFeeBps !== null ? `${fmtNum(p.tradingFeeBps)} bps of notional` : null)}, plus gas, whether
              or not the trade works out.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: A.liquidation,
      title: "Liquidation risk",
      body: (
        <>
          <p>
            Positions are leveraged, up to a maximum set in the contract
            {cur(p.maxLeverage !== null ? `${fmtNum(p.maxLeverage)}x` : null)}. Leverage
            makes losses bigger and faster. If your equity (collateral plus unrealised PnL, after fees and funding)
            falls below the maintenance margin
            {cur(p.maintenanceMarginBps !== null ? `${fmtNum(p.maintenanceMarginBps / 100)}% of notional` : null)},
            anyone can put your account into a liquidation auction.
          </p>
          <ul>
            <li>
              During the auction your account is frozen: you can&rsquo;t withdraw, open or close positions. You can add
              collateral (deposit caps and a pause permitting); if your account becomes healthy again, the auction can be
              cancelled.
            </li>
            <li>
              A taker inherits your positions at the oracle price and is paid a discount that grows every block, up to a
              cap ({AUCTION.maxBps} bps of notional in the current defaults). You keep whatever equity is left, which
              can be nothing. If nobody takes the auction, it closes through a fixed-fee path (1% of notional).
            </li>
            <li>
              Fast markets, price gaps, oracle delays or stalled keepers can mean your account is handled late and at a
              worse price. <strong>You can lose your whole deposit.</strong> A shortfall beyond your collateral is
              absorbed by your lane&rsquo;s insurance fund and then recorded as lane bad debt; it isn&rsquo;t charged
              to you.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: A.funding,
      title: "Funding risk",
      body: (
        <>
          <p>
            Each market has a funding rate set by the imbalance between long and short open interest across all 8
            lanes. The bigger side pays the smaller side. Funding accrues over time and is settled from your collateral
            when your position is touched.
          </p>
          <p>
            Funding can be large when a market is one-sided and can change quickly. It can push your account below
            maintenance margin and into liquidation even if the price doesn&rsquo;t move. Funding updates are sent by an
            operator key at most once per interval
            {cur(p.fundingIntervalSeconds !== null ? fmtDuration(p.fundingIntervalSeconds) : null)}; late or missed
            updates change when and how much funding is charged.
          </p>
        </>
      ),
    },
    {
      id: A.caps,
      title: "Caps, pause and parameter changes",
      body: (
        <>
          <p>
            The beta is capped on purpose: max leverage, a deposit cap per account, a TVL cap per lane, an
            open-interest cap per lane and market, and a minimum position size.{" "}
            {caps.length ? `Current values: ${caps.join(", ")}.` : "The values are set at launch and shown in the app."}{" "}
            A cap can stop you from depositing more or growing a position.{" "}
            <strong>A deposit cap can also stop you from adding collateral to rescue a position near liquidation.</strong>
          </p>
          <p>
            A guardian key can pause the protocol. A pause blocks deposits and new or larger positions; withdrawals,
            reducing and closing positions, and liquidations are designed to keep working while paused. Because a
            deposit is blocked, you can&rsquo;t top up collateral during a pause.
          </p>
          <p>
            Caps, fees, leverage, margins, auction and funding settings, the oracle configuration and roles can be
            changed by the owner, a multisig acting through a timelock. Each change is scheduled on chain and waits out
            the timelock delay{cur(p.timelockDelaySeconds !== null ? fmtDuration(p.timelockDelaySeconds) : null)}{" "}
            before it applies. A change can make your position worse, for example a higher maintenance margin. If you
            disagree with a scheduled change, the delay is your time to leave.
          </p>
        </>
      ),
    },
    {
      id: A.keeper,
      title: "Keeper liveness",
      body: (
        <>
          <p>
            Keepers run by the operator execute orders, run liquidation auctions and update funding. They are software
            on servers: they can crash, run out of gas money, fall behind or be attacked.
          </p>
          <ul>
            <li>If they stop, committed orders wait and then expire, and you have to cancel them to get margin back.</li>
            <li>
              Liquidations run late, and late liquidations lose more. Losses beyond the lane&rsquo;s insurance fund
              are recorded as lane bad debt, which can mean not every account in that lane can be paid in full.
            </li>
            <li>Funding isn&rsquo;t updated on time.</li>
          </ul>
          <p>
            Anyone can execute orders and start auctions by supplying a Pyth price update, so Paraclr doesn&rsquo;t
            depend on our keepers alone. But nobody is obliged to step in.
          </p>
        </>
      ),
    },
    {
      id: A.backstop,
      title: "Backstop LP risk",
      body: (
        <>
          <p>
            If you deposit into a lane&rsquo;s backstop pool, the pool takes that lane&rsquo;s liquidation auctions and
            inherits the positions. Its value moves with the market until an operator role reduces that exposure. You
            can lose some or all of your deposit, most likely during exactly the crashes the pool exists for.
          </p>
          <p>
            Withdrawals can be blocked while the pool doesn&rsquo;t have enough margin for its exposure. Returns are
            shown as earned since deploy. They don&rsquo;t predict future returns, and no yield is promised.
          </p>
        </>
      ),
    },
    {
      id: A.stablecoin,
      title: "Stablecoin risk (AUSD)",
      body: (
        <>
          <p>
            Collateral, PnL, fees and backstop deposits are all in AUSD, a stablecoin issued by Agora. Paraclr
            doesn&rsquo;t issue, back or redeem AUSD, and has no control over it.
          </p>
          <ul>
            <li>AUSD can lose its peg to the US dollar, briefly or for good. Your balance loses value with it.</li>
            <li>
              Markets are priced from USD price feeds and settled in AUSD. A depeg breaks the assumption that the two
              are equal, which can distort PnL and liquidations.
            </li>
            <li>
              Like many fiat-backed stablecoins, AUSD may carry issuer controls such as freezing addresses; check
              Agora&rsquo;s documentation. If the clearinghouse&rsquo;s own address were affected, all collateral in it
              could be stuck.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: A.admin,
      title: "Admin and key risk",
      body: (
        <>
          <p>
            The owner is a multisig behind a timelock. If enough of its signers are compromised or act in bad faith,
            they can schedule harmful changes. The timelock delay gives users time to notice and exit, but only if
            someone is watching and you can get out in time.
          </p>
          <p>
            The guardian, ops and keeper keys are hot keys on servers. A stolen guardian key can pause deposits and new
            positions; a stolen keeper or ops key can execute orders and send funding updates. By design none of them
            can change parameters, and the deployer gives up its powers after deployment. Read the contracts to check;
            the code, not this page, decides what each key can do.
          </p>
        </>
      ),
    },
    {
      id: A.chain,
      title: "Chain, wallet and interface risk",
      body: (
        <>
          <ul>
            <li>
              Monad mainnet is a young network. Outages, congestion, reorganisations, RPC failures and gas spikes can
              delay or block your transactions, including the one that would have saved a position. You need MON for
              gas and execution fees.
            </li>
            <li>
              If you lose access to your passkey, embedded wallet or keys, nobody can recover your funds. Phishing sites
              and fake tokens exist. Check the URL, and check contract addresses against{" "}
              {status.live ? (
                <>
                  the list on our landing page (from <code>{PRODUCTION_FILE}</code>) and{" "}
                  <a href={MONADSCAN} target="_blank" rel="noreferrer">
                    Monadscan
                  </a>
                </>
              ) : (
                <>the list our landing page will show once the mainnet beta is live</>
              )}
              .
            </li>
            <li>
              The website and app are a convenience. They can be down, show stale numbers, or be blocked where you are.
              The contracts can be used directly.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: A.demo,
      title: "Demo results aren't a forecast",
      body: (
        <p>
          The benchmark runs, Conflict X-ray and auction results on our landing page come from a demo stack: local
          anvil or Monad testnet, a test token, a simulated price feed, synthetic accounts and keeper-run demo takers.
          They show how the mechanism behaved in those runs. They don&rsquo;t predict what happens on mainnet with real
          traders, real prices and real liquidity.
        </p>
      ),
    },
    {
      id: A.regulatory,
      title: "Regulatory and jurisdiction notice",
      body: (
        <>
          <p>
            Leveraged derivatives are regulated, restricted or banned in many countries. Paraclr is not licensed or
            registered as an exchange, broker or any other regulated business anywhere{" "}
            <Placeholder>LEGAL REVIEW: confirm</Placeholder>.
          </p>
          <ul>
            <li>
              Don&rsquo;t use Paraclr if you are a resident of, located in, or organised in{" "}
              <Placeholder>RESTRICTED JURISDICTIONS: legal review to complete</Placeholder>, if you are on a sanctions
              list, or if you act for someone who is. The interface may block some locations; getting around that, for
              example with a VPN, breaks the <Link href={TERMS_PATH}>terms</Link>.
            </li>
            <li>You are responsible for knowing whether using Paraclr is legal for you, and for your taxes.</li>
            <li>Laws change. A change could force the interface to stop serving some users or the beta to wind down.</li>
          </ul>
        </>
      ),
    },
    {
      id: A.recovery,
      title: "No guarantee of recovery",
      body: (
        <>
          <p>
            Blockchain transactions can&rsquo;t be reversed. If you send funds to the wrong address, sign a malicious
            transaction, or lose funds to a bug or an exploit, they may be gone for good.
          </p>
          <p>
            There is no deposit insurance, no government protection scheme, and no promise from NetLayer Labs or
            anyone else to make up losses. The lane insurance funds are a protocol
            mechanism for liquidation shortfalls, not insurance for users. After an incident we may try to help, for
            example by pausing, but we can&rsquo;t promise to recover anything.
          </p>
          <Callout>Use only what you can afford to lose.</Callout>
        </>
      ),
    },
  ];

  return (
    <LegalShell
      kicker="Risk disclosure"
      title="What can go wrong, in plain language."
      updated={UPDATED}
      live={status.live}
      current="risk"
      intro={
        <>
          <p>
            Paraclr is a perpetual futures clearinghouse on Monad.{" "}
            {status.live ? (
              <>
                Its mainnet beta uses <strong>real AUSD</strong>: it is unaudited and capped.
              </>
            ) : (
              <>
                Its mainnet beta, when and if it launches, uses <strong>real AUSD</strong>, unaudited and capped. Until
                then only the demo runs, on Monad testnet or a local chain, with a test token that has no value.
              </>
            )}{" "}
            Read this page before you deposit. It isn&rsquo;t a complete list; new kinds of failure happen.
          </p>
        </>
      }
      summary={
        <>
          <h2>The short version</h2>
          <ul>
            <li>
              <strong>You can lose all the AUSD you deposit</strong>, and quickly. Leverage makes losses bigger.
            </li>
            <li>
              <strong>The contracts are not audited</strong>: internal review and Slither only. A bug could lose
              everyone&rsquo;s funds.
            </li>
            <li>
              <strong>Nobody guarantees to make you whole</strong>: not us, not Agora, not Pyth, not Monad. There is no
              deposit insurance.
            </li>
            <li>
              <strong>The beta is capped on purpose.</strong> Treat it as an experiment and use only what you can afford
              to lose.
            </li>
          </ul>
        </>
      }
      sections={sections}
    />
  );
}
