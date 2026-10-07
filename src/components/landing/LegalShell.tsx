// Shell for /terms and /risk: the brand nav, the DRAFT banner, a table of
// contents and the landing footer. Server component.

import type { ReactNode } from "react";
import { Bend } from "./brand/Bend";
import { displayFont } from "./brand/fonts";
import { Footer } from "./FinalCta";
import { Nav } from "./Nav";
import { BETA_LABEL, LEGAL_DRAFT_NOTICE, RISK_PATH, TERMS_PATH } from "./disclosures";
import b from "./brand/Brand.module.css";
import s from "./Legal.module.css";

/** A bracketed placeholder legal review must fill, e.g. <Placeholder>OPERATOR</Placeholder>. */
export function Placeholder({ children }: { children: ReactNode }) {
  return <span className={s.placeholder}>[{children}]</span>;
}

export function Callout({ children }: { children: ReactNode }) {
  return <p className={s.callout}>{children}</p>;
}

export interface LegalSection {
  id: string;
  title: string;
  body: ReactNode;
}

export function LegalShell({
  kicker,
  title,
  intro,
  updated,
  live,
  current,
  summary,
  sections,
}: {
  kicker: string;
  title: string;
  intro: ReactNode;
  updated: string;
  live: boolean;
  current: "terms" | "risk";
  summary?: ReactNode;
  sections: LegalSection[];
}) {
  const links = [
    { href: "/#auction", label: "How it works" },
    { href: "/#beta", label: "Mainnet beta" },
    { href: RISK_PATH, label: "Risks", current: current === "risk" },
    { href: TERMS_PATH, label: "Terms", current: current === "terms" },
  ];
  return (
    <div className={`${b.root} ${displayFont.variable}`}>
      <a href="#main" className={b.skip}>
        Skip to content
      </a>
      <Nav links={links} brandHref="/" />

      <main id="main" className={`${b.light} ${b.surface} ${s.main}`}>
        <div className={`${b.container} ${s.layout}`}>
          <div className={s.draft} role="note">
            <span className={`${b.chip} ${b.chipWarn} ${s.draftTag}`}>Draft</span>
            <p>
              <strong>{LEGAL_DRAFT_NOTICE}.</strong> This text is a plain-language working draft. It has not been
              reviewed by a lawyer, is not legal advice, and may change completely before any launch. Bracketed items
              like <code className={b.code}>[OPERATOR]</code> are placeholders.
            </p>
          </div>

          <header className={s.head}>
            <p className={b.eyebrow}>{kicker}</p>
            <h1 className={s.title}>{title}</h1>
            <p className={s.meta}>
              <span className={b.chip}>Draft of {updated}</span>
              {live ? (
                <span className={`${b.chip} ${b.chipPos}`}>
                  <span className={`${b.dot} ${b.dotPos}`} aria-hidden="true" />
                  Mainnet beta live · {BETA_LABEL.toLowerCase()}
                </span>
              ) : (
                <span className={`${b.chip} ${b.chipWarn}`}>
                  <span className={`${b.dot} ${b.dotWarn}`} aria-hidden="true" />
                  Mainnet beta pending its launch gate · demo only, no real value
                </span>
              )}
            </p>
            <div className={s.intro}>{intro}</div>
          </header>

          {summary ? <div className={s.summary}>{summary}</div> : null}

          <div className={s.columns}>
            <nav className={s.toc} aria-label="On this page">
              <p className={s.tocTitle}>On this page</p>
              <ol>
                {sections.map((sec, i) => (
                  <li key={sec.id}>
                    <a href={`#${sec.id}`}>
                      <span className={s.tocNum}>{String(i + 1).padStart(2, "0")}</span>
                      {sec.title}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
            <article className={s.article}>
              {sections.map((sec, i) => (
                <section key={sec.id} id={sec.id} className={s.section} aria-labelledby={`${sec.id}-title`}>
                  <h2 id={`${sec.id}-title`} className={s.h2}>
                    <span className={s.num}>{String(i + 1).padStart(2, "0")}</span>
                    {sec.title}
                  </h2>
                  <div className={s.body}>{sec.body}</div>
                </section>
              ))}
            </article>
          </div>
        </div>
      </main>
      <Bend into="dark" corner="right" />
      <Footer live={live} />
    </div>
  );
}
