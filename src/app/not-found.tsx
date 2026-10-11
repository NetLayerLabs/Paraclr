import type { Metadata } from "next";
import Link from "next/link";
import { ParaclrLogo } from "@/components/brand/ParaclrLogo";
import { displayFont } from "@/components/landing/brand/fonts";
import { GITHUB_URL, README } from "@/components/landing/content";
import styles from "./status.module.css";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false },
};

/** Unmatched URLs: say so, then the places a visitor most likely wanted. */
export default function NotFound() {
  return (
    <div className={`${styles.page} ${displayFont.variable}`}>
      <header className={styles.top}>
        <Link href="/" aria-label="Paraclr home">
          <ParaclrLogo tone="white" height={24} />
        </Link>
      </header>
      <main className={styles.main}>
        <p className={styles.kicker}>404 · Monad testnet</p>
        <h1 className={styles.title}>
          No page here. <span>Try one of these.</span>
        </h1>
        <p className={styles.lede}>
          Paraclr is a fair-liquidation perps clearinghouse, live on Monad testnet only: test funds, no real value.
        </p>
        <ul className={styles.list}>
          <li>
            <Link href="/">
              <span className={styles.num}>01</span>Home<span className={styles.desc}>What Paraclr is</span>
            </Link>
          </li>
          <li>
            <Link href="/app">
              <span className={styles.num}>02</span>Open the app
              <span className={styles.desc}>Sign in, get test MON and AUSD, trade</span>
            </Link>
          </li>
          <li>
            <Link href="/arena">
              <span className={styles.num}>03</span>Arena<span className={styles.desc}>Crash the market, no sign-in</span>
            </Link>
          </li>
          <li>
            <a href={README} target="_blank" rel="noreferrer">
              <span className={styles.num}>04</span>README ↗<span className={styles.desc}>Evidence and how to try it</span>
            </a>
          </li>
          <li>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              <span className={styles.num}>05</span>GitHub ↗<span className={styles.desc}>Source and contracts</span>
            </a>
          </li>
        </ul>
      </main>
    </div>
  );
}
