// Brand display face for the landing page and /terms, /risk only.
//
// Loaded here (not in app/layout.tsx) so the trading app at /app never
// downloads or preloads it: next/font scopes a font to the routes whose
// modules import it. It only defines the CSS variable --font-pc-display on the
// element that carries `displayFont.variable`; nothing picks it up unless a
// brand stylesheet asks for var(--pc-font-display). See docs/DESIGN.md.
//
// Sora: geometric, heavy at 800, compact enough that big headlines still fit
// at 360px, crisp numerals. Variable font (100–800), one file.
import { Sora } from "next/font/google";

export const displayFont = Sora({
  subsets: ["latin"],
  variable: "--font-pc-display",
  display: "swap",
});
