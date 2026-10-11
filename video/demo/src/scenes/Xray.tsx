import React from "react";
import { AbsoluteFill, interpolate } from "remotion";
import { C, mono, sora } from "../theme";
import { useScene } from "../ui/use";
import { Label } from "../ui/Label";
import { Count } from "../ui/Count";
import { clamp, expo, pop, ramp } from "../ui/motion";
import data from "../data.json";

type Design = { lanes: number[]; edges: number[][]; summary: { txs: number; crossLaneEdges: number } };

/** The dependency matrix of one design, drawn from the committed X-ray (row = earlier writer, column = later reader). */
const Matrix: React.FC<{ d: Design; size: number; drawAt: number; edgesAt: number; edgeDur: number; tone: string }> = ({ d, size, drawAt, edgesAt, edgeDur, tone }) => {
  const { f } = useScene("xray");
  const n = d.lanes.length;
  const u = size / n;
  const bands: { lane: number; start: number; count: number }[] = [];
  d.lanes.forEach((l, i) => { const b = bands.at(-1); if (b && b.lane === l) b.count++; else bands.push({ lane: l, start: i, count: 1 }); });
  const draw = ramp(f, drawAt, drawAt + 24);
  return (
    <svg width={size} height={size} style={{ display: "block", overflow: "visible" }}>
      <rect width={size} height={size} fill="#0E0D15" stroke="rgba(255,255,255,0.10)" />
      {bands.map((b, i) => {
        const p = ramp(f, drawAt + i * 3, drawAt + i * 3 + 14);
        return <rect key={i} x={b.start * u} y={b.start * u} width={b.count * u * p} height={b.count * u * p} fill="rgba(110,84,255,0.20)" stroke="rgba(168,152,255,0.35)" strokeWidth={1} />;
      })}
      <line x1={0} y1={0} x2={size * draw} y2={size * draw} stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
      {d.edges.map(([i, j, cross], k) => {
        const at = edgesAt + (k * edgeDur) / Math.max(1, d.edges.length);
        const p = Math.min(1, pop(f, at));
        if (f < at) return null;
        const pad = u * 0.12;
        return <rect key={k} x={j * u + pad} y={i * u + pad} width={(u - 2 * pad)} height={(u - 2 * pad)} rx={2} fill={cross ? C.negDark : C.accentInkDark}
          transform={`translate(${(j + 0.5) * u * (1 - p)} ${(i + 0.5) * u * (1 - p)}) scale(${p})`} />;
      })}
      <text x={0} y={size + 30} fontFamily={mono} fontSize={14} fill={tone} letterSpacing="1">{d.summary.txs} TRANSACTIONS IN THE RESOLUTION PHASE</text>
    </svg>
  );
};

export const Xray: React.FC = () => {
  const { f, rel } = useScene("xray");
  const x = data.xray;
  const tTrace = rel("traced"), tShared = rel("shared"), t49 = rel("forty-nine"), tZero = rel("zero."), tNever = rel("never");
  const S = 470;
  const zero = ramp(f, tZero - 4, tZero + 10);
  const shared = ramp(f, tShared - 4, tShared + 10);
  return (
    <AbsoluteFill style={{ background: C.night, fontFamily: sora, color: C.dInk }}>
      <Label color={C.dInk3} dot={C.accentInkDark} style={{ position: "absolute", left: 150, top: 120, textTransform: "none" }}>
        cross-lane dependency edges · {x.method} (prestateTracer) · same block · Monad testnet
      </Label>
      {[
        { d: x.lanes as Design, left: 150, title: "Paraclr lanes", sub: "per-lane storage keys", n: 0, col: C.posDark, glow: zero, drawAt: tTrace },
        { d: x.naive as Design, left: 1010, title: "Naive shared state", sub: "same code · every total on one key", n: x.naive.summary.crossLaneEdges, col: C.negDark, glow: shared, drawAt: tTrace + 10 },
      ].map((m, i) => (
        <div key={i} style={{ position: "absolute", left: m.left, top: 190 }}>
          <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: "-0.03em" }}>{m.title}</div>
          <div style={{ fontFamily: mono, fontSize: 14, color: C.dInk3, letterSpacing: "0.05em", marginTop: 4, marginBottom: 18 }}>{m.sub}</div>
          <div style={{ boxShadow: i === 1 ? `0 0 0 ${2 * m.glow}px rgba(255,92,122,0.5)` : `0 0 0 ${2 * m.glow}px rgba(61,220,151,0.55)`, borderRadius: 2 }}>
            <Matrix d={m.d} size={S} drawAt={m.drawAt} edgesAt={t49 - 8} edgeDur={34} tone={C.dInk3} />
          </div>
        </div>
      ))}
      {/* the counters */}
      <div style={{ position: "absolute", left: 150 + S + 36, top: 460, opacity: zero, transform: `scale(${0.8 + 0.2 * zero})`, transformOrigin: "left center" }}>
        <div style={{ fontSize: 180, fontWeight: 800, letterSpacing: "-0.06em", color: C.posDark, lineHeight: 1 }}>0</div>
        <div style={{ fontFamily: mono, fontSize: 14, color: C.dInk2, letterSpacing: "0.05em", maxWidth: 200 }}>cross-lane edges</div>
      </div>
      <div style={{ position: "absolute", left: 1010 + S + 36, top: 460, opacity: ramp(f, t49 - 6, t49 + 6) }}>
        <div style={{ fontSize: 180, fontWeight: 800, letterSpacing: "-0.06em", color: C.negDark, lineHeight: 1 }}><Count to={x.naive.summary.crossLaneEdges} at={t49 - 8} dur={34} /></div>
        <div style={{ fontFamily: mono, fontSize: 14, color: C.dInk2, letterSpacing: "0.05em", maxWidth: 200 }}>cross-lane edges</div>
      </div>
      <div style={{ position: "absolute", left: 150, top: 800, fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em", opacity: ramp(f, tNever - 4, tNever + 12) }}>
        They never wait on each other.
      </div>
      <Label color={C.dInk3} style={{ position: "absolute", left: 1010, top: 812, textTransform: "none" }}>evidence · {x.file}</Label>
    </AbsoluteFill>
  );
};
