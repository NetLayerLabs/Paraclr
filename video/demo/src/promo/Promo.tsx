import React from "react";
import { AbsoluteFill, Audio, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import vo from "../promo-vo.json";
import { Timing, TimingCtx } from "../timing";
import { C, mono, serif, sora } from "../theme";
import { Chrome } from "../ui/Chrome";
import { Grain } from "../ui/Grain";
import { clamp, expo, pop, ramp } from "../ui/motion";
import { Mask, markOf } from "../ui/Browser";
import { Shots, Seg } from "../ui/Shots";
import { Count } from "../ui/Count";
import { num } from "../ui/format";
import { Problem } from "../scenes/Problem";
import { Turn } from "../scenes/Turn";
import { Close } from "../scenes/Close";
import data from "../data.json";

/**
 * The 30-second promo: hook, logo turn on the music's drop, six real-footage cuts on the beat,
 * the two measured numbers, close. Music up front (public/audio/promo-cue.mp3, re-edited on bar
 * lines by scripts/promo-audio.mjs so the drop lands at 4.02 s); three short Sarah lines.
 */
const FPS = 30;
const DROP = 4.02, BEAT = 0.5021;
export const bf = (k: number) => Math.round((DROP + k * BEAT) * FPS); // frame of beat k after the drop
export const PROMO_FRAMES = 858;

const S = {
  problem: [0, bf(0)], turn: [bf(0), bf(6)], pmontage: [bf(6), bf(34)], pproof: [bf(34), bf(42)], close: [bf(42), PROMO_FRAMES],
} as const;
// Montage cut points (scene-local), each on a beat.
const CUTS = [bf(6), bf(11), bf(16), bf(21), bf(25), bf(29), bf(34)].map((x) => x - bf(6));

type W = { word: string; start: number; end: number };
const at = (words: { word: string; start: number; end: number }[], offsetFrames: number): W[] =>
  words.map((w) => ({ word: w.word, start: offsetFrames + Math.round(w.start * FPS), end: offsetFrames + Math.round(w.end * FPS) }));
const cue = (word: string, f: number): W => ({ word, start: f, end: f + 6 });

// VO placement (absolute frames)
const VO = { race: 10, turn: S.turn[0] + 24, fair: S.close[0] + 4 };

/** The promo's own timeline: real word times for the spoken lines, beat-placed cue words for reused scenes. */
const PT: Timing = {
  fps: FPS, totalFrames: PROMO_FRAMES, bpm: 119.5, beats: [],
  scenes: [
    { id: "problem", from: S.problem[0], durationInFrames: S.problem[1] - S.problem[0], lines: [{ voice: "narrator", text: "", file: "", startFrame: 0, durationFrames: 0,
      words: [cue("race.", 4), cue("gas", 20), cue("first.", 46), cue("penalty", 58), cue("trader", 76), cue("willing", 96)] }] },
    { id: "turn", from: S.turn[0], durationInFrames: S.turn[1] - S.turn[0], lines: [{ voice: "narrator", text: vo.turn.words.map((w) => w.word).join(" "), file: vo.turn.file, startFrame: VO.turn, durationFrames: 0, words: at(vo.turn.words, VO.turn) }] },
    { id: "pmontage", from: S.pmontage[0], durationInFrames: S.pmontage[1] - S.pmontage[0], lines: [] },
    { id: "pproof", from: S.pproof[0], durationInFrames: S.pproof[1] - S.pproof[0], lines: [] },
    { id: "close", from: S.close[0], durationInFrames: S.close[1] - S.close[0], lines: [{ voice: "narrator", text: "", file: vo.fair.file, startFrame: VO.fair, durationFrames: 0,
      words: [cue("Paraclr.", S.close[0] - 2), ...at(vo.fair.words, VO.fair), cue("paraclr", VO.fair + 46)] }] },
  ],
};

const EMAIL_INPUT: Mask = { x: 690, y: 378, w: 262, h: 54 };
const APP = "paraclr.xyz/app";

/** Big kinetic line under the footage, one per cut. */
const Headline: React.FC<{ text: string; accent?: string; from: number; to: number }> = ({ text, accent, from, to }) => {
  const f = useCurrentFrame();
  if (f < from || f >= to) return null;
  const p = interpolate(f, [from, from + 8], [0, 1], { ...clamp, easing: expo });
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top: 958, textAlign: "center", fontFamily: sora, fontWeight: 800, fontSize: 46, letterSpacing: "-0.04em", color: C.dInk,
      opacity: p, transform: `translateY(${(1 - p) * 18}px)` }}>
      {text}{accent ? <span style={{ fontFamily: serif, fontStyle: "italic", fontWeight: 400, color: C.accentInkDark, fontSize: 54, marginLeft: 12 }}>{accent}</span> : null}
    </div>
  );
};

