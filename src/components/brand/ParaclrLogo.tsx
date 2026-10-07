import styles from "./ParaclrLogo.module.css";

/** Aspect (width / height) of the cropped images in /brand. */
const ASPECT = { header: 3.502, mark: 1.293 } as const;

type Variant = keyof typeof ASPECT;

const srcSet = (variant: Variant, tone: "ink" | "white") =>
  [32, 64, 96].map((h, i) => `/brand/paraclr-${variant}-${tone}-${h}.png ${i + 1}x`).join(", ");

/**
 * The Paraclr lockup (mark + wordmark) as a transparent image. `tone="ink"` for
 * light surfaces, `"white"` for dark ones, `"auto"` follows the app theme
 * (white by default, ink when <html data-theme="light">). Height is set in CSS
 * through the className (width follows the aspect ratio).
 */
export function ParaclrLogo({
  tone,
  variant = "header",
  height = 28,
  className,
}: {
  tone: "ink" | "white" | "auto";
  /** "header" = mark + wordmark lockup; "mark" = the mark alone (tight spaces). */
  variant?: Variant;
  height?: number;
  className?: string;
}) {
  const width = Math.round(height * ASPECT[variant]);
  const img = (t: "ink" | "white", cls: string) => (
    // Pre-sized transparent PNGs; srcSet picks the density, so next/image adds nothing here.
    // eslint-disable-next-line @next/next/no-img-element
    <img className={cls} src={`/brand/paraclr-${variant}-${t}-32.png`} srcSet={srcSet(variant, t)} width={width} height={height} alt="" />
  );
  return (
    <span className={`${styles.logo} ${className ?? ""}`} data-tone={tone} style={{ height }}>
      {tone === "auto" ? (
        <>
          {img("white", styles.white)}
          {img("ink", styles.ink)}
        </>
      ) : (
        img(tone, styles.single)
      )}
      <span className={styles.sr}>Paraclr</span>
    </span>
  );
}
