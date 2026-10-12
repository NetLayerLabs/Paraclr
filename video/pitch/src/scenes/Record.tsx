import React from "react";
import { AbsoluteFill, interpolate } from "remotion";
import { C, chromeText, display, mono } from "../theme";
import { clamp, expo, ramp } from "../ui/motion";
import { Count } from "../ui/Count";
import { Type } from "../ui/Type";
import { Label } from "../ui/Label";
import { Spotlight } from "../ui/Spotlight";
import { useScene } from "../ui/use";

/** The record (netlayerlabs.com): two big figures and a ruled list that types in as it is read out. */
export const Record: React.FC = () => {
  const { f, rel, dur } = useScene("record");
  const five = rel("Five"), three = rel("Three"), calmr = rel("Calmr"), first = rel("first"), four = rel("four"), all = rel("All");
  const head = ramp(f, 0, 20);
  const big = (at: number) => ramp(f, at - 4, at + 20, expo);
  const ROWS: { name: string; at: number; status: string; statusAt: number; prize?: boolean }[] = [
    { name: "Stripr", at: three + 4, status: "live on mainnet", statusAt: three + 14 },
    { name: "Equis", at: three + 10, status: "live on mainnet", statusAt: three + 20 },
    { name: "Cerebr", at: three + 16, status: "live on mainnet", statusAt: three + 26 },
    { name: "Calmr", at: calmr - 4, status: "1st place · Visko Orbis · ", statusAt: first - 2, prize: true },
  ];
  const strip = ramp(f, all - 4, all + 18);
  const os = ramp(f, rel("open") - 2, rel("open") + 16);
  const drift = interpolate(f, [0, dur], [0, -8]);
  return (
    <AbsoluteFill style={{ background: C.black }}>
      <Spotlight x={0.2} angle={10} intensity={0.55} width={700} poolY={0.8} />
      <Label size={18} style={{ position: "absolute", left: 140, top: 150, opacity: head }}>The record <span style={{ color: C.dim }}>·</span> netlayerlabs.com</Label>
      {/* figures */}
      <div style={{ position: "absolute", left: 140, top: 214 + drift, width: 520 }}>
        {([[5, "products shipped", five], [3, "live on mainnet", three]] as const).map(([n, l, at], i) => {
          const p = big(at);
          return (
            <div key={l} style={{ display: "flex", alignItems: "flex-end", gap: 26, height: 236, opacity: p, transform: `translateY(${(1 - p) * 24}px)`, borderBottom: i === 0 ? `1px solid ${C.line}` : undefined }}>
              <span style={{ fontFamily: display, fontStretch: "125%", fontWeight: 800, fontSize: 230, lineHeight: 0.92, letterSpacing: "-0.04em", ...chromeText }}><Count to={n} at={at} dur={16} /></span>
              <span style={{ fontFamily: mono, fontSize: 19, letterSpacing: "0.16em", textTransform: "uppercase", color: C.ink2, paddingBottom: 24, lineHeight: 1.4 }}>{l}</span>
            </div>
          );
        })}
      </div>
      {/* ruled list */}
      <div style={{ position: "absolute", left: 760, top: 222 + drift, width: 1020 }}>
        <div style={{ display: "flex", fontFamily: mono, fontSize: 14, letterSpacing: "0.16em", color: C.dim, paddingBottom: 14, opacity: ramp(f, three - 6, three + 8) }}>
          <span style={{ width: 70 }}>#</span><span style={{ width: 330 }}>PRODUCT</span><span>STATUS</span>
        </div>
        {ROWS.map((r, i) => {
          const p = ramp(f, r.at, r.at + 16, expo);
          const line = ramp(f, r.at - 6, r.at + 14);
          return (
            <div key={r.name} style={{ position: "relative", display: "flex", alignItems: "center", height: 96 }}>
              <div style={{ position: "absolute", left: 0, top: 0, height: 1, width: `${line * 100}%`, background: C.line }} />
              {i === ROWS.length - 1 ? <div style={{ position: "absolute", left: 0, bottom: 0, height: 1, width: `${line * 100}%`, background: C.line }} /> : null}
              <span style={{ width: 70, fontFamily: mono, fontSize: 16, color: C.dim, opacity: p }}>0{i + 1}</span>
              <span style={{ width: 330, fontFamily: display, fontStretch: "115%", fontWeight: 700, fontSize: 50, color: C.white, opacity: p, transform: `translateX(${(1 - p) * 20}px)`, filter: p < 1 ? `blur(${(1 - p) * 6}px)` : undefined }}>{r.name}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 14, fontFamily: mono, fontSize: 21, letterSpacing: "0.1em", textTransform: "uppercase", color: r.prize ? C.white : C.ink2 }}>
                <span style={{ opacity: f >= r.statusAt ? (r.prize ? 1 : 0.55 + 0.45 * Math.abs(Math.sin((f - r.statusAt) / 9))) : 0, fontSize: 14 }}>■</span>
                <Type text={r.status} at={r.statusAt} cps={1.6} caret={!r.prize} />
                {r.prize ? <span style={{ opacity: ramp(f, four - 2, four + 8), fontWeight: 500 }}><Count to={4000} at={four} dur={22} prefix="$" /></span> : null}
              </span>
            </div>
          );
        })}
      </div>
      {/* the line */}
      <div style={{ position: "absolute", left: 140, right: 140, top: 768, display: "flex", alignItems: "center", gap: 26, opacity: strip, transform: `translateY(${(1 - strip) * 14}px)`,
        fontFamily: display, fontStretch: "112%", fontWeight: 600, fontSize: 40, color: C.ink2 }}>
        <span>5 shipped</span><span style={{ color: C.dim }}>·</span><span>3 on mainnet</span><span style={{ color: C.dim }}>·</span>
        <span style={{ ...chromeText, fontWeight: 800, opacity: os, display: "inline-block", transform: `scale(${1.25 - 0.25 * os})`, transformOrigin: "left center" }}>open source</span>
        <span style={{ marginLeft: "auto", fontFamily: mono, fontSize: 15, letterSpacing: "0.16em", color: C.muted, opacity: interpolate(f, [rel("source.") + 6, rel("source.") + 16], [0, 1], clamp) }}>GITHUB · APACHE 2.0</span>
      </div>
    </AbsoluteFill>
  );
};
