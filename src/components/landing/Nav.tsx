"use client";

import Link from "next/link";
import { ParaclrLogo } from "@/components/brand/ParaclrLogo";
import { useEffect, useState } from "react";
import { ArrowRight, CodeIcon, Cross, Menu } from "./icons";
import { GITHUB_URL } from "./content";
import b from "./brand/Brand.module.css";
import s from "./Nav.module.css";

export interface NavLink {
  href: string;
  label: string;
  current?: boolean;
}

/** Sticky light nav for the landing page and /terms, /risk. */
export function Nav({ links, brandHref = "#top" }: { links: readonly NavLink[]; brandHref?: string }) {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onResize = () => {
      if (window.innerWidth >= 960) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const brandLabel = brandHref === "#top" ? "Paraclr, back to top" : "Paraclr home";

  return (
    <header className={s.nav} data-scrolled={scrolled || open || undefined}>
      <div className={`${b.container} ${s.inner}`}>
        <a href={brandHref} className={s.brand} aria-label={brandLabel} onClick={() => setOpen(false)}>
          <ParaclrLogo tone="ink" height={30} />
        </a>

        <nav className={s.links} aria-label="Primary">
          {links.map((l) => (
            <a key={l.href} href={l.href} className={s.link} aria-current={l.current ? "page" : undefined}>
              {l.label}
            </a>
          ))}
        </nav>

        <div className={s.actions}>
          <button
            type="button"
            className={s.menuBtn}
            aria-expanded={open}
            aria-controls="pc-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <Cross className={s.menuIcon} /> : <Menu className={s.menuIcon} />}
          </button>
        </div>
      </div>

      <div id="pc-menu" className={s.sheet} hidden={!open}>
        <nav className={b.container} aria-label="Primary (menu)">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className={s.sheetLink}
              aria-current={l.current ? "page" : undefined}
              onClick={() => setOpen(false)}
            >
              {l.label}
              <ArrowRight className={s.sheetIcon} />
            </a>
          ))}
          <a href={GITHUB_URL} className={s.sheetLink} target="_blank" rel="noreferrer">
            Source on GitHub
            <CodeIcon className={s.sheetIcon} />
          </a>
          <Link href="/app" className={`${b.btn} ${b.btnPrimary} ${s.sheetCta}`} onClick={() => setOpen(false)}>
            Launch app
            <ArrowRight className={b.btnIcon} />
          </Link>
        </nav>
      </div>
    </header>
  );
}
