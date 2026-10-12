import { loadFont as loadSora } from "@remotion/google-fonts/Sora";
import { loadFont as loadMono } from "@remotion/google-fonts/GeistMono";
import { loadFont as loadSerif } from "@remotion/google-fonts/Newsreader";

/** Paraclr's display face (the landing's Sora), the app's mono (Geist Mono), and one italic serif accent. */
export const sora = loadSora("normal", { weights: ["300", "400", "500", "600", "700", "800"], subsets: ["latin"] }).fontFamily;
export const mono = loadMono("normal", { weights: ["400", "500"], subsets: ["latin"] }).fontFamily;
export const serif = loadSerif("italic", { weights: ["400", "500"], subsets: ["latin"] }).fontFamily;

/** Paraclr palette, from src/components/landing/brand/tokens.ts. */
export const C = {
  accent: "#6E54FF",
  accentStrong: "#5A3FF2",
  accentInkDark: "#A898FF",
  accentSoft: "#F1EEFF",
  // light
  white: "#FFFFFF",
  paper: "#F6F6F9",
  line: "#E9E8F0",
  ink: "#0B0A12",
  ink2: "#45434F",
  ink3: "#6B6979",
  display2: "#8B8996",
  // dark
  night: "#08070D",
  surface: "#111019",
  dInk: "#F5F4FA",
  dInk2: "#B6B3C6",
  dInk3: "#8E8AA2",
  dDisplay2: "#77748A",
  pos: "#0E9F6E",
  posDark: "#3DDC97",
  neg: "#E5484D",
  negDark: "#FF5C7A",
  warn: "#B45309",
  warnDark: "#FFB547",
};

export type Tone = "light" | "dark" | "violet";
export const TONE: Record<Tone, { bg: string; ink: string; ink2: string; muted: string; line: string; accent: string; pill: string }> = {
  light: { bg: C.paper, ink: C.ink, ink2: C.ink2, muted: C.ink3, line: "rgba(11,10,18,0.10)", accent: C.accent, pill: "rgba(255,255,255,0.82)" },
  dark: { bg: C.night, ink: C.dInk, ink2: C.dInk2, muted: C.dInk3, line: "rgba(255,255,255,0.08)", accent: C.accentInkDark, pill: "rgba(17,16,25,0.66)" },
  violet: { bg: C.accent, ink: "#FFFFFF", ink2: "rgba(255,255,255,0.86)", muted: "rgba(255,255,255,0.68)", line: "rgba(255,255,255,0.22)", accent: "#FFFFFF", pill: "rgba(40,22,140,0.42)" },
};

export const SCENE_TONE: Record<string, Tone> = {
  open: "dark", problem: "light", turn: "light", clock: "light", lanes: "violet", app: "dark",
  arena: "dark", kept: "violet", xray: "dark", builton: "light", close: "dark",
  // technical demo
  tsignin: "dark", tfund: "dark", topen: "dark", tclose: "dark", tchain: "dark", tclearing: "dark", tbackstop: "dark", txray: "dark",
  // promo
  pmontage: "dark", pproof: "violet",
};

export const SCENE_LABEL: Record<string, string> = {
  open: "01 · oct 2025", problem: "02 · the race", turn: "03 · paraclr", clock: "04 · the clock",
  lanes: "05 · eight lanes", app: "06 · live on testnet", arena: "07 · the arena", kept: "08 · what traders kept",
  xray: "09 · conflict x-ray", builton: "10 · built on", close: "11 · crash it yourself",
};

/** Scenes that show the product or measured proof: the testnet label stays on screen. */
export const TESTNET_SCENES = new Set(["clock", "lanes", "app", "arena", "kept", "xray", "builton", "close",
  "tsignin", "tfund", "topen", "tclose", "tchain", "tclearing", "tbackstop", "txray", "pmontage", "pproof"]);
