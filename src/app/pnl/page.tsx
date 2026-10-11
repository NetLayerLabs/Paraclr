import type { Metadata } from "next";
import Link from "next/link";
import { ParaclrLogo } from "@/components/brand/ParaclrLogo";
import { displayFont } from "@/components/landing/brand/fonts";
import { fmtPenaltyPct } from "@/lib/kept";
import { cardQuery, fmtSignedPct, gateCardNetwork, keptStrip, narration, parseCard, type PnlCardData } from "@/lib/pnlCard";
import { loadProductionStatus } from "@/components/landing/production.server";
import styles from "./pnl.module.css";

// A shared PnL card (from the app's "Share on X"): /pnl?<cardQuery>. Its Open Graph / X image is the
// card itself (/api/pnl-card), so the link previews as the card in the timeline.

type Search = Record<string, string | string[] | undefined>;

/**
 * Shown when the link carries no card (a bare /pnl): what a shared card looks like, labelled as a
 * sample on the page and in its alt text. Network "demo", so the image itself says it isn't a fill.
 */
const SAMPLE: PnlCardData = {
  symbol: "SOL/AUSD",
  side: "long",
  leverage: 3,
  entry: 110,
  exit: 112.2,
  pnl: 0.6,
  pnlPct: 6,
  network: "demo",
  at: 1_760_000_000,
};

async function cardFrom(sp: Search): Promise<PnlCardData | null> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") q.set(k, v);
  const card = parseCard(q);
  return card ? gateCardNetwork(card, (await loadProductionStatus()).live) : null;
}

export async function generateMetadata(props: PageProps<"/pnl">): Promise<Metadata> {
  const card = await cardFrom(await props.searchParams);
  if (!card) {
    const description =
      "Share a closed Paraclr trade as a card: entry, exit, PnL and, after a liquidation auction, what the trader kept. " +
      "Monad testnet, test funds.";
    return {
      title: "PnL card",
      description,
      openGraph: { title: "PnL card · Paraclr", description },
      twitter: { card: "summary_large_image", title: "PnL card · Paraclr", description },
    };
  }
  const base = card.symbol.replace("/AUSD", "");
  // The layout's title template appends "· Paraclr"; the share previews carry it explicitly.
  const title = `${fmtSignedPct(card.pnlPct)} on ${base}-PERP ${card.side} ${card.leverage}x`;
  const fullTitle = `${title} · Paraclr`;
  const image = { url: `/api/pnl-card?${cardQuery(card)}`, width: 1200, height: 630, alt: `${title} · Paraclr` };
  const kept = card.kept !== undefined ? ` Liquidated by auction: ${keptStrip(card.kept, fmtPenaltyPct())}.` : "";
  const description = `“${narration(card)}”${kept} Fair liquidations, auctioned per block, on Monad.`;
  return {
    title,
    description,
    openGraph: { title: fullTitle, description, images: [image] },
    twitter: { card: "summary_large_image", title: fullTitle, description, images: [image.url] },
  };
}

export default async function PnlSharePage(props: PageProps<"/pnl">) {
  const card = await cardFrom(await props.searchParams);
  return (
    <div className={`${styles.page} ${displayFont.variable}`}>
      <header className={styles.top}>
        <Link href="/" aria-label="Paraclr home">
          <ParaclrLogo tone="white" height={28} />
        </Link>
      </header>
      <main className={styles.main}>
        {card ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className={styles.card}
              src={`/api/pnl-card?${cardQuery(card)}`}
              width={1200}
              height={630}
              alt={`${card.symbol} ${card.side} closed ${fmtSignedPct(card.pnlPct)}.${card.kept !== undefined ? ` Liquidated by auction: ${keptStrip(card.kept, fmtPenaltyPct())}.` : ""} ${narration(card)}`}
            />
            <p className={styles.lede}>
              Closed on Paraclr, the perps clearinghouse where an underwater account goes to a per-block auction
              instead of the fastest bot, and the trader keeps the equity the taker isn&apos;t paid.
            </p>
          </>
        ) : (
          <>
            <p className={styles.sampleTag}>Sample card · not a real trade</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className={styles.card}
              src={`/api/pnl-card?${cardQuery(SAMPLE)}`}
              width={1200}
              height={630}
              alt="Sample Paraclr PnL card (demo data, not a real trade): SOL long 3x closed +6%."
            />
            <p className={styles.lede}>
              This link carries no card, so here is a sample. Close a position in the app and choose Share on X to make
              your own; the link then shows your card here and in the post preview.
            </p>
          </>
        )}
        <div className={styles.actions}>
          <Link className={styles.primary} href="/app">
            Trade on Paraclr
          </Link>
          <Link className={styles.secondary} href="/#auction">
            How the auctions work
          </Link>
        </div>
      </main>
    </div>
  );
}
