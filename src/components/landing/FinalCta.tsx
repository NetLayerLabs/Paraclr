import Link from "next/link";
import { ParaclrLogo } from "@/components/brand/ParaclrLogo";
import { BuiltByBadge } from "@/components/brand/BuiltByBadge";
import { Mark } from "./brand/Logo";
import { ArrowRight, ArrowUpRight, CodeIcon, XIcon } from "./icons";
import { GITHUB_BLOB, GITHUB_URL, X_URL } from "./content";
import { AUDIT_STATUS, BETA_LABEL, RISK_PATH, TERMS_PATH } from "./disclosures";
import b from "./brand/Brand.module.css";
import s from "./FinalCta.module.css";

/** Concentric half-lanes behind the CTA: the mark's 8 lanes, opened into a track. */
function Track() {
  return (
    <svg className={s.track} viewBox="0 0 1200 420" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      {Array.from({ length: 8 }, (_, k) => {
        const r = 300 + k * 34;
        return (
          <path
            key={k}
            d={`M${600 - r} 420 A${r} ${r} 0 0 1 ${600 + r} 420`}
            fill="none"
            stroke="#8f7cff"
            strokeOpacity={0.34 - k * 0.035}
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </svg>
  );
}

/** `live`: deployments/143.json exists with "production": true. */
export function FinalCta({ live }: { live: boolean }) {
  return (
    <section className={`${b.dark} ${b.surface} ${s.cta}`} aria-labelledby="cta-title">
      <Track />
      <div className={`${b.container} ${s.inner}`}>
        <Mark className={s.mark} />
        {live ? (
          <>
            <h2 id="cta-title" className={`${b.h2} ${b.breakEm} ${s.title}`}>
              Trade the beta. <em>Read the risks first.</em>
            </h2>
            <p className={s.sub}>
              The app trades on Monad mainnet with real AUSD in a capped, unaudited beta: use only what you can afford
              to lose. The crash button and the X-ray stay on the testnet and local-anvil demo, labelled as such.
            </p>
          </>
        ) : (
          <>
            <h2 id="cta-title" className={`${b.h2} ${b.breakEm} ${s.title}`}>
              Trade it. Crash it. <em>Watch the auctions clear.</em>
            </h2>
            <p className={s.sub}>
              Open the terminal with a passkey or the demo burner wallet, crash the market, and see what traders get
              back. Testnet demo, test AUSD, no real value.
            </p>
          </>
        )}
        <div className={s.actions}>
          <Link href="/app" className={`${b.btn} ${b.btnInverse} ${b.btnLg}`}>
            Launch app
            <ArrowRight className={`${b.btnIcon} ${b.btnIconMove}`} />
          </Link>
          {live ? (
            <Link href={RISK_PATH} className={`${b.btn} ${b.btnQuiet} ${b.btnLg}`}>
              Read the risks
            </Link>
          ) : (
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className={`${b.btn} ${b.btnQuiet} ${b.btnLg}`}>
              <CodeIcon className={b.btnIcon} />
              Read the code
            </a>
          )}
        </div>
      </div>
    </section>
  );
}


/** Shared by the landing page and /terms, /risk, so in-page links are absolute (`/#faq`). */
export function Footer({ live }: { live: boolean }) {
  const columns: { title: string; links: { href: string; label: string; external?: boolean; soon?: boolean }[] }[] = [
    {
      title: "Product",
      links: [
        { href: "/app", label: "Launch app" },
        { href: "/#auction", label: "How it works" },
        { href: "/#results", label: "Results" },
        { href: "/#faq", label: "FAQ" },
      ],
    },
    {
      title: "Protocol",
      links: [
        { href: "/#backstop", label: "Backstop LPs" },
        { href: "/#xray", label: "Conflict X-ray" },
        { href: "/#solvency", label: "Solvency proof" },
        { href: "/#beta", label: "Mainnet beta" },
      ],
    },
    {
      title: "Resources",
      links: [
        { href: GITHUB_URL, label: "GitHub", external: true },
        { href: `${GITHUB_BLOB}/docs/PRODUCTION_PLAN.md`, label: "Production plan", external: true },
        { href: RISK_PATH, label: "Risk disclosure" },
        { href: TERMS_PATH, label: "Terms (draft)" },
      ],
    },
  ];

  return (
    <footer className={`${b.dark} ${b.surface} ${s.footer}`}>
      <div className={`${b.container} ${s.footerGrid}`}>
        <div className={s.brandCol}>
          <Link href="/" className={s.brand} aria-label="Paraclr home">
            <ParaclrLogo tone="white" height={32} />
          </Link>
          <p className={s.tagline}>
            The fair-liquidation clearinghouse for Monad: per-block auctions in 8 lanes, backstop LPs, a Conflict X-ray
            and a live solvency proof.
          </p>
          <a href={X_URL} className={s.social} target="_blank" rel="noopener noreferrer" aria-label="Paraclr on X">
            <XIcon className={s.socialIcon} />
          </a>
        </div>

        {columns.map((col) => (
          <nav key={col.title} className={s.col} aria-label={col.title}>
            <p className={s.colTitle}>{col.title}</p>
            <ul>
              {col.links.map((l) => (
                <li key={l.label}>
                  {l.soon ? (
                    <span className={s.soon}>
                      {l.label} <small>soon</small>
                    </span>
                  ) : l.external ? (
                    <a href={l.href} target="_blank" rel="noreferrer">
                      {l.label}
                      <ArrowUpRight className={s.ext} />
                    </a>
                  ) : l.href.startsWith("/#") ? (
                    <a href={l.href}>{l.label}</a>
                  ) : (
                    <Link href={l.href}>{l.label}</Link>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      <div className={b.container}>
        <div className={s.fine}>
          <p>
            {live ? (
              <>
                <strong>{BETA_LABEL}.</strong> {AUDIT_STATUS}.
              </>
            ) : (
              <>Testnet demo, not audited. Mainnet beta pending its launch gate.</>
            )}{" "}
            Nothing here is financial, legal or tax advice. The{" "}
            <Link href={TERMS_PATH} className={b.link}>
              terms
            </Link>{" "}
            and{" "}
            <Link href={RISK_PATH} className={b.link}>
              risk disclosure
            </Link>{" "}
            are drafts pending legal review.
          </p>
          <div className={s.fineRow}>
            <p>
              © 2026 Paraclr · Built for the Monad Metropolis hackathon (Onchain Finance &amp; Trading). Not affiliated
              with or endorsed by Monad, Agora, Pyth, Privy, Safe or OpenZeppelin.
            </p>
            <BuiltByBadge tone="dark" className={s.builtBy} />
          </div>
        </div>
      </div>
    </footer>
  );
}
