// The PnL card image (1200 × 630 PNG) for a closed position: GET /api/pnl-card?<cardQuery>.
// The app shows it when a position closes; the share page (/pnl) uses it as its Open Graph and X
// image, so a shared link previews as the card. Satori subset: flexbox only, inline styles, every
// multi-child div is flex. Fonts: the brand's static Sora instances.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { BRAND } from "@/components/landing/brand/tokens";
import { LANE_RADII, lanePath } from "@/components/landing/brand/Logo";
import { fmtPenaltyPct } from "@/lib/kept";
import {
  fmtPrice,
  keptStrip,
  fmtSignedAusd,
  fmtSignedPct,
  MOOD_TITLE,
  moodOf,
  narration,
  gateCardNetwork,
  NETWORK_TAG,
  parseCard,
} from "@/lib/pnlCard";
import { loadProductionStatus } from "@/components/landing/production.server";

const FONT_DIR = join(process.cwd(), "src", "components", "landing", "brand", "fonts");
const LOGO = join(process.cwd(), "public", "brand", "paraclr-header-white-96.png");

let assets: Promise<{ extraBold: Buffer; semiBold: Buffer; logo: string }> | null = null;
function loadAssets() {
  assets ??= Promise.all([
    readFile(join(FONT_DIR, "Sora-ExtraBold.ttf")),
    readFile(join(FONT_DIR, "Sora-SemiBold.ttf")),
    readFile(LOGO),
  ]).then(([extraBold, semiBold, logo]) => ({
    extraBold,
    semiBold,
    logo: `data:image/png;base64,${logo.toString("base64")}`,
  }));
  return assets;
}

/** The brand's 8 lanes, large, in the card's corner. */
function Lanes({ color }: { color: string }) {
  return (
    <svg width="520" height="520" viewBox="0 0 32 32" fill="none" style={{ position: "absolute", right: -150, bottom: -170 }}>
      <g stroke={color} strokeWidth={0.42} opacity={0.55}>
        {LANE_RADII.map((r) => (
          <path key={r} d={lanePath(r)} />
        ))}
      </g>
    </svg>
  );
}

