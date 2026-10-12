import type React from "react";
import { loadVariableFont as loadArchivo } from "@remotion/google-fonts/Archivo";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";

/**
 * NetLayer Labs: netlayerlabs.com sets Archivo (variable width) on pure black and white,
 * with "/" section prefixes and "■" bullets. Display runs wide (font-stretch 112-125%) to sit
 * with the chrome wordmark; JetBrains Mono carries the small detail.
 */
export const display = loadArchivo("normal", { subsets: ["latin"] }).fontFamily;
export const mono = loadMono("normal", { weights: ["400", "500"], subsets: ["latin"] }).fontFamily;

/** Monochrome only. The one exception is Paraclr's own logo, and the founder's picture. */
export const C = {
  black: "#000000",
  chip: "#0B0B0B",
  white: "#FFFFFF",
  ink2: "#C9CBCF",
  muted: "#8A8C90",
  dim: "#55575B",
  line: "rgba(255,255,255,0.14)",
  hair: "rgba(255,255,255,0.08)",
  pill: "rgba(12,12,13,0.72)",
};

/** Text filled with a cool chrome ramp (a bright top edge, a dark horizon, a lit lower half). */
export const chromeText: React.CSSProperties = {
  backgroundImage: "linear-gradient(180deg, #FFFFFF 0%, #F2F3F5 30%, #A9ADB3 48%, #6F7378 52%, #DADDE1 72%, #FFFFFF 100%)",
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
  color: "transparent",
};