const Montage: React.FC = () => {
  const f = useCurrentFrame();
  const [c0, c1, c2, c3, c4, c5, c6] = CUTS;
  const press = markOf("arena2", "a2_press");
  const segs: Seg[] = [
    { from: c0, to: c1, clip: "signin1", at: 96, url: APP, label: "sign in · privy", focus: { x: 620, y: 258, w: 360, h: 384 }, zoom: 1.6, spotlight: true, focusAt: [c0, c0 + 1], masks: [{ ...EMAIL_INPUT, from: 190 }] },
    { from: c1, to: c2, clip: "trade", at: 1907 - 10, url: APP, label: "long SOL 3x · filled at the next Pyth price", focus: { x: 0, y: 700, w: 1210, h: 130 }, zoom: 1.55, focusAt: [c1, c1 + 1] },
    { from: c2, to: c3, clip: "close2", at: 600, url: APP, label: "closed · the app's share card", focus: { x: 445, y: 212, w: 710, h: 475 }, zoom: 1.25, focusAt: [c2, c2 + 1], hold: 680 },
    { from: c3, to: c4, clip: "arena2", at: press - 30, url: "paraclr.xyz/arena", label: "arena · one press · demo stack, synthetic accounts", focus: { x: 1000, y: 200, w: 480, h: 230 }, zoom: 2.2, focusAt: [c3, c3 + 1] },
    { from: c4, to: c5, clip: "arena2", at: markOf("arena2", "a2_take") - 22, url: "paraclr.xyz/arena", label: "8 lanes · each its own auction and pool", focus: { x: 128, y: 66, w: 1344, h: 566 }, zoom: 1.16, spotlight: true, focusAt: [c4, c4 + 1] },
    { from: c5, to: c6, clip: "arena_xray", at: markOf("arena_xray", "ax_xray") + 10, url: "paraclr.xyz/arena", label: "conflict x-ray · crash #4 · live trace", focus: { x: 120, y: 170, w: 1360, h: 470 }, zoom: 1.15, focusAt: [c5, c5 + 1], hold: 600 },
  ];
  const stamp = Math.min(1, pop(f, c3 + 30));
  return (
    <Shots segs={segs}>
      <Headline text="Sign in with Privy." accent="No seed phrase." from={c0} to={c1} />
      <Headline text="Filled at the next" accent="Pyth price." from={c1} to={c2} />
      <Headline text={"Closed · +0.11 AUSD ·"} accent="+1.1%" from={c2} to={c3} />
      <Headline text="Crash the market." accent="−20%" from={c3} to={c4} />
      <Headline text="Eight lanes clear" accent="in seconds." from={c4} to={c5} />
      <Headline text="0 vs 11 cross-lane" accent="dependencies." from={c5} to={c6} />
      {f >= c3 + 28 && f < c4 && (
        <div style={{ position: "absolute", right: 300, top: 300, transform: `rotate(-5deg) scale(${1.6 - 0.6 * stamp})`, opacity: stamp, fontFamily: sora, fontWeight: 800, fontSize: 130,
          letterSpacing: "-0.05em", color: C.negDark, textShadow: "0 10px 40px rgba(0,0,0,0.6)" }}>−20%</div>
      )}
    </Shots>
  );
};

