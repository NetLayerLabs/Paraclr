import React from "react";
import { Img, staticFile } from "remotion";
import { mono } from "../theme";

/**
 * "Built by NetLayer Labs": the mark and wordmark lifted from NetLayer's own artwork
 * (public/brand/nl-mark.png, nl-word.png: white on transparent, scripts/netlayer.mjs), tinted for the scene.
 */
export const NetLayer: React.FC<{ height?: number; dark?: boolean; label?: boolean; labelColor?: string; style?: React.CSSProperties }> = ({ height = 22, dark = false, label = true, labelColor, style }) => {
  const tint: React.CSSProperties = dark ? { filter: "brightness(0)", opacity: 0.82 } : {};
  return (
    <div style={{ display: "flex", alignItems: "center", gap: height * 0.55, ...style }}>
      {label ? <span style={{ fontFamily: mono, fontSize: height * 0.6, letterSpacing: "0.12em", textTransform: "uppercase", color: labelColor }}>Built by</span> : null}
      <Img src={staticFile("brand/nl-mark.png")} style={{ height: height * 1.15, ...tint }} />
      <Img src={staticFile("brand/nl-word.png")} style={{ height, ...tint }} />
    </div>
  );
};
