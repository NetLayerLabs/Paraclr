import { GITHUB_BLOB, MONAD_EXPLORER, README_AT } from "./content";
import b from "./brand/Brand.module.css";
import s from "./BuiltOn.module.css";

type Tone = "accent" | "pos" | "warn" | "neutral";

interface Partner {
  name: string;
  site: string;
  logo: string;
  /** Anchor of the partner's subsection under "Built on" in README.md. */
  readme: string;
  /** What it does in Paraclr. */
  use: string;
  /** One concrete, checkable fact (an address, a parameter or a measured number) and its source. */
  fact: string;
  factHref?: string;
  status: string;
  tone: Tone;
}

const README = `${GITHUB_BLOB}/README.md`;
const AUSD_TESTNET = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
const AUSD_MAINNET = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a";
/** bench/xray/10143-run-mv2ze6l6-xzyi6.json: Paraclr lanes vs the naive shared-state build. */
const ARENA_XRAY = "bench/xray/10143-run-mv2ze6l6-xzyi6.json";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * The five projects Paraclr is built on, each with what it does here and one fact a judge can check, then one line
 * naming the supporting stack (detail in the README). Marks come from public/partners/ (each project's own site, brand kit or repo),
 * in their light or colour variant since the section is dark. Full detail: README.md "Built on".
 */
function partners(live: boolean, testnet: boolean, testnetLive: boolean): Partner[] {
  return [
    {
      name: "Monad",
      site: "https://www.monad.xyz",
      logo: "/partners/monad.svg",
      readme: "monad",
      use: "The chain. Each of the 8 lanes keeps its auction state in its own storage, so in a crash Monad's parallel executor has no reason to re-execute one lane's resolution because of another's. Discounts are timed in blocks, not seconds.",
      fact: "0 vs 49 cross-lane dependency edges against a shared-state build, first public Arena crash on Monad testnet",
      factHref: `${GITHUB_BLOB}/${ARENA_XRAY}`,
      status: live
        ? "Mainnet beta · chain 143"
        : testnetLive
          ? "Live on testnet · chain 10143"
          : testnet
            ? "Testnet demo · chain 10143"
            : "Mainnet beta pending",
      tone: live || testnetLive ? "pos" : "warn",
    },
    {
      name: "Agora AUSD",
      site: "https://www.agora.finance",
      logo: "/partners/agora.svg",
      readme: "agora-ausd",
      use: live
        ? "The single collateral and quote asset: margin, PnL, fees, lane insurance and backstop deposits, 6 decimals. Approvals are for the exact amount, never unlimited."
        : testnetLive
          ? "The single collateral and quote asset: margin, PnL, fees, lane insurance and backstop deposits, 6 decimals. Claim test AUSD calls Agora's faucet contract from your own wallet."
          : "The single collateral and quote asset of the production contracts. The demo runs use MockAUSD, a 6-decimal stand-in with no value.",
      fact: live ? `AUSD ${short(AUSD_MAINNET)} on Monad mainnet` : `Testnet AUSD ${short(AUSD_TESTNET)} · real AUSD ${short(AUSD_MAINNET)} for the beta`,
      factHref: live ? undefined : `${MONAD_EXPLORER}/address/${AUSD_TESTNET}`,
      status: live ? "Collateral · mainnet" : testnetLive ? "Collateral · testnet AUSD" : "Collateral · mainnet beta",
      tone: live || testnetLive ? "pos" : "accent",
    },
    {
      name: "Pyth",
      site: "https://www.pyth.network",
      logo: "/partners/pyth-white.png",
      readme: "pyth",
      use: "Every order and auction carries a signed Pyth update the contract verifies for age, confidence and a positive price. An order fills at the first Pyth price after its delay, so neither the trader nor the executor picks it.",
      fact: testnetLive
        ? "SOL/USD and BTC/USD · stored price ≤ 15 s old · confidence ≤ 2% · Hermes data trial until ~Oct 20"
        : "SOL/USD and BTC/USD feeds · staleness and confidence bounds checked on chain",
      status: live ? "Prices · mainnet" : testnetLive ? "Prices · testnet, data trial" : "Prices · beta contracts",
      tone: "accent",
    },
    {
      name: "Privy",
      site: "https://www.privy.io",
      logo: "/partners/privy-white.png",
      readme: "privy",
      use: "Sign in with a passkey, email, Google, X, Discord, GitHub or your own wallet. Everyone without a wallet gets one embedded wallet, which signs their trades; a reload keeps the session.",
      fact: "No seed phrase · the demo burner key is never offered on mainnet",
      status: "Sign-in + wallet",
      tone: "neutral",
    },
    {
      name: "Envio",
      site: "https://envio.dev",
      logo: "/partners/envio.svg",
      readme: "envio",
      use: "HyperIndex reads the clearinghouse through HyperSync: every order, fill, auction and backstop flow. Order history, your past auctions and activity since deploy come from its GraphQL API on Envio Cloud.",
      fact: "21 contract events into 11 entities · indexer paraclr-testnet",
      factHref: `${GITHUB_BLOB}/indexer/schema.graphql`,
      status: testnetLive ? "Indexer · live on testnet" : "Indexer",
      tone: testnetLive ? "pos" : "neutral",
    },
  ];
}

const DOT: Record<Tone, string> = {
  accent: "",
  pos: b.dotPos,
  warn: b.dotWarn,
  neutral: s.dotNeutral,
};

const LOGO = 22;

function Logo({ src, w = LOGO, h = LOGO }: { src: string; w?: number; h?: number }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={s.logo} src={src} width={w} height={h} alt="" />;
}

function Row({ p }: { p: Partner }) {
  return (
    <li className={s.row}>
      <div className={s.who}>
        <a className={s.name} href={p.site} target="_blank" rel="noopener noreferrer">
          <Logo src={p.logo} />
          {p.name}
        </a>
        <span className={s.status}>
          <span className={`${b.dot} ${DOT[p.tone]}`} aria-hidden="true" />
          {p.status}
        </span>
      </div>
      <p className={s.use}>{p.use}</p>
      <div className={s.side}>
        <p className={s.fact}>
          {p.factHref ? (
            <a href={p.factHref} target="_blank" rel="noopener noreferrer">
              {p.fact}
            </a>
          ) : (
            p.fact
          )}
        </p>
        <p className={s.links}>
          <a className={b.link} href={`${README}#${p.readme}`} target="_blank" rel="noopener noreferrer">
            How Paraclr uses {p.name}
          </a>
        </p>
      </div>
    </li>
  );
}

export function BuiltOn({
  live,
  testnet,
  testnetLive = false,
}: {
  live: boolean;
  testnet: boolean;
  testnetLive?: boolean;
}) {
  return (
    <section id="built-on" className={`${b.dark} ${b.surface} ${b.section} ${s.section}`} aria-labelledby="built-title">
      <div className={b.container}>
        <div className={`${b.sectionHead} ${b.sectionHeadCenter}`}>
          <p className={b.eyebrow}>Built on</p>
          <h2 id="built-title" className={b.h2}>
            Public infrastructure, <em>used as published.</em>
          </h2>
          <p className={b.lede}>
            Paraclr is contracts, a keeper and an app on top of five projects. Each row says what it does here and one
            fact you can check; the README has the code paths and addresses.
          </p>
        </div>

        <ul className={s.list} aria-label="Projects Paraclr is built on">
          {partners(live, testnet, testnetLive).map((p) => (
            <Row key={p.name} p={p} />
          ))}
        </ul>

        <p className={s.also}>
          Also used: Safe, OpenZeppelin, Foundry, viem, Slither and Next.js.{" "}
          <a className={b.link} href={README_AT.supporting} target="_blank" rel="noreferrer">
            Supporting stack in the README
          </a>
        </p>

        <p className={s.disclaimer}>
          Built for the Monad Metropolis hackathon. Not affiliated with or endorsed by Monad, Agora, Pyth, Privy, Envio,
          Safe or OpenZeppelin.
        </p>
      </div>
    </section>
  );
}
