import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { AuthProvider } from "@/components/auth/AuthProvider";
import { ChainProvider } from "@/components/chain/ChainProvider";
import { AppShell } from "@/components/shell/AppShell";
import { CHAIN_MODE_ON, NETWORK } from "@/lib/chain/config";
import { readDeploymentJson, type DeploymentLoad } from "@/lib/chain/deployments.server";
import { readLatestXray } from "@/lib/chain/xray.server";
// Brand display face (Sora), scoped to this route: it only defines
// --font-pc-display on the wrapper below. See docs/DESIGN.md §10.
import { displayFont } from "@/components/landing/brand/fonts";
import { ThemeScript } from "@/components/shell/theme";

export const metadata: Metadata = {
  title: "Trading terminal",
};

// Browser chrome and the installed app's status bar match the header, which
// follows the OS theme until the viewer picks one (shell/theme.tsx): --header-bg
// is #08070d dark, white light. The landing keeps its own (src/app/page.tsx).
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#08070d" },
  ],
};

export default async function AppPage() {
  // Chain modes read deployments/<chainId>.json per request (so a fresh
  // deploy needs no rebuild). A missing file is fine: the client falls back to
  // NEXT_PUBLIC_*_ADDRESS env, then the keeper, then the simulation.
  // Sim mode (default) stays fully static, exactly as before.
  let deployment: DeploymentLoad | null = null;
  if (CHAIN_MODE_ON && NETWORK) {
    await connection();
    deployment = await readDeploymentJson(NETWORK.chainId);
  }
  // The latest recorded Conflict X-ray (bench/xray/*.json), shown until this
  // session runs its own crash. Sim mode reads it at build time.
  const recordedXray = await readLatestXray(NETWORK?.chainId ?? null);

  return (
    <>
      {/* Sets <html data-theme> before the first paint (stored choice, else the OS preference). */}
      <ThemeScript />
      <div className={displayFont.variable} style={{ display: "contents" }}>
        <AuthProvider>
          <ChainProvider deployment={deployment}>
            <AppShell recordedXray={recordedXray} />
          </ChainProvider>
        </AuthProvider>
      </div>
    </>
  );
}
