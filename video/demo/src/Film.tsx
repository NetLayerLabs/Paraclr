import React from "react";
import { AbsoluteFill, Audio, Freeze, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import { T, scene, wordAt } from "./timing";
import { C } from "./theme";
import { Chrome } from "./ui/Chrome";
import { Captions } from "./ui/Captions";
import { Grain } from "./ui/Grain";
import { clamp } from "./ui/motion";
import { Open } from "./scenes/Open";
import { Problem } from "./scenes/Problem";
import { Turn } from "./scenes/Turn";
import { Clock } from "./scenes/Clock";
import { LanesScene } from "./scenes/LanesScene";
import { App } from "./scenes/App";
import { Arena } from "./scenes/Arena";
import { Kept } from "./scenes/Kept";
import { Xray } from "./scenes/Xray";
import { BuiltOn } from "./scenes/BuiltOn";
import { Close } from "./scenes/Close";

const SCENES: Record<string, React.FC> = {
  open: Open, problem: Problem, turn: Turn, clock: Clock, lanes: LanesScene, app: App,
  arena: Arena, kept: Kept, xray: Xray, builton: BuiltOn, close: Close,
};
const OVERLAP = 10; // frames each scene starts early, to cross-dissolve with the last

/** Each scene eases in over the tail of the previous one, holding its own first frame meanwhile. */
const SceneIn: React.FC<{ S: React.FC; first: boolean }> = ({ S, first }) => {
  const f = useCurrentFrame();
  if (first) return <S />;
  const p = interpolate(f, [0, OVERLAP], [0, 1], { ...clamp, easing: (t) => 1 - Math.pow(1 - t, 3) });
  const body = f < OVERLAP ? <Freeze frame={0}><S /></Freeze> : <Sequence from={OVERLAP} layout="none"><S /></Sequence>;
  return <AbsoluteFill style={{ opacity: p, transform: `scale(${1.03 - 0.03 * p})`, filter: p < 1 ? `blur(${(1 - p) * 10}px)` : undefined }}>{body}</AbsoluteFill>;
};

// --- Music, ducked under every spoken line.
const LINES = T.scenes.flatMap((s) => s.lines.map((l) => [l.startFrame, l.words[l.words.length - 1].end] as const));
const DUCK: number[] = (() => {
  const v = new Array<number>(T.totalFrames + 1).fill(0);
  for (let f = 0; f <= T.totalFrames; f++) {
    let d = 0;
    for (const [a, b] of LINES) d = Math.max(d, interpolate(f, [a - 10, a, b, b + 14], [0, 1, 1, 0], clamp));
    v[f] = d;
  }
  return v;
})();
const musicVolume = (f: number) => {
  const end = T.totalFrames;
  const fadeIn = interpolate(f, [0, 18], [0, 1], clamp);
  const fadeOut = interpolate(f, [end - 60, end], [1, 0], clamp);
  return (0.55 - 0.37 * DUCK[Math.min(end, Math.max(0, f))]) * fadeIn * fadeOut;
};

interface Fx { file: string; at: number; vol: number; dur?: number }
function effects(): Fx[] {
  const sc = (id: string) => scene(id).from;
  const w = (id: string, word: string, n = 0) => wordAt(id, word, n);
  const fx: Fx[] = [
    { file: "ticker", at: 0, vol: 0.22, dur: 75 },
    { file: "glitch", at: w("open", "October") - 6, vol: 0.3 },
    { file: "ticker", at: w("open", "nineteen") - 30, vol: 0.2, dur: 60 },
    { file: "stamp", at: w("open", "nineteen") + 22, vol: 0.4 },
    { file: "blip", at: w("open", "One") + 28, vol: 0.35 },
    { file: "whoosh", at: sc("problem") - 6, vol: 0.28 },
    { file: "race", at: w("problem", "race.") - 6, vol: 0.4 },
    { file: "stamp", at: w("problem", "first.") + 2, vol: 0.5 },
    { file: "thud", at: w("problem", "penalty") + 8, vol: 0.5 },
    { file: "alert", at: w("problem", "trader") - 2, vol: 0.25 },
    { file: "riser", at: sc("turn") - 95, vol: 0.38 },
    { file: "sweep", at: sc("turn") - 2, vol: 0.35 },
    { file: "impact", at: w("turn", "Paraclr") - 3, vol: 0.55 },
    { file: "bell", at: w("turn", "auctioned.") - 2, vol: 0.3 },
    { file: "whoosh", at: sc("clock") - 6, vol: 0.25 },
    ...Array.from({ length: 20 }, (_, k) => ({ file: "tick", at: w("clock", "On") + 2 + k * 10, vol: 0.16 })),
    { file: "chime", at: w("clock", "seventy-five,") - 2, vol: 0.3 },
    { file: "click", at: w("clock", "More") - 2, vol: 0.35 },
    { file: "sweep", at: sc("lanes") - 4, vol: 0.3 },
    { file: "alert", at: w("lanes", "crash") - 2, vol: 0.28 },
    { file: "pop", at: w("lanes", "storage.") - 2, vol: 0.32 },
    { file: "chime", at: w("lanes", "another.") + 30, vol: 0.25 },
    { file: "whoosh", at: sc("app") - 6, vol: 0.25 },
    { file: "click", at: w("app", "Sign") - 2, vol: 0.35 },
    { file: "pop", at: w("app", "Privy,") - 2, vol: 0.3 },
    { file: "chime", at: w("app", "No") + 6, vol: 0.25 },
    { file: "click", at: w("app", "drip,") + 2, vol: 0.35 },
    { file: "click", at: w("app", "faucet,") - 6, vol: 0.35 },
    { file: "pop", at: w("app", "Agora's") - 4, vol: 0.3 },
    { file: "click", at: w("app", "SOL.") - 2, vol: 0.35 },
    { file: "pop", at: w("app", "Pyth") - 4, vol: 0.3 },
    { file: "chime", at: w("app", "nobody") - 4, vol: 0.3 },
    { file: "whoosh", at: sc("arena") - 6, vol: 0.25 },
    { file: "click", at: w("arena", "Arena.") - 10, vol: 0.4 },
    { file: "crash", at: w("arena", "drops") - 6, vol: 0.5 },
    ...[0, 1, 2, 3].map((k) => ({ file: "blip", at: w("arena", "lane", 1) - 6 + k * 9, vol: 0.22 })),
    { file: "sweep", at: sc("kept") - 4, vol: 0.28 },
    { file: "impact", at: w("kept", "twenty-eight") - 4, vol: 0.32 },
    { file: "chime", at: w("kept", "Whatever") + 2, vol: 0.28 },
    { file: "glitch", at: sc("xray") - 4, vol: 0.22 },
    ...Array.from({ length: 7 }, (_, k) => ({ file: "blip", at: w("xray", "forty-nine") - 8 + k * 5, vol: 0.16 })),
    { file: "chime", at: w("xray", "zero.") - 2, vol: 0.35 },
    { file: "whoosh", at: sc("builton") - 6, vol: 0.25 },
    ...["Monad.", "Agora", "Pyth", "Privy", "Envio"].map((x) => ({ file: "pop", at: w("builton", x) - 4, vol: 0.3 })),
    { file: "stamp", at: w("builton", "Not") + 2, vol: 0.55 },
    { file: "whoosh", at: sc("close") - 6, vol: 0.28 },
    { file: "bell", at: w("close", "Paraclr.") - 2, vol: 0.35 },
    { file: "pop", at: w("close", "paraclr") - 4, vol: 0.32 },
  ];
  return fx.filter((x) => x.at >= 0 && x.at < T.totalFrames);
}

/** Scenes whose big type or cards already carry the words: captions sit out. */
const NO_CAPTIONS = new Set(["open", "turn", "kept", "builton", "close"]);

export const Film: React.FC = () => {
  const hideCaptions = (f: number) => {
    const s = T.scenes.find((x) => f >= x.from && f < x.from + x.durationInFrames);
    return !s || NO_CAPTIONS.has(s.id);
  };
  return (
    <AbsoluteFill style={{ background: C.night }}>
      {T.scenes.map((s, i) => {
        const S = SCENES[s.id];
        const from = i === 0 ? s.from : s.from - OVERLAP;
        const dur = s.durationInFrames + (i === 0 ? 0 : OVERLAP);
        return S ? (
          <Sequence key={s.id} from={from} durationInFrames={dur} name={s.id}>
            <SceneIn S={S} first={i === 0} />
          </Sequence>
        ) : null;
      })}
      <Grain opacity={0.07} />
      <Chrome hideAfter={wordAt("close", "paraclr") + 8} />
      <Captions hidden={hideCaptions} />
      <Audio src={staticFile("audio/music.mp3")} volume={musicVolume} />
      {T.scenes.flatMap((s) => s.lines).map((l, i) => (
        <Sequence key={`vo${i}`} from={l.startFrame} durationInFrames={l.durationFrames} name={`vo ${l.text.slice(0, 18)}`}>
          <Audio src={staticFile(l.file)} volume={1} />
        </Sequence>
      ))}
      {effects().map((x, i) => (
        <Sequence key={`fx${i}`} from={x.at} durationInFrames={x.dur ?? 120} name={`fx ${x.file}`}>
          <Audio src={staticFile(`audio/sfx/${x.file}.mp3`)} volume={(f) => x.vol * (x.dur ? interpolate(f, [0, 6, x.dur - 18, x.dur], [0, 1, 1, 0], clamp) : 1)} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
