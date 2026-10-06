import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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
const SITE_DESCRIPTION =
  "Every block, underwater accounts in each of 8 lanes go to a Dutch auction backed by per-lane backstop LPs, and " +
  "traders get their leftover equity back. Auction-priced by the block clock, not by gas bidding, with a measured " +
  "Conflict X-ray of every crash and a live solvency proof. Testnet build for Monad Metropolis.";

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

export const metadata: Metadata = {
  ...(SITE_URL ? { metadataBase: SITE_URL } : {}),
  title: { default: SITE_TITLE, template: "%s · Paraclr" },
  description: SITE_DESCRIPTION,
  applicationName: "Paraclr",
  openGraph: {
    type: "website",
    siteName: "Paraclr",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    locale: "en_US",
    ...(SITE_URL ? { url: SITE_URL } : {}),
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: "#07060c",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
