import React from "react";
import { AbsoluteFill, Audio, Freeze, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import raw from "./timing-tech.json";
import { Timing, TimingCtx, findWord, sceneIn } from "./timing";
import { C } from "./theme";
import { Chrome } from "./ui/Chrome";
import { Captions } from "./ui/Captions";
import { Grain } from "./ui/Grain";
import { clamp } from "./ui/motion";
import { Open } from "./scenes/Open";
import { Problem } from "./scenes/Problem";
import { Turn } from "./scenes/Turn";
import { Arena } from "./scenes/Arena";
import { BuiltOn } from "./scenes/BuiltOn";
import { Close } from "./scenes/Close";
import { TSignin, TFund, TOpen, TClose, TChain, TClearing, TBackstop, TXray } from "./tech/Scenes";

/**
 * The technical demo: the working product first. The same voice, look and motif as the film,
 * with the app, Clearing, Backstop, Arena, X-ray and explorer as recorded on paraclr.xyz.
 */
export const TT = raw as unknown as Timing;

const SCENES: Record<string, React.FC> = {
  open: Open, problem: Problem, turn: Turn, tsignin: TSignin, tfund: TFund, topen: TOpen, tclose: TClose, tchain: TChain,
  tclearing: TClearing, tbackstop: TBackstop, arena: Arena, txray: TXray, builton: BuiltOn, close: Close,
};
const OVERLAP = 10;
// The score was written to the film's timeline; starting it 108 frames in puts its hit on this cut's logo.
const MUSIC_OFFSET = 108;

const SceneIn: React.FC<{ S: React.FC; first: boolean }> = ({ S, first }) => {
  const f = useCurrentFrame();
  if (first) return <S />;
  const p = interpolate(f, [0, OVERLAP], [0, 1], { ...clamp, easing: (t) => 1 - Math.pow(1 - t, 3) });
  const body = f < OVERLAP ? <Freeze frame={0}><S /></Freeze> : <Sequence from={OVERLAP} layout="none"><S /></Sequence>;
  return <AbsoluteFill style={{ opacity: p, transform: `scale(${1.03 - 0.03 * p})`, filter: p < 1 ? `blur(${(1 - p) * 10}px)` : undefined }}>{body}</AbsoluteFill>;
};

const LINES = TT.scenes.flatMap((s) => s.lines.map((l) => [l.startFrame, l.words[l.words.length - 1].end] as const));
const DUCK: number[] = (() => {
  const v = new Array<number>(TT.totalFrames + 1).fill(0);
  for (let f = 0; f <= TT.totalFrames; f++) {
    let d = 0;
    for (const [a, b] of LINES) d = Math.max(d, interpolate(f, [a - 10, a, b, b + 14], [0, 1, 1, 0], clamp));
    v[f] = d;
  }
  return v;
})();
const musicVolume = (f: number) => {
  const end = TT.totalFrames;
  return (0.55 - 0.37 * DUCK[Math.min(end, Math.max(0, f))]) * interpolate(f, [0, 18], [0, 1], clamp) * interpolate(f, [end - 60, end], [1, 0], clamp);
};

interface Fx { file: string; at: number; vol: number; dur?: number }
function effects(): Fx[] {
  const sc = (id: string) => sceneIn(TT, id).from;
  const w = (id: string, word: string, n = 0) => findWord(TT, id, word, n) ?? -1e6;
  const fx: Fx[] = [
    { file: "ticker", at: 0, vol: 0.22, dur: 75 },
    { file: "glitch", at: w("open", "October") - 6, vol: 0.3 },
    { file: "ticker", at: w("open", "nineteen") - 30, vol: 0.2, dur: 60 },
    { file: "stamp", at: w("open", "nineteen") + 22, vol: 0.4 },
    { file: "whoosh", at: sc("problem") - 6, vol: 0.28 },
    { file: "race", at: w("problem", "race.") - 6, vol: 0.4 },
    { file: "stamp", at: w("problem", "first.") + 2, vol: 0.5 },
    { file: "thud", at: w("problem", "penalty") + 8, vol: 0.5 },
    { file: "alert", at: w("problem", "trader") - 2, vol: 0.25 },
    { file: "sweep", at: sc("turn") - 2, vol: 0.35 },
    { file: "impact", at: w("turn", "Paraclr") - 3, vol: 0.55 },
    { file: "whoosh", at: sc("tsignin") - 6, vol: 0.25 },
    { file: "click", at: w("tsignin", "I") - 14, vol: 0.35 },
    { file: "pop", at: w("tsignin", "Privy,") - 2, vol: 0.3 },
    { file: "chime", at: w("tsignin", "No") + 8, vol: 0.25 },
    { file: "click", at: w("tfund", "drips") - 2, vol: 0.35 },
    { file: "click", at: w("tfund", "faucet") - 2, vol: 0.35 },
    { file: "pop", at: w("tfund", "Agora's") - 4, vol: 0.3 },
    { file: "click", at: w("topen", "deposit") + 8, vol: 0.35 },
    { file: "pop", at: w("topen", "Pyth") - 4, vol: 0.3 },
    { file: "chime", at: w("topen", "This") - 2, vol: 0.3 },
    { file: "click", at: sc("tclose") + 10, vol: 0.35 },
    { file: "click", at: sc("tclose") + 107, vol: 0.35 },
    { file: "chime", at: w("tclose", "with") - 4, vol: 0.3 },
    { file: "click", at: w("tchain", "indexes") + 4, vol: 0.3 },
    { file: "whoosh", at: w("tchain", "Here") - 8, vol: 0.28 },
    { file: "whoosh", at: sc("tclearing") - 6, vol: 0.25 },
    { file: "whoosh", at: sc("tbackstop") - 6, vol: 0.25 },
    { file: "whoosh", at: sc("arena") - 6, vol: 0.25 },
    { file: "click", at: w("arena", "Arena.") - 10, vol: 0.4 },
    { file: "crash", at: w("arena", "drops") - 6, vol: 0.5 },
    ...[0, 1, 2, 3].map((k) => ({ file: "blip", at: w("arena", "lane", 1) - 6 + k * 9, vol: 0.22 })),
    { file: "glitch", at: sc("txray") - 4, vol: 0.2 },
    { file: "chime", at: w("txray", "zero") - 2, vol: 0.3 },
    { file: "pop", at: w("txray", "zero", 1) - 4, vol: 0.32 },
    { file: "whoosh", at: sc("builton") - 6, vol: 0.25 },
    ...["Monad,", "Agora", "Pyth,", "Privy", "Envio."].map((x) => ({ file: "pop", at: w("builton", x) - 4, vol: 0.3 })),
    { file: "stamp", at: w("builton", "Not") + 2, vol: 0.55 },
    { file: "whoosh", at: sc("close") - 6, vol: 0.28 },
    { file: "bell", at: w("close", "Paraclr.") - 2, vol: 0.35 },
    { file: "pop", at: w("close", "paraclr") - 4, vol: 0.32 },
  ];
  return fx.filter((x) => x.at >= 0 && x.at < TT.totalFrames);
}

const NO_CAPTIONS = new Set(["open", "turn", "builton", "close"]);

export const TechDemo: React.FC = () => {
  const hideCaptions = (f: number) => {
    const s = TT.scenes.find((x) => f >= x.from && f < x.from + x.durationInFrames);
    return !s || NO_CAPTIONS.has(s.id);
  };
  const close = sceneIn(TT, "close");
  return (
    <TimingCtx.Provider value={TT}>
      <AbsoluteFill style={{ background: C.night }}>
        {TT.scenes.map((s, i) => {
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
        <Chrome hideAfter={(findWord(TT, "close", "paraclr") ?? close.from) + 8} />
        <Captions hidden={hideCaptions} />
        <Audio src={staticFile("audio/music.mp3")} startFrom={MUSIC_OFFSET} volume={musicVolume} />
        {TT.scenes.flatMap((s) => s.lines).map((l, i) => (
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
    </TimingCtx.Provider>
  );
};
