import Link from "next/link";
import { ArrowRight, GitHubIcon, Logo } from "./icons";
import { GITHUB_URL, X_URL } from "./content";
import ui from "./Landing.module.css";
import styles from "./Closing.module.css";

export function FinalCta() {
  return (
    <section className={styles.ctaSection} aria-labelledby="cta-title">
      <div className={ui.container}>
        <div className={styles.ctaBand}>
          <div className={styles.ctaLanes} aria-hidden="true">
            {Array.from({ length: 8 }, (_, lane) => (
              <span key={lane} className={styles.ctaLane}>
                {Array.from({ length: 36 }, (_, i) => (
                  <i
                    key={i}
                    className={(i * 11 + lane * 7) % 23 < 3 ? styles.ctaLiq : (i * 11 + lane * 7) % 23 === 3 ? styles.ctaCured : undefined}
                  />
                ))}
              </span>
            ))}
          </div>
          <div className={styles.ctaCopy}>
            <h2 id="cta-title" className={styles.ctaTitle}>
              Trade it. Crash it. <span>Watch the auctions clear.</span>
            </h2>
            <p className={styles.ctaSub}>
              Open the terminal with a passkey or the demo burner wallet, crash the market, and see what traders get
              back. Testnet only, test AUSD, nothing to lose.
            </p>
          </div>
          <div className={styles.ctaActions}>
            <Link href="/app" className={`${ui.btn} ${ui.btnPrimary} ${ui.btnLg}`}>
              Launch app
              <ArrowRight className={ui.arrow} />
            </Link>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className={`${ui.btn} ${ui.btnSecondary} ${ui.btnLg} ${styles.ctaSecondary}`}
            >
              <GitHubIcon className={ui.arrow} />
              Read the code
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={`${ui.container} ${styles.footerInner}`}>
        <div className={styles.footerBrand}>
          <a href="#top" className={styles.footerLogo}>
            <Logo className={styles.footerMark} />
            Paraclr
          </a>
          <p className={styles.footerTag}>
            The fair-liquidation clearinghouse for Monad: per-block auctions in 8 lanes, backstop LPs, a Conflict X-ray
            and a live solvency proof.
          </p>
        </div>
        <nav className={styles.footerLinks} aria-label="Footer">
          <Link href="/app">Launch app</Link>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
          {/* TODO: point X_URL (content.ts) at the project's X profile once it exists. */}
          <a href={X_URL}>X</a>
          <a href="#faq">FAQ</a>
        </nav>
        <div className={styles.footerFine}>
          <p>Built for the Monad Metropolis hackathon (Onchain Finance &amp; Trading). Testnet only, unaudited.</p>
          <p>Not affiliated with or endorsed by Monad, Agora, Privy or Chainlink.</p>
        </div>
      </div>
    </footer>
  );
}
