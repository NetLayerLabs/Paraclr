"use client";

import Link from "next/link";
import { useEffect } from "react";
import { GITHUB_URL } from "@/components/landing/content";
import styles from "./status.module.css";

/** A render error anywhere below the root layout: say what happened and offer a retry. */
export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <p className={styles.kicker}>Error · Monad testnet</p>
        <h1 className={styles.title}>
          Something broke. <span>Nothing on chain is lost.</span>
        </h1>
        <p className={styles.lede}>
          This page hit an error while rendering. Balances and positions live in the contracts on Monad testnet, not in
          the page, so try again or reload.
        </p>
        {error.digest ? <p className={styles.code}>Reference: {error.digest}</p> : null}
        <ul className={styles.list}>
          <li>
            <button type="button" onClick={() => retry()}>
              <span className={styles.num}>01</span>Try again<span className={styles.desc}>Re-render this page</span>
            </button>
          </li>
          <li>
            <Link href="/">
              <span className={styles.num}>02</span>Home<span className={styles.desc}>What Paraclr is</span>
            </Link>
          </li>
          <li>
            <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noreferrer">
              <span className={styles.num}>03</span>Report it ↗<span className={styles.desc}>GitHub issues</span>
            </a>
          </li>
        </ul>
      </main>
    </div>
  );
}
