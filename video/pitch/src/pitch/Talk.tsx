import React from "react";
import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import data from "../edit.json";
import fx from "./fx.json";
import { C, display, mono } from "../theme";
import { Grain } from "../ui/Grain";
import { clamp, expo } from "../ui/motion";
import { Card, LowerThird } from "./cards";
import { EndCard } from "./EndCard";

/**
 * The founder's on-camera pitch (UseParaclr.MOV), tightened at the word level by scripts/edit.mjs:
 * head and tail, fillers, false starts and long pauses cut. Every cut alternates the framing (1.0 / 1.06)
 * so jump cuts read as edits; audio crossfades 2 frames across each cut. Cards land on his words.
 */
type Seg = { src: number; len: number; out: number };
type W = { i: number; text: string; start: number; end: number };
const P = data as { fps: number; speechFrames: number; outro: number; total: number; segments: Seg[]; words: W[] };
export const TALK_FRAMES = P.total;
/** Output frame where source word #i (transcript index) is spoken; the next kept word if #i was cut. */
const at = (i: number) => (P.words.find((x) => x.i >= i) ?? { start: P.speechFrames }).start;
const endOf = (i: number) => { const w = [...P.words].reverse().find((x) => x.i <= i); return w ? w.end : 0; };

export type TalkProps = { hi: boolean };

