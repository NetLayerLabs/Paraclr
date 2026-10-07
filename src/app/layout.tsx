import type { Metadata, Viewport } from "next";
import { NoticeScript } from "@/components/prod/notice";
import { Geist, Geist_Mono } from "next/font/google";
import { loadProductionStatus, loadTestnetProductionStatus } from "@/components/landing/production.server";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const SITE_TITLE = "Paraclr: the fair-liquidation clearinghouse for Monad";
const SITE_DESCRIPTION_BASE =
  "Every block, underwater accounts in each of 8 lanes go to a Dutch auction backed by per-lane backstop LPs, and " +
  "traders get their leftover equity back. Auction-priced by the block clock, not by gas bidding, with a measured " +
  "Conflict X-ray of every crash and a live solvency proof.";
// The status sentence follows deployments/143.json ("production": true), read at build time.
const STATUS_LIVE = "Capped, unaudited beta on Monad mainnet: use only what you can afford to lose.";
const STATUS_PENDING = "Testnet build for Monad Metropolis; the mainnet beta is pending its launch gate.";
// deployments/10143.json with "production": true.
const STATUS_TESTNET =
  "Production contracts live on Monad testnet (test funds, no real value); the mainnet beta is pending its launch gate.";

// Absolute base for OG/Twitter image URLs. Set NEXT_PUBLIC_SITE_URL (e.g.
// https://paraclr.example) on the host; unset, Next falls back to its default
// (localhost in dev, the Vercel URL on Vercel).
function siteUrl(): URL | undefined {
  const raw = process.env.NEXT_PUBLIC_SITE_URL;
  if (!raw) return undefined;
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}
const SITE_URL = siteUrl();

export async function generateMetadata(): Promise<Metadata> {
  const [{ live }, testnet] = await Promise.all([loadProductionStatus(), loadTestnetProductionStatus()]);
  const description = `${SITE_DESCRIPTION_BASE} ${live ? STATUS_LIVE : testnet.live ? STATUS_TESTNET : STATUS_PENDING}`;
  return {
    ...(SITE_URL ? { metadataBase: SITE_URL } : {}),
    title: { default: SITE_TITLE, template: "%s · Paraclr" },
    description,
    applicationName: "Paraclr",
    // Home-screen install on iOS (the manifest is src/app/manifest.ts; the icon
    // is src/app/apple-icon.png). "default" rather than "black-translucent":
    // /app has a light theme with a white header, under which a translucent
    // bar's white clock would vanish. Next emits only the standard
    // mobile-web-app-capable, so older iOS also gets the apple- prefixed one.
    appleWebApp: { capable: true, title: "Paraclr", statusBarStyle: "default" },
    other: { "apple-mobile-web-app-capable": "yes" },
    openGraph: {
      type: "website",
      siteName: "Paraclr",
      title: SITE_TITLE,
      description,
      locale: "en_US",
      ...(SITE_URL ? { url: SITE_URL } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title: SITE_TITLE,
      description,
    },
  };
}

export const viewport: Viewport = {
  themeColor: "#07060c",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  // suppressHydrationWarning: /app sets data-theme on <html> before hydration (shell/theme.tsx).
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <body>
        {/* Hides a closed testnet notice before the first paint (components/prod/notice.tsx). */}
        <NoticeScript />
        {children}
      </body>
    </html>
  );
}
