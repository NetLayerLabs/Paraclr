import React from "react";
import { AbsoluteFill, interpolate } from "remotion";
import { C, mono, sora } from "../theme";
import { useScene } from "../ui/use";
import { Words } from "../ui/Words";
import { Label } from "../ui/Label";
import { clamp, expo, pop, ramp, soft } from "../ui/motion";

/** First bot wins, a fixed penalty lands on the trader. A schematic, labelled as one. */
export const Problem: React.FC = () => {
  const { f, rel } = useScene("problem");
  const tRace = rel("race."), tFirst = rel("first."), tPen = rel("penalty"), tTrader = rel("trader"), tWill = rel("willing");
  const X0 = 150, FIN = 1000;
  const bots = [
    { name: "bot 1", speed: 0.86, y: 440 },
    { name: "bot 2", speed: 1.0, y: 540 },
    { name: "bot 3", speed: 0.79, y: 640 },
  ];
  const run = (sp: number) => interpolate(f, [tRace - 6, tFirst + 2], [0, sp], { ...clamp, easing: (t) => t * t * (3 - 2 * t) });
  const landed = pop(f, tFirst + 2);
  // the equity bar and the penalty block
  const EX = 1200, EW = 560, EY = 470, EH = 120;
  const drop = interpolate(f, [tPen - 2, tPen + 12], [-340, 0], { ...clamp, easing: (t) => 1 - Math.pow(1 - t, 3) });
  const eaten = ramp(f, tTrader - 4, tTrader + 14);
  const PEN = 190; // the fixed penalty's width on the bar (schematic)
  const ghost = ramp(f, tWill - 4, tWill + 14, soft);
  return (
    <AbsoluteFill style={{ background: C.paper, fontFamily: sora, color: C.ink }}>
      <div style={{ position: "absolute", left: 150, top: 150, fontSize: 76, fontWeight: 800, letterSpacing: "-0.05em", lineHeight: 1.04 }}>
        <div><Words text="A race." at={tRace - 4} accent={{ "race.": C.accent }} /></div>
        <div style={{ color: C.display2 }}><Words text="A fixed penalty." at={tPen - 4} every={4} accent={{ fixed: C.accent }} /></div>
      </div>
      <Label color={C.ink3} style={{ position: "absolute", right: 150, top: 160 }}>schematic · typical first-bot-wins liquidation</Label>

      {/* the race */}
      <svg width={1920} height={1080} style={{ position: "absolute" }}>
        <line x1={FIN} x2={FIN} y1={400} y2={690} stroke={C.ink} strokeWidth={2} strokeDasharray="4 6" opacity={0.45} />
        {bots.map((b, i) => {
          const p = run(b.speed);
          const x = X0 + (FIN - X0) * p;
          const win = i === 1;
          const lose = !win && f > tFirst + 4;
          return (
            <g key={b.name} opacity={lose ? interpolate(f, [tFirst + 4, tFirst + 16], [1, 0.25], clamp) : 1}>
              <line x1={X0} x2={FIN} y1={b.y} y2={b.y} stroke={C.line} strokeWidth={3} />
              <line x1={X0} x2={x} y1={b.y} y2={b.y} stroke={win ? C.accent : C.ink2} strokeWidth={win ? 8 : 5} strokeLinecap="round" />
              <circle cx={x} cy={b.y} r={win ? 11 : 8} fill={win ? C.accent : C.ink2} />
              <text x={X0 - 18} y={b.y + 6} textAnchor="end" fontFamily={mono} fontSize={17} fill={C.ink3}>{b.name}</text>
              {p > 0.05 && Array.from({ length: 3 }, (_, k) => (
                <line key={k} x1={x - 30 - k * 22} x2={x - 18 - k * 22} y1={b.y - 14} y2={b.y - 14} stroke={C.ink3} strokeWidth={2} opacity={0.5 - k * 0.15} />
              ))}
            </g>
          );
        })}
        <text x={FIN} y={385} textAnchor="middle" fontFamily={mono} fontSize={15} fill={C.ink3} letterSpacing="1.5">UNDERWATER ACCOUNT</text>
        <text x={X0} y={385} fontFamily={mono} fontSize={15} fill={C.ink3} letterSpacing="1.5" opacity={ramp(f, rel("gas"), rel("gas") + 10)}>BIDDING GAS ↑</text>
      </svg>
      <div style={{ position: "absolute", left: FIN - 70, top: 560, transform: `rotate(-6deg) scale(${Math.min(1.2, landed)})`, opacity: Math.min(1, landed),
        border: `3px solid ${C.accent}`, color: C.accent, fontFamily: mono, fontSize: 20, letterSpacing: "0.12em", padding: "5px 12px", borderRadius: 6, background: C.paper }}>LANDED FIRST</div>

      {/* the trader's equity, and the fixed penalty that lands on it */}
      <Label color={C.ink3} style={{ position: "absolute", left: EX, top: EY - 46 }}>trader's remaining equity</Label>
      <div style={{ position: "absolute", left: EX, top: EY, width: EW, height: EH, borderRadius: 12, background: C.accentSoft, boxShadow: `inset 0 0 0 2px ${C.accent}`, overflow: "hidden" }}>
        <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: PEN * eaten, background: C.neg }} />
      </div>
      <div style={{ position: "absolute", left: EX + EW - PEN, top: EY + drop, width: PEN, height: EH,
        opacity: f >= tPen - 2 ? 1 - eaten : 0, borderRadius: 12, background: C.ink, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: mono, fontSize: 16, letterSpacing: "0.08em", textAlign: "center", lineHeight: 1.3 }}>FIXED<br />PENALTY</div>
      <div style={{ position: "absolute", left: EX + EW - PEN, top: EY + EH + 16, width: PEN, textAlign: "center", fontFamily: mono, fontSize: 15, color: C.neg, opacity: eaten }}>paid to the winner</div>
      <div style={{ position: "absolute", left: EX + EW - PEN, top: EY - 8, width: 74, height: EH + 16, borderRadius: 12, border: `2.5px dashed ${C.ink}`, opacity: ghost }} />
      <div style={{ position: "absolute", left: EX, top: EY + EH + 70, width: EW, fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em", opacity: ghost, lineHeight: 1.25 }}>
        whatever the market <span style={{ fontFamily: "inherit", color: C.accent }}>would actually take</span>
      </div>
    </AbsoluteFill>
  );
};
