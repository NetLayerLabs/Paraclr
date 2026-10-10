import { Mark } from "@/components/landing/brand/Logo";
import styles from "./ParaclrLogo.module.css";

/**
 * The Paraclr lockup: the vector mark (landing/brand/Logo.tsx, 8 lanes round one corner) plus
 * "Paraclr" in the display face (Sora 800, --font-pc-display; the route loads it via
 * landing/brand/fonts.ts). Crisp at every density, no raster.
 *
 * `tone` only sets the wordmark's ink: "white" on dark, "ink" on light, "auto" follows the app
 * theme (--text). The mark is always the brand tile. Height is the mark's size in px; the
 * wordmark scales with it.
 */
export function ParaclrLogo({
  tone,
  variant = "header",
  height = 28,
  className,
}: {
  tone: "ink" | "white" | "auto";
  /** "header" = mark + wordmark lockup; "mark" = the mark alone (tight spaces). */
  variant?: "header" | "mark";
  height?: number;
  className?: string;
}) {
  return (
    <span
      className={`${styles.logo} ${className ?? ""}`}
      data-tone={tone}
      style={{ height, fontSize: Math.round(height * 0.71 * 10) / 10 }}
    >
      <Mark className={styles.mark} />
      {variant === "header" ? (
        <span className={styles.word} aria-hidden="true">
          Paraclr
        </span>
      ) : null}
      <span className={styles.sr}>Paraclr</span>
    </span>
  );
}