const Footage: React.FC<{ hi: boolean }> = ({ hi }) => (
  <>
    {P.segments.map((s, k) => (
      <Sequence key={k} from={s.out} durationInFrames={s.len} name={`cut ${k}`}>
        <Clip seg={s} k={k} hi={hi} />
      </Sequence>
    ))}
  </>
);
const Clip: React.FC<{ seg: Seg; k: number; hi: boolean }> = ({ seg, k, hi }) => {
  const f = useCurrentFrame();
  const base = k % 2 === 0 ? 1.0 : 1.06;
  const s = base + 0.01 * (f / Math.max(1, seg.len));
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <OffthreadVideo src={staticFile(hi ? "footage/use-4k.mp4" : "footage/use-1080.mp4")} trimBefore={seg.src} muted
        style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${s})`, transformOrigin: "50% 30%" }} />
    </AbsoluteFill>
  );
};

/** His cleaned voice, cut on the same frames as the picture, with 2-frame crossfades across every cut. */
const XF = 2;
const Voice: React.FC = () => (
  <>
    {P.segments.map((s, k) => {
      const pre = Math.min(XF, s.src, k === 0 ? 0 : XF);
      return (
        <Sequence key={k} from={s.out - pre} durationInFrames={s.len + pre + XF} name={`voice ${k}`}>
          <Audio src={staticFile("audio/voice.wav")} trimBefore={s.src - pre}
            volume={(f) => (pre ? interpolate(f, [0, pre], [0, 1], clamp) : 1) * interpolate(f, [s.len + pre, s.len + pre + XF], [1, 0], clamp)} />
        </Sequence>
      );
    })}
  </>
);

/** Word-lit captions on a dark pill, a phrase at a time. */
const Captions: React.FC = () => {
  const f = useCurrentFrame();
  if (f >= P.speechFrames) return null;
  const sentences: W[][] = [];
  let cur: W[] = [];
  P.words.forEach((w, k) => {
    const next = P.words[k + 1];
    cur.push(w);
    if (/[.?!]$/.test(w.text) || !next || next.start - w.end > 12) { sentences.push(cur); cur = []; }
  });
  if (cur.length) sentences.push(cur);
  const chunks: W[][] = [];
  for (const s of sentences) {
    const n = Math.ceil(s.length / 7);
    const size = Math.ceil(s.length / n);
    for (let k = 0; k < s.length; k += size) chunks.push(s.slice(k, k + size));
  }
  const c = chunks.find((ch) => f >= ch[0].start - 3 && f <= ch[ch.length - 1].end + 6);
  if (!c) return null;
  const op = interpolate(f, [c[0].start - 3, c[0].start + 2], [0, 1], clamp);
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 62, display: "flex", justifyContent: "center", opacity: op }}>
      <div style={{ maxWidth: 1300, textAlign: "center", padding: "10px 26px", borderRadius: 16, background: "rgba(8,8,10,0.8)", backdropFilter: "blur(16px)", border: "1px solid rgba(255,255,255,0.08)",
        fontFamily: display, fontStretch: "100%", fontWeight: 600, fontSize: 36, letterSpacing: "-0.005em", lineHeight: 1.3 }}>
        {c.map((w, k) => <span key={k} style={{ color: f >= w.start - 1 ? C.white : "rgba(255,255,255,0.42)" }}>{w.text} </span>)}
      </div>
    </div>
  );
};

/** Product cutaway: a real app clip in a browser shell on black, with him in a picture-in-picture so the talk carries on. */
type Cut = { a: number; len: number; file: string; from: number; url: string; zoom?: { x: number; y: number; s: number } };
const Cutaway: React.FC<{ c: Cut; hi: boolean }> = ({ c, hi }) => {
  const f = useCurrentFrame();
  const p = interpolate(f, [0, 8, c.len - 8, c.len], [0, 1, 1, 0], { ...clamp, easing: expo });
  const z = c.zoom ? interpolate(f, [0, c.len], [c.zoom.s, c.zoom.s * 1.04]) : interpolate(f, [0, c.len], [1, 1.03]);
  const FW = 1560, FH = FW * 9 / 16;
  return (
    <AbsoluteFill style={{ opacity: p }}>
      <AbsoluteFill style={{ background: "radial-gradient(60% 60% at 50% 45%, #17141c, #000 80%)" }} />
      <div style={{ position: "absolute", left: (1920 - FW) / 2, top: 64, width: FW, height: FH + 36, borderRadius: 14, overflow: "hidden", background: "#0b0b0b",
        boxShadow: "0 0 0 1px rgba(255,255,255,0.14), 0 50px 110px rgba(0,0,0,0.8)", transform: `scale(${0.97 + 0.03 * p})` }}>
        <div style={{ height: 36, display: "flex", alignItems: "center", gap: 8, padding: "0 16px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
          {[0, 1, 2].map((i) => <span key={i} style={{ width: 10, height: 10, borderRadius: 5, border: "1px solid rgba(255,255,255,0.3)" }} />)}
          <span style={{ marginLeft: 18, fontFamily: mono, fontSize: 15, letterSpacing: "0.06em", color: C.muted }}>{c.url}</span>
          <span style={{ marginLeft: "auto", fontFamily: mono, fontSize: 13, letterSpacing: "0.16em", color: C.dim }}>REAL APP · MONAD TESTNET · TEST FUNDS</span>
        </div>
        <div style={{ width: FW, height: FH, overflow: "hidden" }}>
          <OffthreadVideo src={staticFile(c.file)} trimBefore={c.from} muted
            style={{ width: FW, height: FH, transform: `scale(${z})`, transformOrigin: c.zoom ? `${c.zoom.x * 100}% ${c.zoom.y * 100}%` : "50% 50%" }} />
        </div>
      </div>
      {/* him, still talking */}
      <div style={{ position: "absolute", right: 44, bottom: 150, width: 384, height: 216, borderRadius: 16, overflow: "hidden", boxShadow: "0 0 0 2px rgba(255,255,255,0.5), 0 20px 50px rgba(0,0,0,0.6)" }}>
        <div style={{ width: 1920, height: 1080, transform: "scale(0.2)", transformOrigin: "0 0" }}>
          <Sequence from={-c.a} layout="none"><Footage hi={hi} /></Sequence>
        </div>
      </div>
    </AbsoluteFill>
  );
};

const CUTS: Cut[] = [
  // "The discount starts at zero, and it rises every block": the landing's live auction clock
  { a: at(130) - 4, len: endOf(139) - at(130) + 16, file: "footage/hero.mp4", from: 120, url: "paraclr.xyz · auction clock", zoom: { x: 0.85, y: 0.5, s: 1.45 } },
  // "Every account lives in one of its lanes with its own storage, so a crash in one lane never touches another"
  { a: at(173) - 4, len: endOf(193) - at(173) + 14, file: "footage/arena.mp4", from: 309, url: "paraclr.xyz/arena · 8 lanes" },
  // "zero cross-lane dependencies against forty-nine on a shared-state build"
  { a: at(225) - 6, len: endOf(235) - at(225) + 16, file: "footage/arena_xray.mp4", from: 318, url: "paraclr.xyz/arena · conflict x-ray" },
  // "You can crash the market yourself in the arena"
  { a: at(243) - 4, len: endOf(251) - at(243) + 20, file: "footage/arena.mp4", from: 96, url: "paraclr.xyz/arena" },
];
export const CUT_RANGES = CUTS.map((c) => [c.a, c.a + c.len] as const);

export const Talk: React.FC<TalkProps> = ({ hi }) => {
  const f = useCurrentFrame();
  const L = 64, R = -64, Y = 64;
  const inCut = CUTS.some((c) => f >= c.a + 4 && f < c.a + c.len - 4);
  const wm = interpolate(f, [P.speechFrames - 6, P.speechFrames + 6], [1, 0], clamp);
  // Bed: matched to the Fitr pitch. bed.mp3 is -18.7 LUFS, so 0.06 puts it ~27 dB under the -16 LUFS voice (Fitr: ~26 dB);
  // on the end card 0.32, ~13 dB under voice level (Fitr: ~13 dB).
  const bed = (fr: number) => interpolate(fr, [0, 20, P.total - 30, P.total], [0, 1, 1, 0], clamp)
    * (0.06 + interpolate(fr, [P.speechFrames - 4, P.speechFrames + 10], [0, 0.26], clamp));
  return (
    <AbsoluteFill style={{ background: C.black }}>
      <Footage hi={hi} />
      {CUTS.map((c, k) => <Sequence key={k} from={c.a} durationInFrames={c.len} name={`cutaway ${k}`}><Cutaway c={c} hi={hi} /></Sequence>)}

      <LowerThird a={at(1)} b={at(8) + 40} name="MrNetwork" title="Founder · NetLayer Labs" left={L} bottom={170} />
      <Card a={at(9)} b={endOf(20) + 20} title="NetLayer Labs · Italy" sub="Independent product studio" x={R} y={Y} />
      <Card a={at(24)} b={endOf(37) + 10} title="Agents · infra · apps" sub="autonomous agents · onchain infrastructure" x={L} y={Y} />
      <Card a={at(42)} b={endOf(51) + 16} title="5 shipped · 3 on mainnet" sub="netlayerlabs.com" x={R} y={Y} big />
      <Card a={at(57)} b={endOf(69) + 20} title="Calmr · 1st place" sub={"Visko Orbis challenge · $4\u2009000"} x={L} y={Y} />
      <Card a={at(86)} b={endOf(103) + 16} title="Gas race" sub="the winner takes a fixed penalty, set in advance" x={R} y={Y} />
      <Card a={at(118)} b={at(124)} title="Paraclr" sub="a NetLayer Labs product" x={L} y={Y} paraclr />
      <Card a={at(126)} b={endOf(129) + 70} title="Per-block Dutch auction" sub="the block clock replaces the gas race" x={L} y={Y} />
      <Card a={at(130) + 6} b={endOf(139) + 10} title="0 → +5 bps per block" sub="discount on the live testnet" x={L} y={Y} />
      <Card a={at(154)} b={endOf(163) + 16} title="The rest goes back to the trader" sub="whatever the auction doesn't need" x={R} y={Y} />
      <Card a={at(171) + 4} b={endOf(193) + 10} title="8 lanes · own storage" sub="a crash in one never touches another" x={L} y={Y} />
      <Card a={at(198)} b={endOf(201) + 14} title="Built for Monad" sub="parallel execution" x={R} y={Y} />
      <Card a={at(212)} b={endOf(220) + 20} title="28% less taken from traders" sub={"1\u2009052.41 vs 1\u2009464.26 AUSD · vs a fixed fee"} x={R} y={Y} big />
      <Card a={at(225) + 2} b={endOf(235) + 16} title="0 vs 49" sub="cross-lane dependencies · lanes vs shared state" x={L} y={Y} big />
      <Card a={at(239)} b={endOf(253) + 20} title="Live on Monad testnet" sub="paraclr.xyz · crash it in the Arena" x={R} y={Y} paraclr />
      <Card a={at(257)} b={P.speechFrames + 2} title="Fair liquidations for Monad." sub="paraclr.xyz" x={L} y={Y} />

      <Captions />
      <div style={{ position: "absolute", right: 46, bottom: 30, display: "flex", alignItems: "center", gap: 12, opacity: wm }}>
        <span style={{ fontFamily: mono, fontSize: 13, letterSpacing: "0.14em", color: inCut ? "rgba(255,255,255,0.6)" : "rgba(20,10,30,0.6)" }}>BUILT BY</span>
        <Img src={staticFile("brand/nl-mark.png")} style={{ height: 24, filter: inCut ? undefined : "brightness(0)", opacity: inCut ? 0.9 : 0.72 }} />
        <Img src={staticFile("brand/nl-word.png")} style={{ height: 18, filter: inCut ? undefined : "brightness(0)", opacity: inCut ? 0.9 : 0.72 }} />
      </div>
      <Sequence from={P.speechFrames} durationInFrames={P.outro}><EndCard /></Sequence>
      <Grain opacity={0.03} />

      <Voice />
      <Audio src={staticFile("audio/bed.mp3")} volume={bed} />
      {(fx as { file: string; word?: number; at?: string; off?: number; vol: number }[]).map((x, k) => {
        const t = (x.at === "end" ? P.speechFrames : x.at === "cut" ? 0 : at(x.word ?? 0)) + (x.off ?? 0);
        return <Sequence key={k} from={Math.max(0, t)} durationInFrames={90}><Audio src={staticFile(`audio/sfx/${x.file}.mp3`)} volume={x.vol} /></Sequence>;
      })}
      {CUTS.map((c, k) => <Sequence key={`w${k}`} from={c.a - 4} durationInFrames={40}><Audio src={staticFile("audio/sfx/whoosh.mp3")} volume={0.22} /></Sequence>)}
    </AbsoluteFill>
  );
};