const Proof: React.FC = () => {
  const f = useCurrentFrame();
  const k = data.kept, x = data.xray;
  const half = (S.pproof[1] - S.pproof[0]) / 2;
  const a = f < half;
  const t0 = a ? 0 : half;
  const p = ramp(f, t0, t0 + 10);
  return (
    <AbsoluteFill style={{ background: C.accent, fontFamily: sora, color: "#fff" }}>
      <AbsoluteFill style={{ background: "radial-gradient(60% 60% at 80% 20%, rgba(255,255,255,0.16), transparent 70%)" }} />
      <div style={{ position: "absolute", left: 150, top: 150, fontFamily: mono, fontSize: 18, letterSpacing: "0.1em", color: "rgba(255,255,255,0.85)" }}>MEASURED ON MONAD TESTNET</div>
      <div style={{ position: "absolute", left: 140, top: 230, opacity: p, transform: `translateY(${(1 - p) * 30}px)` }}>
        {a ? (
          <>
            <div style={{ fontSize: 330, fontWeight: 800, letterSpacing: "-0.07em", lineHeight: 1 }}><Count to={Math.round(k.pctLess)} at={t0} dur={14} suffix="%" /></div>
            <div style={{ fontSize: 76, fontWeight: 800, letterSpacing: "-0.05em", marginTop: 10 }}>
              <span style={{ fontFamily: serif, fontStyle: "italic", fontWeight: 400 }}>less</span> taken from traders
            </div>
            <div style={{ fontSize: 30, fontWeight: 500, marginTop: 14, color: "rgba(255,255,255,0.88)" }}>than a fixed fee · {num(k.taken, 2)} vs {num(k.fixed, 2)} AUSD</div>
            <div style={{ fontFamily: mono, fontSize: 16, marginTop: 30, color: "rgba(255,255,255,0.75)" }}>{k.file}</div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 300, fontWeight: 800, letterSpacing: "-0.07em", lineHeight: 1 }}>0 <span style={{ fontSize: 120, opacity: 0.8 }}>vs</span> <Count to={x.naive.summary.crossLaneEdges} at={t0} dur={14} /></div>
            <div style={{ fontSize: 76, fontWeight: 800, letterSpacing: "-0.05em", marginTop: 10 }}>
              cross-lane <span style={{ fontFamily: serif, fontStyle: "italic", fontWeight: 400 }}>dependencies</span>
            </div>
            <div style={{ fontSize: 30, fontWeight: 500, marginTop: 14, color: "rgba(255,255,255,0.88)" }}>Paraclr's lanes vs a shared-state build of the same contract</div>
            <div style={{ fontFamily: mono, fontSize: 16, marginTop: 30, color: "rgba(255,255,255,0.75)" }}>{x.file} · {x.method}</div>
          </>
        )}
      </div>
    </AbsoluteFill>
  );
};

const SCENES: Record<string, React.FC> = { problem: Problem, turn: Turn, pmontage: Montage, pproof: Proof, close: Close };

const voFrames = (id: keyof typeof vo) => [VO[id as "race" | "turn" | "fair"], VO[id as "race" | "turn" | "fair"] + Math.round(vo[id].seconds * FPS)] as const;
const DUCK = (f: number) => Math.max(...(["race", "turn", "fair"] as const).map((id) => { const [a, b] = voFrames(id); return interpolate(f, [a - 6, a, b, b + 8], [0, 1, 1, 0], clamp); }));
const musicVol = (f: number) => (0.62 - 0.26 * DUCK(f)) * interpolate(f, [PROMO_FRAMES - 20, PROMO_FRAMES], [1, 0], clamp);

interface Fx { file: string; at: number; vol: number }
const FX: Fx[] = [
  { file: "race", at: 2, vol: 0.45 },
  { file: "stamp", at: 48, vol: 0.45 },
  { file: "thud", at: 66, vol: 0.5 },
  { file: "impact", at: bf(0) - 2, vol: 0.42 },
  { file: "sweep", at: bf(0), vol: 0.25 },
  ...CUTS.slice(1, 6).map((c) => ({ file: "whoosh", at: S.pmontage[0] + c - 4, vol: 0.28 })),
  { file: "click", at: S.pmontage[0] + CUTS[3] + 28, vol: 0.45 },
  { file: "crash", at: S.pmontage[0] + CUTS[3] + 30, vol: 0.45 },
  { file: "impact", at: S.pproof[0] - 2, vol: 0.4 },
  { file: "pop", at: S.pproof[0] + (S.pproof[1] - S.pproof[0]) / 2 - 2, vol: 0.4 },
  { file: "bell", at: S.close[0], vol: 0.4 },
];

export const Promo: React.FC = () => (
  <TimingCtx.Provider value={PT}>
    <AbsoluteFill style={{ background: C.night }}>
      {PT.scenes.map((s) => {
        const Sc = SCENES[s.id];
        return <Sequence key={s.id} from={s.from} durationInFrames={s.durationInFrames} name={s.id}><Sc /></Sequence>;
      })}
      <Grain opacity={0.07} />
      <Chrome hideAfter={S.close[0] - 6} />
      <Audio src={staticFile("audio/promo-cue.mp3")} volume={musicVol} />
      {(["race", "turn", "fair"] as const).map((id) => (
        <Sequence key={id} from={VO[id]} durationInFrames={Math.round(vo[id].seconds * FPS) + 4} name={`vo ${id}`}>
          <Audio src={staticFile(vo[id].file)} volume={1} />
        </Sequence>
      ))}
      {FX.filter((x) => x.at >= 0).map((x, i) => (
        <Sequence key={`fx${i}`} from={Math.round(x.at)} durationInFrames={90} name={`fx ${x.file}`}>
          <Audio src={staticFile(`audio/sfx/${x.file}.mp3`)} volume={x.vol} />
        </Sequence>
      ))}
    </AbsoluteFill>
  </TimingCtx.Provider>
);