export async function GET(req: Request): Promise<Response> {
  const parsed = parseCard(new URL(req.url).searchParams);
  if (!parsed) return new Response("Not a PnL card", { status: 400 });
  const card = gateCardNetwork(parsed, (await loadProductionStatus()).live);
  const { extraBold, semiBold, logo } = await loadAssets();

  const up = card.pnl >= 0;
  const tone = up ? BRAND.posDark : BRAND.negDark;
  const mood = moodOf(card.pnlPct);
  const base = card.symbol.replace("/AUSD", "");
  const D = BRAND.dark;
  // A position that ended in a liquidation auction: the strip below the trade, and a tighter layout.
  const kept = card.kept;
  const auctioned = kept !== undefined;
  const keptUp = auctioned && kept > -0.005;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          position: "relative",
          padding: "52px 64px",
          background: `radial-gradient(circle at 18% 0%, ${up ? "rgba(61,220,151,0.16)" : "rgba(255,92,122,0.16)"} 0%, rgba(8,7,13,0) 55%), ${D.bg}`,
          color: D.ink,
          fontFamily: "Sora",
          overflow: "hidden",
        }}
      >
        <Lanes color={BRAND.accent} />

        {/* top: logo + network */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logo} width={168} height={48} alt="" />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              padding: "10px 18px",
              borderRadius: 999,
              border: `1px solid ${D.line}`,
              background: "rgba(255,255,255,0.04)",
              fontSize: 20,
              fontWeight: 600,
              color: D.ink2,
            }}
          >
            {NETWORK_TAG[card.network]}
          </div>
        </div>

        <div style={{ display: "flex", flex: 1, marginTop: auctioned ? 22 : 34 }}>
          {/* left: the trade */}
          <div style={{ display: "flex", flexDirection: "column", width: 640 }}>
            <div style={{ display: "flex", alignItems: "center" }}>
              <div style={{ fontSize: 46, fontWeight: 800, letterSpacing: -1.5 }}>{`${base}-PERP`}</div>
              <div
                style={{
                  display: "flex",
                  marginLeft: 18,
                  padding: "6px 16px",
                  borderRadius: 10,
                  fontSize: 22,
                  fontWeight: 800,
                  color: card.side === "long" ? BRAND.posDark : BRAND.negDark,
                  background: card.side === "long" ? "rgba(61,220,151,0.14)" : "rgba(255,92,122,0.14)",
                }}
              >
                {card.side === "long" ? "LONG" : "SHORT"}
              </div>
              <div
                style={{
                  display: "flex",
                  marginLeft: 10,
                  padding: "6px 14px",
                  borderRadius: 10,
                  fontSize: 22,
                  fontWeight: 800,
                  color: BRAND.accentInkDark,
                  background: "rgba(110,84,255,0.18)",
                }}
              >
                {`${card.leverage.toLocaleString("en-US", { maximumFractionDigits: 1 })}x`}
              </div>
            </div>

            <div
              style={{
                display: "flex",
                fontSize: auctioned ? 118 : 148,
                fontWeight: 800,
                letterSpacing: auctioned ? -5 : -6,
                lineHeight: 1,
                marginTop: auctioned ? 18 : 26,
                color: tone,
              }}
            >
              {fmtSignedPct(card.pnlPct)}
            </div>
            <div style={{ display: "flex", fontSize: auctioned ? 30 : 36, fontWeight: 600, marginTop: auctioned ? 10 : 14, color: tone }}>
              {`${fmtSignedAusd(card.pnl)} AUSD`}
            </div>

            <div style={{ display: "flex", marginTop: auctioned ? 22 : 34, fontSize: 24, fontWeight: 600, color: D.ink3 }}>
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div style={{ display: "flex", fontSize: 17, letterSpacing: 2 }}>ENTRY</div>
                <div style={{ display: "flex", color: D.ink, marginTop: 6 }}>{fmtPrice(card.entry)}</div>
              </div>
              <div style={{ display: "flex", alignItems: "flex-end", margin: "0 26px 2px", color: D.ink3 }}>→</div>
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div style={{ display: "flex", fontSize: 17, letterSpacing: 2 }}>EXIT</div>
                <div style={{ display: "flex", color: D.ink, marginTop: 6 }}>{fmtPrice(card.exit)}</div>
              </div>
            </div>
          </div>

          {/* right: the meme */}
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", width: 420, paddingLeft: 24 }}>
            <div style={{ display: "flex", fontSize: 18, fontWeight: 800, letterSpacing: 3, color: tone }}>
              {MOOD_TITLE[mood].toUpperCase()}
            </div>
            <div
              style={{
                display: "flex",
                marginTop: 14,
                padding: "26px 28px",
                borderRadius: 22,
                border: `1px solid ${D.line}`,
                background: "rgba(17,16,25,0.86)",
                fontSize: 31,
                fontWeight: 600,
                lineHeight: 1.3,
                color: D.ink,
              }}
            >
              {`“${narration(card)}”`}
            </div>
          </div>
        </div>

        {/* liquidation auction: what the trader kept vs the fixed-penalty liquidation */}
        {auctioned && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              alignSelf: "flex-start",
              marginBottom: 18,
              padding: "12px 22px",
              borderRadius: 14,
              border: `1px solid ${keptUp ? "rgba(61,220,151,0.4)" : "rgba(255,181,71,0.4)"}`,
              background: keptUp ? "rgba(61,220,151,0.12)" : "rgba(255,181,71,0.1)",
              fontSize: 26,
              fontWeight: 800,
              color: keptUp ? BRAND.posDark : BRAND.warnDark,
            }}
          >
            <div style={{ display: "flex", fontSize: 17, letterSpacing: 2, marginRight: 16, color: D.ink3 }}>
              LIQUIDATED BY AUCTION
            </div>
            <div style={{ display: "flex" }}>{keptStrip(kept, fmtPenaltyPct())}</div>
          </div>
        )}

        {/* footer */}
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 19, fontWeight: 600, color: D.ink3 }}>
          <div style={{ display: "flex" }}>Fair liquidations, auctioned per block · paraclr.xyz</div>
          <div style={{ display: "flex" }}>
            {new Date(card.at * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC"}
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      fonts: [
        { name: "Sora", data: extraBold, weight: 800, style: "normal" },
        { name: "Sora", data: semiBold, weight: 600, style: "normal" },
      ],
      // A card's query fully determines its image.
      headers: { "Cache-Control": "public, max-age=86400, immutable" },
    },
  );
}
