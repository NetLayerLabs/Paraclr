import { renderOgImage } from "@/components/landing/ogImage";
import { loadProductionStatus, loadTestnetProductionStatus } from "@/components/landing/production.server";

export const alt =
  "Paraclr: Liquidations, auctioned. Priced by the block, not the gas race. Per-block Dutch auctions in 8 lanes, backed by backstop LPs; the trader keeps E − P.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Tags follow deployments/143.json and deployments/10143.json ("production": true), read at build time.
export default async function Image() {
  const [{ live }, testnet] = await Promise.all([loadProductionStatus(), loadTestnetProductionStatus()]);
  return renderOgImage(size, live, testnet.live);
}
