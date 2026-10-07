// Paraclr brand palette for code that can't read CSS custom properties
// (next/og social cards, generated icons). Mirrors brand/Brand.module.css;
// docs/DESIGN.md is the source of truth for both.

export const BRAND = {
  accent: "#6E54FF", // Monad-purple family. White text on it: 4.8:1. On white: 4.8:1.
  accentStrong: "#5A3FF2", // hover / pressed; accent text on light
  accentInkDark: "#A898FF", // accent text on dark: 8:1 on #08070D
  accentSoft: "#F1EEFF",

  light: {
    bg: "#FFFFFF",
    subtle: "#F6F6F9",
    line: "#E9E8F0",
    ink: "#0B0A12",
    ink2: "#45434F",
    ink3: "#6B6979",
    display2: "#8B8996", // grey display sub-headline, large text only (3.5:1)
  },
  dark: {
    bg: "#08070D",
    surface: "#111019",
    line: "rgba(255,255,255,0.08)",
    ink: "#F5F4FA",
    ink2: "#B6B3C6",
    ink3: "#8E8AA2",
    display2: "#77748A",
  },

  pos: "#0E9F6E",
  posDark: "#3DDC97",
  neg: "#E5484D",
  negDark: "#FF5C7A",
  warn: "#B45309",
  warnDark: "#FFB547",
} as const;
