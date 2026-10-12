// Word-level edit of the founder's on-camera take -> src/edit.json
//   node scripts/edit.mjs
// Source: public/footage/UseParaclr.MOV (4K60; drafts read use-1080.mp4, the master use-4k.mp4, both 30 fps).
// Reads .cache/transcript.json (scripts/voice.mjs on the .MOV, then scripts/transcribe.mjs; same timeline as the video).
// Cuts: the head and tail, fillers and false starts (DROP), and pauses longer than the natural beat
// (PAUSE: after a stop, a comma, between words). Caption spellings are corrected in FIX (what he says, spelled right).
// Output frames @30: segments {src, len, out} and words {i, text, start, end} on the output timeline.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const FPS = 30;
const OUTRO = 150; // end card
const MAX = 3600;  // 2:00.0, the form's limit
const T = JSON.parse(readFileSync(join(ROOT, ".cache/transcript.json"), "utf8"));
const W = T.words.map((w, i) => ({ ...w, i }));

// Fillers, false starts and sentence-leading "So"s that carry no meaning.
const DROP = new Set([8, 21, 38, 70, 80, 91, 164, 165, 184, 185, 202, 229, 236, 254]);
// Spelling fixes for captions (index -> text); MERGE joins a word into the previous one.
const FIX = { 2: "MrNetwork,", 6: "NetLayer", 9: "NetLayer", 26: "onchain", 57: "Calmr,", 67: "Visko", 69: "challenge.", 72: "onchain,", 119: "Paraclr.", 233: "shared-state", 228: "against", 253: "paraclr.xyz.", 256: "Paraclr," };
const MERGE = new Set([3, 234]);
const PAUSE = { stop: +(process.env.STOP || 0.8), comma: +(process.env.COMMA || 0.55), word: +(process.env.WORDP || 0.34) };
const HEAD = 0.22, TAIL = 0.45;

const kept = W.filter((w) => !DROP.has(w.i));
const segs = [];
let cur = { a: kept[0].start - HEAD, b: null };
for (let k = 0; k < kept.length - 1; k++) {
  const a = kept[k], b = kept[k + 1];
  const dropped = W.slice(a.i + 1, b.i);
  const p = /[.!?]$/.test(a.text) ? PAUSE.stop : /[,;:]$/.test(a.text) ? PAUSE.comma : PAUSE.word;
  const gap = b.start - a.end;
  if (!dropped.length && gap <= p + 0.08) continue;
  const before = (dropped.length ? dropped[0].start : b.start) - a.end;
  const after = b.start - (dropped.length ? dropped.at(-1).end : a.end);
  const tail = Math.max(0.03, Math.min(before - 0.02, p * 0.6));
  const head = Math.max(0.04, Math.min(after - 0.02, p - tail));
  cur.b = a.end + tail;
  segs.push(cur);
  cur = { a: b.start - head, b: null };
}
cur.b = Math.min(kept.at(-1).end + TAIL, 118.55);
segs.push(cur);

// to frames, end to end
let out = 0;
const S = segs.map(({ a, b }) => {
  const src = Math.max(0, Math.round(a * FPS)), end = Math.round(b * FPS);
  const s = { src, len: end - src, out };
  out += s.len;
  return s;
}).filter((s) => s.len > 0);
const speechFrames = out;
const map = (t) => {
  const f = t * FPS;
  const s = S.find((x) => f >= x.src && f <= x.src + x.len) ?? S.find((x) => x.src > f) ?? S.at(-1);
  return s.out + Math.min(Math.max(0, f - s.src), s.len);
};
const words = [];
for (const w of kept) {
  if (MERGE.has(w.i)) { words.at(-1).end = Math.round(map(w.end)); continue; }
  let text = FIX[w.i] ?? w.text;
  if (!words.length || /[.!?]$/.test(words.at(-1).text)) text = text[0].toUpperCase() + text.slice(1); // a dropped "So" leaves a new sentence start
  words.push({ i: w.i, text, start: Math.round(map(w.start)), end: Math.round(map(w.end)) });
}
const total = speechFrames + OUTRO;
writeFileSync(join(ROOT, "src/edit.json"), JSON.stringify({ fps: FPS, speechFrames, outro: OUTRO, total, segments: S, words }));
const raw = (W.at(-1).end - W[0].start).toFixed(1);
console.log(`${S.length} segments; speech ${(speechFrames / FPS).toFixed(2)}s (raw speech span ${raw}s, file 118.6s) + outro ${OUTRO / FPS}s = ${(total / FPS).toFixed(2)}s`);
if (total > MAX) console.error(`OVER 2:00 by ${((total - MAX) / FPS).toFixed(2)}s`);
console.log(words.map((w) => w.text).join(" "));
