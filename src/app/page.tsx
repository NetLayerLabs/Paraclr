import { Architecture } from "@/components/landing/Architecture";
import { Auction } from "@/components/landing/Auction";
import { Backstop } from "@/components/landing/Backstop";
import { loadLandingEvidence } from "@/components/landing/benchResults.server";
import { BuiltWith } from "@/components/landing/BuiltWith";
import { Faq } from "@/components/landing/Faq";
import { FinalCta, Footer } from "@/components/landing/FinalCta";
import { Hero } from "@/components/landing/Hero";
import { LaneMatrix } from "@/components/landing/LaneMatrix";
import { Nav } from "@/components/landing/Nav";
import { Problem } from "@/components/landing/Problem";
import { Proof } from "@/components/landing/Proof";
import { Results } from "@/components/landing/Results";
import { Solvency } from "@/components/landing/Solvency";
import { Terminal } from "@/components/landing/Terminal";
import { XRay } from "@/components/landing/XRay";
import ui from "@/components/landing/Landing.module.css";

// Marketing landing page. The trading app lives at /app (src/app/app/page.tsx).
// No request-time APIs here, so the page is prerendered at build time; the
// evidence (bench/results/*.json, bench/xray/*.json, deployments/10143.json)
// is read during that render.
export default async function Home() {
  const evidence = await loadLandingEvidence();
  const seeded = evidence.monadHeadline ?? evidence.anvilHeadline;

  return (
    <div className={ui.page}>
      <a href="#main" className={ui.skip}>
        Skip to content
      </a>
      <Nav />
      <main id="main">
        <Hero />
        <Problem />
        <Auction />
        <Backstop />
        <XRay xray={evidence.xray} />
        <Solvency repo={evidence.repo} />
        <LaneMatrix />
        <Proof seeded={seeded} repo={evidence.repo} />
        <Results evidence={evidence} />
        <Terminal replayRun={evidence.monadHeadline ?? evidence.anvilHeadline} />
        <Architecture deployment={evidence.monadDeployment} />
        <BuiltWith repo={evidence.repo} />
        <Faq monadDeployed={evidence.monadDeployment !== null} />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
