import Link from "next/link";
import type { RepoFacts, XrayEvidence } from "./benchResults.server";
import { HeroVisual } from "./HeroVisual";
import { ArrowRight, CodeIcon } from "./icons";
import { AUCTION, GITHUB_TREE, GITHUB_URL } from "./content";
import { RISK_ANCHORS, RISK_PATH } from "./disclosures";
import { fmtInt } from "./format";
import b from "./brand/Brand.module.css";
import s from "./Hero.module.css";

interface Badge {
  href: string;
  label: string;
  sub: string;
  dot: "pos" | "warn" | "accent" | "muted";
  external?: boolean;
}

/** Every badge is true for the current build: status follows deployments/143.json. */
function badges(live: boolean, repo: RepoFacts): Badge[] {
  const tests: Badge = {
    href: `${GITHUB_TREE}/contracts/test`,
    label: repo.foundryTests ? `${fmtInt(repo.foundryTests)} tests` : "Foundry tests",
    sub: repo.invariantTests ? `+ ${fmtInt(repo.invariantTests)} invariants` : "fuzz + invariants",
    dot: "accent",
    external: true,
  };
  if (live) {
    return [
      { href: "#beta", label: "Live on Monad", sub: "capped mainnet beta", dot: "pos" },
      tests,
      { href: "#beta", label: "Pyth-verified", sub: "prices checked on chain", dot: "accent" },
      {
        href: `${RISK_PATH}#${RISK_ANCHORS.smartContract}`,
        label: "Unaudited",
        sub: "use what you can lose",
        dot: "muted",
      },
    ];
  }
  return [
    { href: "#beta", label: "Mainnet beta", sub: "pending launch gate", dot: "warn" },
    tests,
    { href: "#xray", label: "Conflict X-ray", sub: "measured, labelled", dot: "accent" },
    {
      href: `${RISK_PATH}#${RISK_ANCHORS.smartContract}`,
      label: "Not audited",
      sub: "review + Slither only",
      dot: "muted",
    },
  ];
}

const DOT: Record<Badge["dot"], string> = {
  pos: b.dotPos,
  warn: b.dotWarn,
  accent: "",
  muted: s.dotMuted,
};

/** `live`: deployments/143.json exists with "production": true (see production.server.ts). */
export function Hero({ live, repo, xray }: { live: boolean; repo: RepoFacts; xray: XrayEvidence | null }) {
  return (
    <section id="top" className={`${b.light} ${b.surface} ${s.hero}`} aria-labelledby="hero-title">
      <div className={`${b.container} ${s.grid}`}>
        <div className={s.copy}>
          <h1 id="hero-title" className={s.title}>
            <span className={s.line1}>
              Liquidations, <span className={s.accent}>auctioned.</span>
              <span className={s.caret} aria-hidden="true" />
            </span>
            <span className={s.line2}>Priced by the block, not the gas race.</span>
          </h1>
          <p className={s.sub}>
            Paraclr is a perps clearinghouse for Monad. An underwater account doesn&rsquo;t go to the fastest bot for a
            fixed fee: it goes to a Dutch auction whose discount rises {AUCTION.stepBps} bps per block, backed by its
            lane&rsquo;s backstop LPs. The trader keeps the equity the taker isn&rsquo;t paid.
          </p>
          <div className={s.ctas}>
            <Link href="/app" className={`${b.btn} ${b.btnPrimary} ${b.btnLg}`}>
              Launch app
              <ArrowRight className={`${b.btnIcon} ${b.btnIconMove}`} />
            </Link>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className={`${b.btn} ${b.btnOutline} ${b.btnLg}`}>
              <CodeIcon className={b.btnIcon} />
              Read the code
            </a>
          </div>
          <ul className={s.trust} aria-label="Status at a glance">
            {badges(live, repo).map((x) => (
              <li key={x.label}>
                <a href={x.href} className={s.badge} {...(x.external ? { target: "_blank", rel: "noreferrer" } : {})}>
                  <span className={`${b.dot} ${DOT[x.dot]}`} aria-hidden="true" />
                  <span className={s.badgeText}>
                    <b>{x.label}</b>
                    <span>{x.sub}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
        <div className={s.visual}>
          <HeroVisual xray={xray} />
        </div>
      </div>
    </section>
  );
}
