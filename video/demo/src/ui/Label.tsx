import React from "react";
import { mono } from "../theme";

/** Small monospace label in the reference film's manner. */
export const Label: React.FC<{ children: React.ReactNode; color: string; style?: React.CSSProperties; dot?: string }> = ({ children, color, style, dot }) => (
  <div style={{ fontFamily: mono, fontSize: 15, letterSpacing: "0.08em", textTransform: "uppercase", color, display: "flex", alignItems: "center", gap: 10, ...style }}>
    {dot && <span style={{ width: 8, height: 8, borderRadius: 2, background: dot }} />}
    {children}
  </div>
);
