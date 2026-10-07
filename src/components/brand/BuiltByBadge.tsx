import styles from "./BuiltByBadge.module.css";

const HREF = "https://github.com/NetLayerLabs";

const srcSet = (tone: "white" | "ink") =>
  `/brand/netlayer-mark-${tone}-32.png 1x, /brand/netlayer-mark-${tone}-64.png 2x, /brand/netlayer-mark-${tone}-128.png 4x`;

/**
 * "Built by NetLayer Labs" pill. `tone="auto"` follows the app theme
 * (white mark on dark, ink mark when <html data-theme="light">); `tone="dark"`
 * is for surfaces that are always dark (the landing footer).
 */
export function BuiltByBadge({ tone = "auto", className }: { tone?: "auto" | "dark"; className?: string }) {
  return (
    <a
      href={HREF}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Built by NetLayer Labs"
      className={`${styles.badge} ${className ?? ""}`}
      data-tone={tone}
    >
      {/* Pre-sized transparent PNGs; srcSet picks the density, so next/image adds nothing here. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className={styles.markWhite} src="/brand/netlayer-mark-white-32.png" srcSet={srcSet("white")} width={18} height={18} alt="" />
      {tone === "auto" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={styles.markInk} src="/brand/netlayer-mark-ink-32.png" srcSet={srcSet("ink")} width={18} height={18} alt="" />
      )}
      <span className={styles.text}>
        Built by <strong>NetLayer Labs</strong>
      </span>
    </a>
  );
}
