import { renderOgImage } from "@/components/landing/ogImage";

export const alt =
  "Paraclr: fair liquidations, cleared every block. Per-block Dutch auctions in 8 lanes, backed by backstop LPs; traders keep their leftover equity.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return renderOgImage(size);
}
