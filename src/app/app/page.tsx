import type { Metadata } from "next";
import { connection } from "next/server";
import { AuthProvider } from "@/components/auth/AuthProvider";
import { ChainProvider } from "@/components/chain/ChainProvider";
import { AppShell } from "@/components/shell/AppShell";
import { CHAIN_MODE_ON, NETWORK } from "@/lib/chain/config";
import { readDeploymentJson, type DeploymentLoad } from "@/lib/chain/deployments.server";
import { readLatestXray } from "@/lib/chain/xray.server";

export const metadata: Metadata = {
  title: "Trading terminal",
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
    <AuthProvider>
      <ChainProvider deployment={deployment}>
        <AppShell recordedXray={recordedXray} />
      </ChainProvider>
    </AuthProvider>
  );
}
