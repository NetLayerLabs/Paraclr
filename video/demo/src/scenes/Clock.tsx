import React from "react";
import { AbsoluteFill, Sequence, interpolate } from "remotion";
import { C, mono, sora } from "../theme";
import { useScene } from "../ui/use";
import { Words } from "../ui/Words";
import { Label } from "../ui/Label";
import { Browser, clip } from "../ui/Browser";
import { BLOCK } from "../ui/Lanes";
import { clamp, expo, ramp, soft } from "../ui/motion";
import data from "../data.json";

/**
 * The live auction clock on paraclr.xyz, then the discount schedule drawn from the
 * deployed parameters: +5 bps a block from 0, the backstop pool at 75 bps (block 15).
 */
export const Clock: React.FC = () => {
  const { f, rel, dur } = useScene("clock");
  const P = data.params;
  const tCut = rel("On") - 8;
  const hero = clip("hero");
  const clockRect = { x: 899, y: 195, w: 601, h: 420 }; // the clock only, not the X-ray readout below it
  // --- chart geometry
  const BL = 20, X0 = 260, X1 = 1500, Y0 = 820, Y1 = 330;
  const bx = (b: number) => X0 + ((X1 - X0) * b) / BL;
  const by = (bps: number) => Y0 - ((Y0 - Y1) * bps) / 110;
  const local = f - tCut - 10;
  // one step per block, in real Monad time (~0.33 s)
  const blocks = Math.max(0, Math.min(BL, local / BLOCK));
  const nb = Math.floor(blocks);
  let d = `M${bx(0)} ${by(0)}`;
  for (let b = 0; b < nb; b++) d += ` H${bx(b + 1)} V${by((b + 1) * P.stepBps)}`;
  d += ` H${bx(blocks)}`;
  const tPool = rel("backstop"), tFive = rel("five", 1), tGas = rel("More");
  const showPool = ramp(f, tPool - 4, tPool + 14);
  const poolBlock = P.poolMinBps / P.stepBps; // 15
  const showFive = ramp(f, tFive - 4, tFive + 12);
  const gas = ramp(f, tGas - 4, tGas + 14);
  const chartIn = ramp(f, tCut, tCut + 16, soft);
  const cur = Math.min(nb, BL) * P.stepBps;
  return (
    <AbsoluteFill style={{ background: C.paper, fontFamily: sora, color: C.ink }}>
      {/* A: the live landing hero */}
      <Sequence durationInFrames={tCut + 12} layout="none">
        <AbsoluteFill style={{ opacity: interpolate(f, [tCut, tCut + 12], [1, 0], clamp) }}>
          <Label color={C.ink3} dot={C.accent} style={{ position: "absolute", left: 310, top: 82 }}>paraclr.xyz · hero auction clock · schematic readout, slowed down</Label>
          {hero && <Browser name="hero" url="paraclr.xyz" width={1300} left={310} top={112} dark={false} startFrom={30} focus={clockRect} zoom={1.75} focusAt={[-30, 0]} />}
        </AbsoluteFill>
      </Sequence>

      {/* B: the schedule, from the deployed parameters */}
      <AbsoluteFill style={{ opacity: chartIn }}>
        <div style={{ position: "absolute", left: 150, top: 120, fontSize: 64, fontWeight: 800, letterSpacing: "-0.05em" }}>
          <Words text="Priced by the block." at={tCut + 2} every={4} accent={{ "block.": C.accent }} />
        </div>
        <Label color={C.ink3} style={{ position: "absolute", right: 150, top: 140 }}>{P.file} · live testnet parameters</Label>
        <svg width={1920} height={1080} style={{ position: "absolute" }}>
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={v}>
              <line x1={X0} x2={X1} y1={by(v)} y2={by(v)} stroke={C.line} strokeWidth={1.5} />
              <text x={X0 - 16} y={by(v) + 5} textAnchor="end" fontFamily={mono} fontSize={15} fill={C.ink3}>{v}</text>
            </g>
          ))}
          <text x={X0 - 16} y={Y1 - 30} textAnchor="end" fontFamily={mono} fontSize={14} fill={C.ink3} letterSpacing="1">BPS</text>
          {Array.from({ length: BL + 1 }, (_, b) => (
            <g key={b}>
              <line x1={bx(b)} x2={bx(b)} y1={Y0} y2={Y0 + (b % 5 === 0 ? 12 : 6)} stroke={C.ink3} strokeWidth={1.5} />
              {b % 5 === 0 && <text x={bx(b)} y={Y0 + 34} textAnchor="middle" fontFamily={mono} fontSize={15} fill={C.ink3}>+{b}</text>}
              {b % 5 === 0 && b > 0 && <text x={bx(b)} y={Y0 + 56} textAnchor="middle" fontFamily={mono} fontSize={13} fill={C.ink3} opacity={0.75}>≈{(b * data.kept.blockMs / 1000).toFixed(1)} s</text>}
            </g>
          ))}
          <text x={X1 + 30} y={Y0 + 6} fontFamily={mono} fontSize={14} fill={C.ink3} letterSpacing="1">BLOCKS</text>
          {/* the old fixed fee, for reference */}
          <line x1={X0} x2={X1} y1={by(P.fixedFeeBps)} y2={by(P.fixedFeeBps)} stroke={C.ink2} strokeWidth={1.5} strokeDasharray="6 7" opacity={0.6 * showPool} />
          <text x={X1} y={by(P.fixedFeeBps) - 10} textAnchor="end" fontFamily={mono} fontSize={14} fill={C.ink2} opacity={0.8 * showPool}>fixed 1% liquidation fee</text>
          {/* pool threshold */}
          <line x1={X0} x2={X0 + (X1 - X0) * showPool} y1={by(P.poolMinBps)} y2={by(P.poolMinBps)} stroke={C.accent} strokeWidth={2} strokeDasharray="2 6" strokeLinecap="round" />
          <path d={d} fill="none" stroke={C.accent} strokeWidth={5} strokeLinejoin="round" strokeLinecap="round" />
          {nb >= 0 && local > 0 && <circle cx={bx(blocks)} cy={by(nb * P.stepBps)} r={9} fill={C.accent} />}
          {/* block +15: the pool takes */}
          <g opacity={showFive}>
            <line x1={bx(poolBlock)} x2={bx(poolBlock)} y1={by(P.poolMinBps)} y2={Y0} stroke={C.accent} strokeWidth={2} strokeDasharray="3 5" />
            <circle cx={bx(poolBlock)} cy={by(P.poolMinBps)} r={16 + 10 * (1 - showFive)} fill="none" stroke={C.accent} strokeWidth={3} />
          </g>
          {/* more gas: an earlier take at a smaller discount */}
          <g opacity={gas}>
            <circle cx={bx(6)} cy={by(30)} r={12} fill={C.ink} />
            <path d={`M${bx(poolBlock) - 24} ${by(P.poolMinBps) + 18} Q ${bx(10)} ${by(70)} ${bx(6) + 22} ${by(30) - 12}`} fill="none" stroke={C.ink} strokeWidth={2.5} strokeDasharray="6 6" />
          </g>
        </svg>
        <div style={{ position: "absolute", left: X0 + 30, top: by(P.poolMinBps) - 84, opacity: showPool }}>
          <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.03em", color: C.accent }}>Backstop pool can take from {P.poolMinBps} bps</div>
          <div style={{ fontFamily: mono, fontSize: 16, color: C.ink2, marginTop: 6, opacity: showFive }}>block +{poolBlock} · about 5 s</div>
        </div>
        <div style={{ position: "absolute", left: bx(6) - 40, top: by(30) + 26, opacity: gas, width: 420 }}>
          <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em" }}>More gas = an earlier take</div>
          <div style={{ fontFamily: mono, fontSize: 16, color: C.ink2, marginTop: 4 }}>at a smaller discount (block +6 · 30 bps)</div>
        </div>
        {/* live readout */}
        <div style={{ position: "absolute", right: 150, top: 220, textAlign: "right", fontFamily: mono }}>
          <div style={{ fontSize: 15, letterSpacing: "0.08em", color: C.ink3 }}>DISCOUNT NOW</div>
          <div style={{ fontFamily: sora, fontSize: 64, fontWeight: 800, letterSpacing: "-0.05em", color: C.accent, fontVariantNumeric: "tabular-nums" }}>{cur} <span style={{ fontSize: 28, color: C.ink3 }}>bps</span></div>
          <div style={{ fontSize: 16, color: C.ink2 }}>+{P.stepBps} bps / block · block ≈ {(data.kept.blockMs / 1000).toFixed(2)} s</div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
