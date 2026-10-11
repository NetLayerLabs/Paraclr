import React from "react";
import { Img, staticFile } from "remotion";

/**
 * The real Paraclr artwork (public/brand masters, made transparent by scripts/brand.mjs,
 * never redrawn). `tone` picks the wordmark colour: ink for light scenes, white for dark.
 */
export const Lockup: React.FC<{ height: number; tone?: "ink" | "white"; style?: React.CSSProperties }> = ({ height, tone = "ink", style }) => (
  <Img src={staticFile(`brand/header-${tone}.png`)} style={{ height, width: "auto", display: "block", ...style }} />
);
/** Lockup geometry, as a fraction of its box (header-*.png is 1575x445). */
export const LOCKUP_ASPECT = 1575 / 445;

export const Mark: React.FC<{ height: number; style?: React.CSSProperties }> = ({ height, style }) => (
  <Img src={staticFile("brand/mark.png")} style={{ height, width: "auto", display: "block", ...style }} />
);

/** Partner logos exactly as shipped in the app's public/partners/. */
export const PARTNER: Record<string, string> = {
  monad: "partners/monad.svg", agora: "partners/agora.svg", envio: "partners/envio.svg",
  privy: "partners/privy-white.png", pyth: "partners/pyth-white.png",
};
export const Partner: React.FC<{ id: keyof typeof PARTNER | string; size: number; style?: React.CSSProperties }> = ({ id, size, style }) => (
  <Img src={staticFile(PARTNER[id])} style={{ width: size, height: size, objectFit: "contain", display: "block", ...style }} />
);
