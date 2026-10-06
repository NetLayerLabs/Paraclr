// Social card for opengraph-image / twitter-image (next/og ImageResponse).
// Satori subset: flexbox only, inline styles, every multi-child div is flex.
// Uses next/og's bundled default font (Geist Regular), so no font files ship.

import { ImageResponse } from "next/og";

const STEP = 25;
const TAKE = 3; // 75 bps backstop threshold
const BARS = 11; // blocks +0 … +10
const BAR_MAX = 250; // bps at the top of the plot
const PLOT_H = 230;

function barColor(b: number): string {
  if (b === TAKE) return "#8f7bff";
  if (b < TAKE) return "#f6b04a";
  return "rgba(255,255,255,0.10)";
}

export function renderOgImage(size: { width: number; height: number }): ImageResponse {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          backgroundColor: "#07060c",
          backgroundImage:
            "radial-gradient(circle at 82% 30%, rgba(131,110,249,0.38) 0%, rgba(7,6,12,0) 55%), radial-gradient(circle at 0% 100%, rgba(61,220,151,0.10) 0%, rgba(7,6,12,0) 45%)",
          color: "#ecebf3",
          padding: "64px 72px",
        }}
      >
        {/* left: copy */}
        <div style={{ display: "flex", flexDirection: "column", width: 650, height: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                gap: 6,
                width: 52,
                height: 52,
                padding: "0 11px",
                borderRadius: 15,
                backgroundImage: "linear-gradient(135deg, #a898ff, #6f58f0)",
              }}
            >
              <div style={{ display: "flex", width: 30, height: 5, borderRadius: 3, backgroundColor: "#ffffff" }} />
              <div style={{ display: "flex", gap: 4 }}>
                <div style={{ display: "flex", width: 18, height: 5, borderRadius: 3, backgroundColor: "#ffffff" }} />
                <div style={{ display: "flex", width: 8, height: 5, borderRadius: 3, backgroundColor: "#3ddc97" }} />
              </div>
              <div style={{ display: "flex", width: 24, height: 5, borderRadius: 3, backgroundColor: "#ffffff" }} />
            </div>
            <div style={{ display: "flex", fontSize: 40, letterSpacing: -1.5 }}>Paraclr</div>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              marginTop: 44,
              fontSize: 66,
              lineHeight: 1.05,
              letterSpacing: -1,
            }}
          >
            <div style={{ display: "flex" }}>Fair liquidations,</div>
            <div style={{ display: "flex", color: "#a898ff" }}>cleared every block.</div>
          </div>

          <div style={{ display: "flex", marginTop: 24, fontSize: 26, lineHeight: 1.4, color: "#b9b5cc" }}>
            Per-block Dutch auctions in 8 lanes, backed by backstop LPs. Traders keep the equity the auction doesn&rsquo;t
            use.
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: "auto" }}>
            {["Testnet build", "Monad Metropolis", "Conflict X-ray", "Solvency proof"].map((t) => (
              <div
                key={t}
                style={{
                  display: "flex",
                  flexShrink: 0,
                  padding: "8px 14px",
                  borderRadius: 999,
                  border: "1px solid rgba(255,255,255,0.18)",
                  backgroundColor: "rgba(255,255,255,0.04)",
                  fontSize: 19,
                  color: "#d4ccff",
                }}
              >
                {t}
              </div>
            ))}
          </div>
        </div>

        {/* right: discount staircase */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignSelf: "center",
            marginLeft: "auto",
            width: 330,
            padding: 24,
            borderRadius: 24,
            border: "1px solid rgba(255,255,255,0.14)",
            backgroundColor: "rgba(20,17,42,0.85)",
          }}
        >
          <div style={{ display: "flex", fontSize: 17, color: "#8d89a3" }}>discount · +25 bps / block</div>
          <div
            style={{
              display: "flex",
              position: "relative",
              alignItems: "flex-end",
              gap: 6,
              height: PLOT_H,
              marginTop: 18,
              borderBottom: "1px solid rgba(255,255,255,0.2)",
            }}
          >
            <div
              style={{
                display: "flex",
                position: "absolute",
                left: 0,
                right: 0,
                bottom: (75 / BAR_MAX) * PLOT_H,
                height: 0,
                borderTop: "2px dashed rgba(168,152,255,0.9)",
              }}
            />
            <div
              style={{
                display: "flex",
                position: "absolute",
                left: 0,
                bottom: (75 / BAR_MAX) * PLOT_H + 8,
                fontSize: 15,
                color: "#d4ccff",
              }}
            >
              backstop min · 75 bps
            </div>
            {Array.from({ length: BARS }, (_, b) => (
              <div
                key={b}
                style={{
                  display: "flex",
                  flexGrow: 1,
                  height: Math.max(3, ((b * STEP) / BAR_MAX) * PLOT_H),
                  borderRadius: "4px 4px 0 0",
                  backgroundColor: barColor(b),
                }}
              />
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, fontSize: 15, color: "#8d89a3" }}>
            <div style={{ display: "flex" }}>+0</div>
            <div style={{ display: "flex" }}>blocks since start</div>
            <div style={{ display: "flex" }}>+10</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 18, fontSize: 18 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#d4ccff" }}>
              <div style={{ display: "flex", width: 12, height: 12, borderRadius: 3, backgroundColor: "#8f7bff" }} />
              lane backstop takes
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#9fe9c8" }}>
              <div style={{ display: "flex", width: 12, height: 12, borderRadius: 3, backgroundColor: "#3ddc97" }} />
              trader keeps E − P
            </div>
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
