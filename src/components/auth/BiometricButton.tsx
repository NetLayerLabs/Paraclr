"use client";

import styles from "./LoginScreen.module.css";

export type BiometricPhase = "idle" | "scanning" | "success" | "error";

/** Face ID glyph: corner brackets, eyes, nose and mouth, plus a scan beam. */
function FaceGlyph({ phase }: { phase: BiometricPhase }) {
  return (
    <svg className={styles.glyph} data-phase={phase} viewBox="0 0 64 64" aria-hidden="true">
      <g className={styles.brackets} fill="none" strokeWidth="3.5" strokeLinecap="round">
        <path d="M4 20V12a8 8 0 0 1 8-8h8" />
        <path d="M44 4h8a8 8 0 0 1 8 8v8" />
        <path d="M60 44v8a8 8 0 0 1-8 8h-8" />
        <path d="M20 60h-8a8 8 0 0 1-8-8v-8" />
      </g>
      {phase === "success" ? (
        <path className={styles.check} d="M20 33l8 8 16-18" fill="none" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <g className={styles.face} fill="none" strokeWidth="3.5" strokeLinecap="round">
          <path d="M22 23v5" />
          <path d="M42 23v5" />
          <path d="M33 23v12h-3" />
          <path d="M23 43c5 5 13 5 18 0" />
        </g>
      )}
      {phase === "scanning" && <rect className={styles.beam} x="6" y="8" width="52" height="3" rx="1.5" />}
    </svg>
  );
}

export function BiometricButton({
  phase,
  label,
  disabled,
  onClick,
}: {
  phase: BiometricPhase;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  const text =
    phase === "scanning" ? "Scanning…" : phase === "success" ? "Verified" : phase === "error" ? "Try again" : label;
  return (
    <button className={styles.passkeyBtn} data-phase={phase} disabled={disabled} onClick={onClick}>
      <span className={styles.glyphWrap} data-phase={phase}>
        <FaceGlyph phase={phase} />
      </span>
      <span className={styles.passkeyText}>
        <span className={styles.passkeyLabel}>{text}</span>
        <span className={styles.passkeySub}>Face ID · Touch ID · Windows Hello · fingerprint</span>
      </span>
    </button>
  );
}
