// Social card for opengraph-image / twitter-image (next/og ImageResponse).
// Satori subset: flexbox only, inline styles, every multi-child div is flex.
// Fonts: static Sora instances (OFL, brand/fonts/) - Satori can't read woff2
// or variable fonts. Colours come from brand/tokens.ts.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { BRAND } from "./brand/tokens";
import { LANE_RADII, LANE_STROKE, TILE_RX, lanePath } from "./brand/Logo";
import { AUCTION, TESTNET_AUCTION_STEP_BPS } from "./content";

const FONT_DIR = join(process.cwd(), "src", "components", "landing", "brand", "fonts");

let fonts: Promise<[Buffer, Buffer]> | null = null;
function loadFonts(): Promise<[Buffer, Buffer]> {
  fonts ??= Promise.all([
    readFile(join(FONT_DIR, "Sora-ExtraBold.ttf")),
    readFile(join(FONT_DIR, "Sora-SemiBold.ttf")),
  ]);
  return fonts;
}

function MarkSvg({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <clipPath id="og-tile">
          <rect width="32" height="32" rx={TILE_RX} />
        </clipPath>
      </defs>
      <rect width="32" height="32" rx={TILE_RX} fill={BRAND.accent} />
      <g clipPath="url(#og-tile)" stroke="#FFFFFF" strokeWidth={LANE_STROKE}>
        {LANE_RADII.map((r) => (
          <path key={r} d={lanePath(r)} />
        ))}
      </g>
    </svg>
  );
}

const W = 1200;
const H = 630;
const EDGE = 780; // right edge of the light block
const R = 250; // its top-right corner radius
const D = 15; // lane pitch

/**
 * `live`: the mainnet beta is deployed (deployments/143.json with "production": true).
 * `testnetLive`: the production contracts are on Monad testnet (deployments/10143.json, "production": true).
 */
export async function renderOgImage(
  size: { width: number; height: number },
  live = false,
  testnetLive = false,
): Promise<ImageResponse> {
  const [extraBold, semiBold] = await loadFonts();
  const status = live
    ? { text: "Live on Monad mainnet · capped", dot: BRAND.posDark, fg: "#0B4D35", bg: "#E8F7F0", line: "#BCE9D4" }
    : testnetLive
      ? { text: "Live on Monad testnet · test funds", dot: BRAND.posDark, fg: "#0B4D35", bg: "#E8F7F0", line: "#BCE9D4" }
      : { text: "Mainnet beta: launch pending", dot: "#F59E0B", fg: "#7A4605", bg: "#FEF6E7", line: "#F6DCAA" };
  const audit = live ? "Unaudited beta" : "Not audited";

  // The auction step: the live testnet deployment runs 5 bps per block (set through the
  // timelock on 2026-10-08); everywhere else the contract default from content.ts.
  const stepBps = testnetLive && !live ? TESTNET_AUCTION_STEP_BPS : AUCTION.stepBps;

  const stats = [
    { k: "8", v: "lanes, lane-local storage" },
    { k: `+${stepBps} bps`, v: "discount per block" },
    { k: "E − P", v: "back to the trader" },
  ];

  return new ImageResponse(
    <div
      style={{ width: "100%", height: "100%", display: "flex", position: "relative", backgroundColor: BRAND.dark.bg }}
    >
      {/* Lanes following the light block's curve, on the dark side. */}
      {Array.from({ length: 8 }, (_, i) => {
        const k = i + 1;
        return (
          <div
            key={k}
            style={{
              display: "flex",
              position: "absolute",
              left: -10,
              top: -k * D,
              width: EDGE + k * D + 10,
              height: H + k * D + 20,
              borderTop: "2px solid #8F7CFF",
              borderRight: "2px solid #8F7CFF",
              borderTopRightRadius: R + k * D,
              opacity: 0.8 - k * 0.075,
            }}
          />
        );
      })}

      {/* Light block */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          position: "absolute",
          left: 0,
          top: 0,
          width: EDGE,
          height: H,
          padding: "60px 0 56px 72px",
          backgroundColor: "#FFFFFF",
          borderTopRightRadius: R,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <MarkSvg size={54} />
          <div
            style={{
              display: "flex",
              fontFamily: "Sora",
              fontWeight: 800,
              fontSize: 40,
              letterSpacing: -1.8,
              color: BRAND.light.ink,
            }}
          >
            Paraclr
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", marginTop: 54 }}>
          <div
            style={{
              display: "flex",
              fontFamily: "Sora",
              fontWeight: 800,
              fontSize: 86,
              lineHeight: 1,
              letterSpacing: -4.3,
              color: BRAND.light.ink,
            }}
          >
            Liquidations,
          </div>
          <div style={{ display: "flex", alignItems: "center", marginTop: 6 }}>
            <div
              style={{
                display: "flex",
                fontFamily: "Sora",
                fontWeight: 800,
                fontSize: 86,
                lineHeight: 1,
                letterSpacing: -4.3,
                color: BRAND.accent,
              }}
            >
              auctioned.
            </div>
            <div
              style={{
                display: "flex",
                width: 6,
                height: 70,
                marginLeft: 14,
                borderRadius: 3,
                backgroundColor: BRAND.accent,
              }}
            />
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 22,
              fontFamily: "Sora",
              fontWeight: 800,
              fontSize: 32,
              letterSpacing: -1.3,
              color: BRAND.light.display2,
            }}
          >
            Priced by the block, not the gas race.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: "auto" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 18px",
              borderRadius: 999,
              border: `1.5px solid ${status.line}`,
              backgroundColor: status.bg,
              fontFamily: "Sora",
              fontWeight: 600,
              fontSize: 19,
              color: status.fg,
            }}
          >
            <div style={{ display: "flex", width: 10, height: 10, borderRadius: 5, backgroundColor: status.dot }} />
            {status.text}
          </div>
          <div
            style={{
              display: "flex",
              padding: "10px 18px",
              borderRadius: 999,
              border: `1.5px solid ${BRAND.light.line}`,
              fontFamily: "Sora",
              fontWeight: 600,
              fontSize: 19,
              color: BRAND.light.ink2,
            }}
          >
            {audit}
          </div>
        </div>
      </div>

      {/* Dark side: the mechanism in three numbers (contract defaults; the live testnet step). */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          position: "absolute",
          left: EDGE + 8 * D + 40,
          right: 56,
          bottom: 60,
          gap: 26,
        }}
      >
        {stats.map((st) => (
          <div key={st.k} style={{ display: "flex", flexDirection: "column" }}>
            <div
              style={{
                display: "flex",
                fontFamily: "Sora",
                fontWeight: 800,
                fontSize: 44,
                letterSpacing: -1.8,
                color: "#FFFFFF",
              }}
            >
              {st.k}
            </div>
            <div
              style={{
                display: "flex",
                marginTop: 2,
                fontFamily: "Sora",
                fontWeight: 600,
                fontSize: 16,
                color: BRAND.dark.ink3,
              }}
            >
              {st.v}
            </div>
          </div>
        ))}
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { name: "Sora", data: extraBold, weight: 800, style: "normal" },
        { name: "Sora", data: semiBold, weight: 600, style: "normal" },
      ],
    },
  );
}

export const OG_SIZE = { width: W, height: H };
