import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { GITHUB_URL } from "@/components/landing/content";
import { fmtDuration } from "@/components/landing/format";
import { Callout, LegalShell, Placeholder, type LegalSection } from "@/components/landing/LegalShell";
import { AUDIT_STATUS, RISK_PATH } from "@/components/landing/disclosures";
import { loadProductionStatus } from "@/components/landing/production.server";

// Light page, so the browser chrome matches it (the app keeps its dark theme colour).
export const viewport: Viewport = { themeColor: "#ffffff" };

export const metadata: Metadata = {
  title: "Terms of use (draft)",
  description:
    "Draft terms of use for the Paraclr interface and its capped, unaudited mainnet beta. Not legal advice; pending legal review.",
};

const UPDATED = "Oct 7, 2026";

// Prerendered at build time; reads deployments/143.json for the beta status.
export default async function TermsPage() {
  const status = await loadProductionStatus();
  const delay = status.params.timelockDelaySeconds;

  const sections: LegalSection[] = [
    {
      id: "about",
      title: "About these terms",
      body: (
        <>
          <p>
            These terms are an agreement between you and NetLayer Labs, the builder and operator of Paraclr, a{" "}
            <Placeholder>ENTITY TYPE</Placeholder> organised in <Placeholder>JURISDICTION</Placeholder> (&ldquo;we&rdquo;,
            &ldquo;us&rdquo;). They cover the Paraclr website and app at <Placeholder>DOMAIN</Placeholder> (the
            &ldquo;interface&rdquo;) and the keeper services we run.
          </p>
          <p>
            &ldquo;Paraclr&rdquo; also names a set of open-source smart contracts on the Monad blockchain. Once deployed,
            those contracts run on their own: anyone can call them without the interface, and we can&rsquo;t stop or
            reverse a transaction. By using the interface you agree to these terms. If you don&rsquo;t agree, don&rsquo;t
            use it.
          </p>
        </>
      ),
    },
    {
      id: "eligibility",
      title: "Who can use Paraclr",
      body: (
        <>
          <p>You may use the interface only if all of the following are true:</p>
          <ul>
            <li>
              You are at least 18 and old enough to enter a binding contract where you live{" "}
              <Placeholder>LEGAL REVIEW: age</Placeholder>.
            </li>
            <li>
              You are not a resident of, located in, or organised in <Placeholder>RESTRICTED JURISDICTIONS</Placeholder>
              .
            </li>
            <li>
              You are not on a sanctions list, owned or controlled by someone who is, or acting for someone who is.
            </li>
            <li>Using Paraclr is legal for you where you are.</li>
          </ul>
          <p>
            We may block access from some locations or addresses. Getting around a block, for example with a VPN,
            breaks these terms.
          </p>
        </>
      ),
    },
    {
      id: "beta",
      title: "A capped, unaudited beta",
      body: (
        <>
          <p>
            {status.live
              ? "The Paraclr mainnet beta is live on Monad mainnet with real AUSD."
              : "A Paraclr mainnet beta with real AUSD launches only if its launch gate passes; until then only the demo runs, on Monad testnet or a local chain, and its test tokens have no value."}{" "}
            The beta is experimental. <strong>{AUDIT_STATUS}.</strong> Deposits, positions and open interest are capped,
            and the guardian can pause deposits and new positions. Features, caps and fees can change through the
            timelock{delay !== null ? ` (currently ${fmtDuration(delay)})` : ""}, and the beta can be wound down. We
            don&rsquo;t promise that the interface or the keepers will be available at any time.
          </p>
          <Callout>Use only what you can afford to lose.</Callout>
        </>
      ),
    },
    {
      id: "non-custodial",
      title: "You hold your keys",
      body: (
        <>
          <p>
            The interface is non-custodial. You sign every transaction with your own wallet, including a passkey
            embedded wallet provided by Privy. We never hold your private keys and can&rsquo;t move funds from your
            wallet.
          </p>
          <p>
            Collateral you deposit is held by the Paraclr smart contracts, not by us. The contracts are owned by a
            multisig acting through a timelock that can change parameters, the oracle configuration and roles after
            the timelock delay. Those changes can affect your positions. The landing page lists what each role can and
            can&rsquo;t do; the deployed code is the final word.
          </p>
        </>
      ),
    },
    {
      id: "risks",
      title: "Risks",
      body: (
        <p>
          Trading leveraged perpetual futures is risky, and this is unaudited beta software. You confirm you have read
          the <Link href={RISK_PATH}>risk disclosure</Link> and accept those risks, including the loss of everything you
          deposit.
        </p>
      ),
    },
    {
      id: "fees",
      title: "Fees",
      body: (
        <>
          <p>Using Paraclr costs:</p>
          <ul>
            <li>a trading fee in basis points of notional, paid to the lane&rsquo;s insurance fund;</li>
            <li>an execution fee in MON per order, paid to whoever executes it;</li>
            <li>funding payments between longs and shorts;</li>
            <li>liquidation costs if your account is liquidated;</li>
            <li>Monad gas fees and Pyth price-update fees.</li>
          </ul>
          <p>
            The contracts set the fees, and the interface shows them before you confirm. They can change through the
            timelock. We may add an interface fee only after updating these terms{" "}
            <Placeholder>LEGAL REVIEW</Placeholder>.
          </p>
        </>
      ),
    },
    {
      id: "responsibilities",
      title: "Your responsibilities",
      body: (
        <ul>
          <li>Keep your devices, passkeys and keys secure. Nobody can recover them for you.</li>
          <li>Check every transaction, URL and contract address before you sign.</li>
          <li>Know and follow the laws that apply to you, and pay your own taxes.</li>
          <li>Make your own decisions. Nothing on the interface is a recommendation.</li>
        </ul>
      ),
    },
    {
      id: "prohibited",
      title: "What you must not do",
      body: (
        <ul>
          <li>Break sanctions or any other law, or help someone else do so.</li>
          <li>Manipulate prices, the oracle or the markets, or trade on prices you know to be wrong.</li>
          <li>Exploit a bug instead of reporting it.</li>
          <li>Attack, overload or interfere with the interface, the keepers or other users.</li>
          <li>Get around geographic or address blocks, or use Paraclr for someone who isn&rsquo;t allowed to.</li>
        </ul>
      ),
    },
    {
      id: "security",
      title: "Reporting security issues",
      body: (
        <p>
          If you find a vulnerability, report it privately to <Placeholder>SECURITY CONTACT</Placeholder> and give us
          reasonable time to respond before telling anyone else. There is no bug bounty unless we publish one with its
          own terms.
        </p>
      ),
    },
    {
      id: "third-parties",
      title: "Third-party services",
      body: (
        <p>
          Paraclr relies on services we don&rsquo;t control: the Monad network, Agora&rsquo;s AUSD, Pyth price data,
          Privy wallets, RPC providers and block explorers. Their terms apply to your use of them, and we aren&rsquo;t
          responsible for their failures. We are not affiliated with or endorsed by any of them.
        </p>
      ),
    },
    {
      id: "open-source",
      title: "Open-source code",
      body: (
        <p>
          The contracts, keeper and interface code are published at{" "}
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>{" "}
          under <Placeholder>LICENSE</Placeholder>. That license, including its own disclaimer, governs your use of the
          code. These terms govern your use of the interface and services we run.
        </p>
      ),
    },
    {
      id: "no-advice",
      title: "No advice",
      body: (
        <p>
          Everything on the interface, the landing page and our posts is general information. It is not financial,
          investment, legal or tax advice, and we don&rsquo;t act as your broker, adviser or fiduciary.
        </p>
      ),
    },
    {
      id: "warranties",
      title: "No warranties",
      body: (
        <p>
          The interface, the keepers and the contracts are provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;,
          without warranties of any kind, to the fullest extent the law allows. We don&rsquo;t warrant that they are
          free of bugs, accurate, secure or available.
        </p>
      ),
    },
    {
      id: "liability",
      title: "Limits on our liability",
      body: (
        <p>
          To the fullest extent the law allows, we are not liable for any loss of funds, profits, data or opportunity,
          or for indirect or consequential losses, arising from your use of Paraclr, including losses caused by bugs,
          oracle failures, keeper downtime, liquidations, network failures or third-party services. Where liability
          can&rsquo;t be excluded, it is limited to <Placeholder>LEGAL REVIEW: cap</Placeholder>.
        </p>
      ),
    },
    {
      id: "indemnity",
      title: "Indemnity",
      body: (
        <p>
          If your breach of these terms or of the law causes a claim against us, you agree to cover our reasonable
          losses and costs from that claim <Placeholder>LEGAL REVIEW</Placeholder>.
        </p>
      ),
    },
    {
      id: "changes",
      title: "Changes to these terms",
      body: (
        <p>
          We may update these terms. We will post the new version here with its date and point out material changes on
          the landing page. If you keep using the interface after a change, you accept the new terms.
        </p>
      ),
    },
    {
      id: "law",
      title: "Governing law and disputes",
      body: (
        <p>
          These terms are governed by the laws of <Placeholder>GOVERNING LAW</Placeholder>. Disputes go to{" "}
          <Placeholder>COURTS OR ARBITRATION SEAT</Placeholder>{" "}
          <Placeholder>LEGAL REVIEW: class-action waiver, consumer rules</Placeholder>.
        </p>
      ),
    },
    {
      id: "contact",
      title: "Contact",
      body: (
        <p>
          Questions about these terms: <Placeholder>CONTACT EMAIL</Placeholder>.
        </p>
      ),
    },
  ];

  return (
    <LegalShell
      kicker="Terms of use"
      title="Terms for using Paraclr."
      updated={UPDATED}
      live={status.live}
      current="terms"
      intro={
        <p>
          Plain-language draft terms for the Paraclr interface and its capped, unaudited mainnet beta. Read them with
          the <Link href={RISK_PATH}>risk disclosure</Link>, which is part of these terms.
        </p>
      }
      sections={sections}
    />
  );
}
