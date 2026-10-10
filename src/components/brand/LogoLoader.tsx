// Loading state in the brand's own motion: the Paraclr mark's 8 lanes draw in one after another
// (inner lane first), hold, then clear and go again - lanes settling independently. Replaces
// "Connecting to …" text while the app reaches the chain. Static mark under prefers-reduced-motion.

import { LANE_RADII, LANE_STROKE, TILE_RX, lanePath } from "@/components/landing/brand/Logo";
import styles from "./LogoLoader.module.css";

export function LogoLoader({ label, size = 72 }: { label: string; size?: number }) {
  return (
    <div className={styles.root} role="status" aria-live="polite">
      <svg className={styles.mark} width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <defs>
          <clipPath id="pc-loader-tile">
            <rect width="32" height="32" rx={TILE_RX} />
          </clipPath>
        </defs>
        <rect className={styles.tile} width="32" height="32" rx={TILE_RX} />
        <g clipPath="url(#pc-loader-tile)" stroke="#fff" strokeWidth={LANE_STROKE} strokeLinecap="round">
          {LANE_RADII.map((r, i) => (
            <path key={r} className={styles.lane} d={lanePath(r)} pathLength={100} style={{ animationDelay: `${i * 0.09}s` }} />
          ))}
        </g>
      </svg>
      <span className={styles.label}>{label}</span>
    </div>
  );
}
