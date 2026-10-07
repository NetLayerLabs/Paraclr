import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { loadProductionStatus } from "@/components/landing/production.server";
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
  const { live } = await loadProductionStatus();
  const description = `${SITE_DESCRIPTION_BASE} ${live ? STATUS_LIVE : STATUS_PENDING}`;
  return {
    ...(SITE_URL ? { metadataBase: SITE_URL } : {}),
    title: { default: SITE_TITLE, template: "%s · Paraclr" },
    description,
    applicationName: "Paraclr",
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
      <body>{children}</body>
    </html>
  );
}
