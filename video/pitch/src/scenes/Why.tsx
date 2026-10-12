import React from "react";
import { AbsoluteFill, interpolate } from "remotion";
import { evolvePath } from "@remotion/paths";
import { C, display, mono } from "../theme";
import { clamp, expo, ramp, soft } from "../ui/motion";
import { Label } from "../ui/Label";
import { Words } from "../ui/Words";
import { useScene } from "../ui/use";
import { wordAt, scene } from "../timing";

// Drawing space (SVG units = px), placed at left 140, top 330.
const W = 1640, H = 440;
const MAINT = 250;           // maintenance line
const P = { x: 860, y: MAINT }; // where the position crosses it
const PRICE = "M 0 120 C 90 96 150 150 230 132 S 360 92 430 150 S 560 196 620 176 S 740 214 800 232 S 846 246 860 250";
const BOTS = [{ y: 330, speed: 1.0 }, { y: 370, speed: 0.86 }, { y: 410, speed: 0.74 }];
const METER = { x: 1300, y: 20, w: 150, h: 400 };

/** A stark chrome line drawing of the liquidation race: price crosses the line, bots race on gas, the trader's equity drains. */
export const Why: React.FC = () => {
  const { f, rel } = useScene("why");
  const s = scene("why");
  const headT = ["the", "same", "unfair", "moment."].map((w) => wordAt("why", w) - s.from);
  const draw = ramp(f, 6, rel("liquidated,") + 2, soft);
  const cross = ramp(f, rel("liquidated,"), rel("liquidated,") + 18, expo);
  const ring = interpolate(f, [rel("liquidated,"), rel("liquidated,") + 30], [0, 1], clamp);
  const raceA = rel("bots") - 2, raceB = rel("gas,") + 10;
  const meterIn = ramp(f, rel("trader") - 8, rel("trader") + 12);
  const drain = ramp(f, rel("penalty") - 2, rel("penalty") + 26, expo);
  const tag = ramp(f, rel("market") - 4, rel("market") + 14);
  const price = evolvePath(draw, PRICE);
  const level = 0.82 - 0.34 * drain; // equity fill, of the meter height
  const shake = f > rel("penalty") && f < rel("penalty") + 10 ? Math.sin(f * 3) * 3 : 0;
  return (
    <AbsoluteFill style={{ background: C.black }}>
      <AbsoluteFill style={{ background: "radial-gradient(60% 55% at 50% 58%, rgba(255,255,255,0.05), transparent 70%)" }} />
      <Label size={18} style={{ position: "absolute", left: 140, top: 150, opacity: ramp(f, 0, 18) }}>Why we build</Label>
      <div style={{ position: "absolute", left: 140, top: 196, fontFamily: display, fontStretch: "115%", fontWeight: 700, fontSize: 70, letterSpacing: "-0.015em", color: C.white }}>
        <Words text="The same unfair moment." at={0} times={headT} chrome={["unfair"]} />
      </div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", left: 140, top: 340, overflow: "visible" }}>
        <defs>
          <linearGradient id="chr" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={W} y2="0">
            <stop offset="0" stopColor="#6c7075" /><stop offset="0.5" stopColor="#ffffff" /><stop offset="1" stopColor="#c7cbd0" />
          </linearGradient>
          <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffffff" /><stop offset="0.45" stopColor="#b9bdc2" /><stop offset="0.5" stopColor="#7b7f84" /><stop offset="1" stopColor="#e6e8eb" />
          </linearGradient>
          <filter id="glow"><feGaussianBlur stdDeviation="3" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>
        {/* maintenance line */}
        <line x1={0} x2={1040 * ramp(f, 0, 30)} y1={MAINT} y2={MAINT} stroke="rgba(255,255,255,0.35)" strokeWidth={1.5} strokeDasharray="8 8" />
        <text x={0} y={MAINT - 14} fill={C.muted} fontFamily={mono} fontSize={14} letterSpacing="2.4" opacity={ramp(f, 6, 20)}>MAINTENANCE MARGIN</text>
        <text x={0} y={104} fill={C.muted} fontFamily={mono} fontSize={14} letterSpacing="2.4" opacity={ramp(f, 6, 20)}>POSITION VALUE</text>
        {/* the position */}
        <path d={PRICE} fill="none" stroke="url(#chr)" strokeWidth={4} strokeLinecap="round" strokeDasharray={price.strokeDasharray} strokeDashoffset={price.strokeDashoffset} filter="url(#glow)" />
        {/* crossing */}
        <circle cx={P.x} cy={P.y} r={7 * cross} fill="#fff" />
        <circle cx={P.x} cy={P.y} r={10 + 70 * ring} fill="none" stroke="#fff" strokeWidth={2} opacity={(1 - ring) * cross} />
        <text x={P.x + 18} y={P.y - 18} fill="#fff" fontFamily={mono} fontSize={16} letterSpacing="2.6" opacity={cross}>LIQUIDATABLE</text>
        {/* the finish: whoever lands first takes it */}
        <line x1={P.x} x2={P.x} y1={P.y + 12} y2={P.y + 12 + 190 * ramp(f, raceA - 10, raceA + 6)} stroke="rgba(255,255,255,0.5)" strokeWidth={1.5} strokeDasharray="3 6" />
        {BOTS.map((b, i) => {
          const t = interpolate(f, [raceA + i * 2, raceB + i * 8], [0, 1], { ...clamp, easing: (x) => Math.pow(x, 1.6) });
          const x = P.x * t * b.speed;
          const vis = ramp(f, raceA - 6 + i * 2, raceA + 6 + i * 2);
          const won = i === 0 && t >= 1;
          return (
            <g key={i} opacity={vis * (won || t < 1 ? 1 : 0.45)}>
              <line x1={Math.max(0, x - 260)} x2={x} y1={b.y} y2={b.y} stroke="#fff" strokeOpacity={0.85} strokeWidth={won ? 3 : 2} />
              {[0, 1, 2].map((k) => <line key={k} x1={x - 40 - k * 26} x2={x - 30 - k * 26} y1={b.y - 9} y2={b.y - 9} stroke="#fff" strokeWidth={1.5} opacity={t > 0 && t < 1 ? 0.35 + 0.65 * ((f + k * 3) % 6 < 3 ? 1 : 0) : 0} />)}
              <polygon points={`${x},${b.y - 7} ${x + 12},${b.y} ${x},${b.y + 7}`} fill="#fff" />
              <text x={Math.max(0, x - 256)} y={b.y - 12} fill={C.muted} fontFamily={mono} fontSize={13} letterSpacing="2">BOT {String.fromCharCode(65 + i)} · GAS ▲</text>
            </g>
          );
        })}
        <text x={P.x + 18} y={BOTS[0].y + 5} fill="#fff" fontFamily={mono} fontSize={15} letterSpacing="2.4" opacity={ramp(f, raceB, raceB + 10)}>FIRST TX TAKES IT</text>
        {/* the trader's equity */}
        <g opacity={meterIn} transform={`translate(${shake} 0)`}>
          <text x={METER.x} y={METER.y - 4} fill={C.ink2} fontFamily={mono} fontSize={15} letterSpacing="2.4">TRADER EQUITY</text>
          <rect x={METER.x} y={METER.y + 14} width={METER.w} height={METER.h - 14} fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth={1.5} />
          <rect x={METER.x + 8} y={METER.y + 14 + (METER.h - 22) * (1 - level)} width={METER.w - 16} height={(METER.h - 22) * level} fill="url(#fill)" />
          {/* the part that leaves */}
          <rect x={METER.x + 8} y={METER.y + 14 + (METER.h - 22) * (1 - 0.82)} width={METER.w - 16} height={(METER.h - 22) * 0.34 * drain} fill="none" stroke="#fff" strokeWidth={1.5} strokeDasharray="4 5" opacity={drain} />
          <line x1={METER.x + METER.w + 10} x2={METER.x + METER.w + 40} y1={METER.y + 14 + (METER.h - 22) * 0.35} y2={METER.y + 14 + (METER.h - 22) * 0.35} stroke="#fff" strokeWidth={1.5} opacity={drain} />
          <text x={METER.x + METER.w + 52} y={METER.y + 14 + (METER.h - 22) * 0.35 + 6} fill="#fff" fontFamily={mono} fontSize={16} letterSpacing="2.4" opacity={drain}>PENALTY</text>
          <text x={METER.x + METER.w + 52} y={METER.y + 14 + (METER.h - 22) * 0.35 + 32} fill={C.muted} fontFamily={mono} fontSize={13} letterSpacing="2" opacity={tag}>NO MARKET SET IT</text>
        </g>
      </svg>
      <div style={{ position: "absolute", right: 140, top: 160, fontFamily: mono, fontSize: 13, letterSpacing: "0.2em", color: C.dim, opacity: ramp(f, 0, 18) }}>SCHEMATIC</div>
    </AbsoluteFill>
  );
};
