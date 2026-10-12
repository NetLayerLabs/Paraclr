import React from "react";
import { C, mono } from "../theme";

/** netlayerlabs.com's section label: "/ " + uppercase mono, tracked out. */
export const Label: React.FC<{ children: React.ReactNode; size?: number; color?: string; style?: React.CSSProperties; slash?: boolean }> = ({ children, size = 18, color = C.muted, style, slash = true }) => (
  <div style={{ fontFamily: mono, fontSize: size, letterSpacing: "0.16em", textTransform: "uppercase", color, ...style }}>
    {slash ? <span style={{ color: C.dim, marginRight: "0.6em" }}>/</span> : null}{children}
  </div>
);
