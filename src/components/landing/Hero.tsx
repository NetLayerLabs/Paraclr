import Link from "next/link";
import { HeroBoard } from "./HeroBoard";
import { ArrowRight, GitHubIcon } from "./icons";
import { AUCTION, GITHUB_URL } from "./content";
import ui from "./Landing.module.css";
import styles from "./Hero.module.css";

export function Hero() {
  return (
    <section className={styles.hero} id="top" aria-labelledby="hero-title">
      <div className={styles.backdrop} aria-hidden="true" />
      <div className={`${ui.container} ${styles.grid}`}>
        <div className={styles.copy}>
          <p className={styles.kicker}>
            <span className={`${ui.dot} ${ui.dotAccent}`} aria-hidden="true" />
            Testnet build · Monad Metropolis
          </p>
          <h1 id="hero-title" className={styles.title}>
            Fair liquidations, <span className={styles.titleAccent}>cleared every block.</span>
          </h1>
          <p className={styles.sub}>
            Paraclr is the <strong>fair-liquidation clearinghouse for Monad</strong>. Every block, underwater accounts
            in each of 8 lanes go to a Dutch auction backed by that lane&rsquo;s backstop LPs. The discount is set by
            the block clock, not by gas bidding, and traders get back the equity the auction doesn&rsquo;t use.
          </p>
          <div className={styles.ctas}>
            <Link href="/app" className={`${ui.btn} ${ui.btnPrimary} ${ui.btnLg}`}>
              Launch app
              <ArrowRight className={ui.arrow} />
            </Link>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className={`${ui.btn} ${ui.btnSecondary} ${ui.btnLg}`}>
              <GitHubIcon className={ui.arrow} />
              Read the code
            </a>
            <a href="#auction" className={ui.btnGhost}>
              How it works
              <span aria-hidden="true">↓</span>
            </a>
          </div>
          <ul className={styles.facts}>
            <li>
              <span className={styles.factKey}>discount</span>
              <code className={styles.factCode}>
                0 → +{AUCTION.stepBps} bps / block
              </code>
            </li>
            <li>
              <span className={styles.factKey}>trader keeps</span>
              <code className={styles.factCode}>E − P</code>
            </li>
            <li>
              <span className={styles.factKey}>status</span>
              <span>Testnet only · mock AUSD</span>
            </li>
          </ul>
        </div>
        <div className={styles.visual}>
          <HeroBoard />
        </div>
      </div>
    </section>
  );
}
