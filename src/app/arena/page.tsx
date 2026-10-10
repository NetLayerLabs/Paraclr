import type { Metadata } from "next";
import { ArenaPage } from "@/components/arena/ArenaPage";

export const metadata: Metadata = {
  title: "Arena",
  description:
    "Crash the market yourself: one oracle shock on the Paraclr demo stack on Monad testnet, per-block Dutch auctions in 8 " +
    "lanes next to a naive shared-state baseline, and the Conflict X-ray of the actual transactions. Test funds only.",
};

export default function Page() {
  return <ArenaPage />;
}
