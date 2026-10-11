import type { Viewport } from "next";
import { Auction } from "@/components/landing/Auction";
import { loadLandingEvidence } from "@/components/landing/benchResults.server";
import { Bend } from "@/components/landing/brand/Bend";
import { displayFont } from "@/components/landing/brand/fonts";
import { BuiltOn } from "@/components/landing/BuiltOn";
import { NAV_LINKS } from "@/components/landing/content";
import { Faq } from "@/components/landing/Faq";
import { FinalCta, Footer } from "@/components/landing/FinalCta";
import { Hero } from "@/components/landing/Hero";
import { Nav } from "@/components/landing/Nav";
import { Problem } from "@/components/landing/Problem";
import { StatusBar } from "@/components/landing/StatusBar";
import { loadProductionStatus, loadTestnetProductionStatus } from "@/components/landing/production.server";
import { Results } from "@/components/landing/Results";
import { XRay } from "@/components/landing/XRay";
import b from "@/components/landing/brand/Brand.module.css";

// The landing page opens on a light hero, so the browser chrome matches it.
export const viewport: Viewport = { themeColor: "#ffffff" };

// Marketing landing page. The trading app lives at /app (src/app/app/page.tsx).
// No request-time APIs here, so the page is prerendered at build time; the
// evidence (bench/results/*.json, bench/xray/*.json, deployments/10143.json)
// and the production status (deployments/143.json for mainnet,
// deployments/10143.json for testnet, each only with "production": true) are
// read during that render. A new deployment file shows up on the next build.
//
// Brand system (tokens, type, the lane bends): src/components/landing/brand/
// and docs/DESIGN.md. Light and dark sections alternate, joined by <Bend />.
export default async function Home() {
  const [evidence, production, testnetProd] = await Promise.all([
    loadLandingEvidence(),
    loadProductionStatus(),
    loadTestnetProductionStatus(),
  ]);
  const live = production.live;
  // The demo stack on Monad testnet (deployments/10143.json without "production": true).
  const testnet = evidence.monadDeployment !== null;
  // The production contracts on Monad testnet (deployments/10143.json with "production": true).
  const testnetLive = testnetProd.live;

  return (
    <div className={`${b.root} ${displayFont.variable}`}>
      <a href="#main" className={b.skip}>
        Skip to content
      </a>
      <StatusBar status={production} testnet={testnetProd} testnetDeployed={testnet} />
      <Nav links={NAV_LINKS} />
      <main id="main">
        <Hero live={live} testnetLive={testnetLive} repo={evidence.repo} xray={evidence.xray} />
        <Bend into="dark" corner="right" />
        <Problem live={live} testnetLive={testnetLive} />
        <Bend into="light" corner="left" />
        <Auction live={live} testnetLive={testnetLive} />
        <Bend into="dark" corner="right" />
        <XRay xray={evidence.xray} />
        <Bend into="light" corner="left" />
        <Results evidence={evidence} production={production} testnet={testnetProd} />
        <Bend into="dark" corner="right" />
        <BuiltOn live={live} testnet={testnet} testnetLive={testnetLive} />
        <Faq monadDeployed={testnet} production={production} testnetProd={testnetProd} />
        <FinalCta live={live} testnetLive={testnetLive} />
      </main>
      <Footer live={live} />
    </div>
  );
}
