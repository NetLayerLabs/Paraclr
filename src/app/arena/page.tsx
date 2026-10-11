import type { Metadata } from "next";
import { ArenaPage } from "@/components/arena/ArenaPage";
import { displayFont } from "@/components/landing/brand/fonts";

const DESCRIPTION =
  "Crash the market yourself: one oracle shock on the Paraclr demo stack on Monad testnet, per-block Dutch auctions in 8 " +
  "lanes next to a naive shared-state baseline, and the Conflict X-ray of the actual transactions. Test funds only.";

export const metadata: Metadata = {
  title: "Arena",
  description: DESCRIPTION,
  openGraph: { type: "website", siteName: "Paraclr", title: "Arena · Paraclr", description: DESCRIPTION },
  twitter: { card: "summary_large_image", title: "Arena · Paraclr", description: DESCRIPTION },
};

export default function Page() {
  return (
    <div className={displayFont.variable}>
      <ArenaPage />
    </div>
  );
}
