import type { MetadataRoute } from "next";

// Web app manifest (served at /manifest.webmanifest, linked from every page) so
// phones can install the trading app: "Install app" on Android Chrome, "Add to
// Home Screen" on iOS Safari (which also reads appleWebApp in layout.tsx).
// Deliberately no service worker: offline caching could show stale trading data,
// and Chrome no longer needs one to offer the install.
// Icons in public/icons/ come from the brand artwork: icon-192/512 are the app
// icon (src/app/icon.png); the maskable one is full-bleed with the mark inside
// the central 80% safe zone, for Android's circle and squircle masks.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/app",
    name: "Paraclr",
    short_name: "Paraclr",
    description:
      "Fair-liquidation perps clearinghouse on Monad: per-block auctions, per-lane backstops, live solvency proof.",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#08070D",
    theme_color: "#08070D",
    categories: ["finance"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
