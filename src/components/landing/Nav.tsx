"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, GitHubIcon, Logo } from "./icons";
import { GITHUB_URL, NAV_LINKS } from "./content";
import ui from "./Landing.module.css";
import styles from "./Nav.module.css";

export function Nav() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onResize = () => {
      if (window.innerWidth >= 900) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  return (
    <header className={styles.nav} data-open={open || undefined}>
      <div className={`${ui.container} ${styles.inner}`}>
        <a href="#top" className={styles.brand} aria-label="Paraclr, back to top" onClick={() => setOpen(false)}>
          <Logo className={styles.logo} />
          <span className={styles.wordmark}>Paraclr</span>
        </a>

        <nav className={styles.links} aria-label="Sections">
          {NAV_LINKS.map((l) => (
            <a key={l.href} href={l.href} className={styles.link}>
              {l.label}
            </a>
          ))}
        </nav>

        <div className={styles.actions}>
          <a
            href={GITHUB_URL}
            className={styles.github}
            target="_blank"
            rel="noreferrer"
            aria-label="Paraclr on GitHub"
          >
            <GitHubIcon className={styles.githubIcon} />
            <span className={styles.githubLabel}>GitHub</span>
          </a>
          <Link href="/app" className={`${ui.btn} ${ui.btnPrimary} ${ui.btnSm}`}>
            Launch app
            <ArrowRight className={ui.arrow} />
          </Link>
          <button
            type="button"
            className={styles.menuBtn}
            aria-expanded={open}
            aria-controls="landing-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
          >
            <span className={styles.menuGlyph} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div id="landing-menu" className={styles.sheet} hidden={!open}>
        <nav className={ui.container} aria-label="Sections (menu)">
          {NAV_LINKS.map((l) => (
            <a key={l.href} href={l.href} className={styles.sheetLink} onClick={() => setOpen(false)}>
              {l.label}
              <ArrowRight className={styles.sheetArrow} />
            </a>
          ))}
          <a href={GITHUB_URL} className={styles.sheetLink} target="_blank" rel="noreferrer">
            GitHub
            <GitHubIcon className={styles.sheetArrow} />
          </a>
        </nav>
      </div>
    </header>
  );
}
