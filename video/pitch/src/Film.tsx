import React from "react";
import { AbsoluteFill, Audio, Freeze, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import { T, scene, wordAt } from "./timing";
import { C } from "./theme";
import { Chrome } from "./ui/Chrome";
import { Captions } from "./ui/Captions";
import { Grain } from "./ui/Grain";
import { clamp } from "./ui/motion";
import { Reveal } from "./scenes/Reveal";
import { Founder } from "./scenes/Founder";
import { Record } from "./scenes/Record";
import { Why } from "./scenes/Why";
import { Paraclr } from "./scenes/Paraclr";
import { Close } from "./scenes/Close";
import fx from "./sfx.json";

const SCENES: Record<string, React.FC> = { reveal: Reveal, founder: Founder, record: Record, why: Why, paraclr: Paraclr, close: Close };
const OVERLAP = 12; // frames each scene starts early, to cross-dissolve with the last

/** Each scene eases in over the tail of the previous one, holding its own first frame meanwhile. */
const SceneIn: React.FC<{ S: React.FC; first: boolean }> = ({ S, first }) => {
  const f = useCurrentFrame();
  if (first) return <S />;
  const p = interpolate(f, [0, OVERLAP], [0, 1], { ...clamp, easing: (t) => 1 - Math.pow(1 - t, 3) });
  const body = f < OVERLAP ? <Freeze frame={0}><S /></Freeze> : <Sequence from={OVERLAP} layout="none"><S /></Sequence>;
  return <AbsoluteFill style={{ opacity: p, transform: `scale(${1.025 - 0.025 * p})`, filter: p < 1 ? `blur(${(1 - p) * 10}px)` : undefined }}>{body}</AbsoluteFill>;
};

// --- Music, ducked under the voice.
const SPEECH = T.scenes.flatMap((s) => s.lines.map((l) => [l.words[0].start, l.words[l.words.length - 1].end] as const));
const DUCK: number[] = (() => {
  const v = new Array<number>(T.totalFrames + 1).fill(0);
  for (let f = 0; f <= T.totalFrames; f++) {
    let d = 0;
    for (const [a, b] of SPEECH) d = Math.max(d, interpolate(f, [a - 10, a, b, b + 16], [0, 1, 1, 0], clamp));
    v[f] = d;
  }
  return v;
})();
const musicVolume = (f: number) => {
  const end = T.totalFrames;
  const fadeIn = interpolate(f, [0, 12], [0, 1], clamp);
  const fadeOut = interpolate(f, [end - 50, end], [1, 0], clamp);
  return (0.5 - 0.34 * DUCK[Math.min(end, Math.max(0, f))]) * fadeIn * fadeOut;
};

// --- Sound effects (src/sfx.json): each placed on a scene start or a spoken word, with an offset.
interface Cue { file: string; scene: string; word?: string; nth?: number; off?: number; vol: number; dur?: number }
const effects = (fx as Cue[]).map((c) => ({ ...c, at: (c.word ? wordAt(c.scene, c.word, c.nth ?? 0) : scene(c.scene).from) + (c.off ?? 0) })).filter((c) => c.at >= 0 && c.at < T.totalFrames);

export const Film: React.FC = () => (
  <AbsoluteFill style={{ background: C.black }}>
    {T.scenes.map((s, i) => {
      const S = SCENES[s.id];
      const from = i === 0 ? s.from : s.from - OVERLAP;
      const dur = s.durationInFrames + (i === 0 ? 0 : OVERLAP);
      return (
        <Sequence key={s.id} from={from} durationInFrames={dur} name={s.id}>
          <SceneIn S={S} first={i === 0} />
        </Sequence>
      );
    })}
    <Grain opacity={0.08} />
    <Chrome showFrom={wordAt("reveal", "independent")} hideAfter={scene("close").from - 6} />
    <Captions hidden={(f) => f >= scene("close").from - 4} />
    {T.music.source !== "none" ? <Audio src={staticFile(T.music.file)} volume={musicVolume} /> : null}
    {T.scenes.flatMap((s) => s.lines).filter((l) => l.file).map((l, i) => (
      <Sequence key={`vo${i}`} from={l.startFrame} durationInFrames={l.durationFrames + 2} name={`vo ${l.text.slice(0, 18)}`}>
        <Audio src={staticFile(l.file!)} volume={1} />
      </Sequence>
    ))}
    {effects.map((x, i) => (
      <Sequence key={`fx${i}`} from={x.at} durationInFrames={x.dur ?? 150} name={`fx ${x.file}`}>
        <Audio src={staticFile(`audio/sfx/${x.file}.mp3`)} volume={(f) => x.vol * (x.dur ? interpolate(f, [0, 4, x.dur - 12, x.dur], [0, 1, 1, 0], clamp) : 1)} />
      </Sequence>
    ))}
  </AbsoluteFill>
);
