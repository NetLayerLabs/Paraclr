import React from "react";
import { useCurrentFrame } from "remotion";

/** Monospace typing: characters appear `cps` per frame from `at`, with a block caret while typing. */
export const Type: React.FC<{ text: string; at: number; cps?: number; caret?: boolean; style?: React.CSSProperties }> = ({ text, at, cps = 1.4, caret = true, style }) => {
  const f = useCurrentFrame();
  const n = Math.max(0, Math.min(text.length, Math.floor((f - at) * cps)));
  const typing = f >= at && (f - at) * cps < text.length + 8;
  return (
    <span style={{ whiteSpace: "pre", ...style }}>
      {text.slice(0, n)}
      {caret && typing && f >= at ? <span style={{ opacity: Math.floor(f / 4) % 2 ? 0.2 : 1 }}>▍</span> : null}
      <span style={{ opacity: 0 }}>{text.slice(n)}</span>
    </span>
  );
};
