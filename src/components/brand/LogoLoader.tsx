/* eslint-disable @next/next/no-img-element -- static brand artwork */
// Loading state with the brand artwork: a band of light runs through the mark's lanes and gate,
// left to right, like an order clearing. Replaces "Connecting to …" text while the app reaches the
// chain. Static mark under prefers-reduced-motion.

import styles from "./LogoLoader.module.css";

export function LogoLoader({ label, size = 88 }: { label: string; size?: number }) {
  return (
    <div className={styles.root} role="status" aria-live="polite">
      <span className={styles.mark} style={{ width: size, height: size }} aria-hidden="true">
        <img className={styles.base} src="/brand/paraclr-mark-128.png" alt="" width={size} height={size} />
        <img className={styles.sweep} src="/brand/paraclr-mark-128.png" alt="" width={size} height={size} />
      </span>
      <span className={styles.label}>{label}</span>
    </div>
  );
}
