import type { Metadata } from "next";
import Link from "next/link";
import { ParaclrLogo } from "@/components/brand/ParaclrLogo";
import { cardQuery, fmtSignedPct, narration, parseCard, type PnlCardData } from "@/lib/pnlCard";
import styles from "./pnl.module.css";

// A shared PnL card (from the app's "Share on X"): /pnl?<cardQuery>. Its Open Graph / X image is the
// card itself (/api/pnl-card), so the link previews as the card in the timeline.

type Search = Record<string, string | string[] | undefined>;

function cardFrom(sp: Search): PnlCardData | null {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") q.set(k, v);
  return parseCard(q);
}

export async function generateMetadata(props: PageProps<"/pnl">): Promise<Metadata> {
  const card = cardFrom(await props.searchParams);
  if (!card) return { title: "Paraclr PnL card" };
  const base = card.symbol.replace("/AUSD", "");
  const title = `${fmtSignedPct(card.pnlPct)} on ${base}-PERP ${card.side} ${card.leverage}x · Paraclr`;
  const image = { url: `/api/pnl-card?${cardQuery(card)}`, width: 1200, height: 630, alt: title };
  const description = `“${narration(card)}” Fair liquidations, auctioned per block, on Monad.`;
  return {
    title,
    description,
    openGraph: { title, description, images: [image] },
    twitter: { card: "summary_large_image", title, description, images: [image.url] },
  };
}

export default async function PnlSharePage(props: PageProps<"/pnl">) {
  const card = cardFrom(await props.searchParams);
  return (
    <div className={styles.page}>
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
              alt={`${card.symbol} ${card.side} closed ${fmtSignedPct(card.pnlPct)}. ${narration(card)}`}
            />
            <p className={styles.lede}>
              Closed on Paraclr, the perps clearinghouse where an underwater account goes to a per-block auction
              instead of the fastest bot, and the trader keeps the equity the taker isn&apos;t paid.
            </p>
          </>
        ) : (
          <p className={styles.lede}>This card link is incomplete.</p>
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
