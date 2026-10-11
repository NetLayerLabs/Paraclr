/* eslint-disable @next/next/no-img-element -- static brand artwork, sized by height; next/image adds nothing here */
import styles from "./ParaclrLogo.module.css";

/**
 * The Paraclr logo: the brand artwork (eight lanes into the gate, six out), never a redraw.
 * Files come from public/brand/paraclr-{logo,header}-source.png via `node scripts/brand-assets.mjs`
 * (transparent, 2x the largest display size):
 *   header = mark + wordmark lockup: paraclr-header-white-192.png on dark, -ink-192.png on light
 *   mark   = the mark alone:         paraclr-mark-128.png
 * `tone` picks the wordmark ink: "white" on dark, "ink" on light, "auto" follows the theme
 * (dark unless <html data-theme="light">). `height` is the rendered height in px.
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
  if (variant === "mark") {
    return (
      <span className={`${styles.logo} ${className ?? ""}`} style={{ height }}>
        <img className={styles.img} src="/brand/paraclr-mark-128.png" alt="Paraclr" height={height} width={Math.round(height * 0.984)} />
      </span>
    );
  }
  const width = Math.round(height * (680 / 192));
  return (
    <span className={`${styles.logo} ${className ?? ""}`} data-tone={tone} style={{ height }}>
      {tone !== "ink" && (
        <img className={`${styles.img} ${styles.white}`} src="/brand/paraclr-header-white-192.png" alt="Paraclr" height={height} width={width} />
      )}
      {tone !== "white" && (
        <img
          className={`${styles.img} ${styles.ink}`}
          src="/brand/paraclr-header-ink-192.png"
          alt={tone === "auto" ? "" : "Paraclr"}
          aria-hidden={tone === "auto" ? true : undefined}
          height={height}
          width={width}
        />
      )}
    </span>
  );
}
