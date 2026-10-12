// Builds src/timing.json: every scene, and every word of the approved script, on a frame (30 fps).
//   node scripts/timing.mjs              synced to the founder's voice when .cache/transcript.json exists
//   PLACEHOLDER=1 node scripts/timing.mjs  even pacing from script.json's "seconds" (no audio)
//
// Synced mode:
//  1. Aligns the script's words to the transcript's (semi-global edit-distance DP, fuzzy word match,
//     numbers spelled out), so captions show the approved text at the times it is spoken.
//  2. Cuts each scene's speech out of .cache/voice-clean.wav. Pauses longer than CAP are trimmed to CAP
//     (breaths and gaps go), with 12 ms fades on every cut -> public/audio/vo/<scene>.wav.
//  3. Lays scenes end to end: lead (picture first) + speech + tail. Words map through the cuts to frames.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const FPS = 30;
const MAX = 3600; // hard ceiling 2:00
const script = JSON.parse(readFileSync(join(ROOT, "script.json"), "utf8"));
const TRANSCRIPT = join(ROOT, ".cache/transcript.json");
const SYNC = existsSync(TRANSCRIPT) && !process.env.PLACEHOLDER;
const CAP = { comma: 0.32, stop: 0.45, word: 0.2 }; // longest pause kept, seconds
const PAD = { pre: 0.07, post: 0.2 };

const toks = (text) => text.split(/\s+/).filter(Boolean);
const norm = (w) => w.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9']/g, "");

// --- numbers to words, so "5" / "$4,000" in a transcript match "Five" / "four thousand dollars"
const ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
function say(n) {
  if (n < 20) return [ONES[n]];
  if (n < 100) return [TENS[Math.floor(n / 10)], ...(n % 10 ? [ONES[n % 10]] : [])];
  if (n < 1000) return [ONES[Math.floor(n / 100)], "hundred", ...(n % 100 ? say(n % 100) : [])];
  if (n < 1e6) return [...say(Math.floor(n / 1000)), "thousand", ...(n % 1000 ? say(n % 1000) : [])];
  return [String(n)];
}
function expand(raw) {
  const m = raw.match(/^(\$)?([\d,]+)(st|nd|rd|th)?([.,!?]*)$/i);
  if (!m) { const n = norm(raw); return n ? [n] : []; }
  const n = parseInt(m[2].replace(/,/g, ""), 10);
  if (m[3]) return [{ 1: "first", 2: "second", 3: "third" }[n] || `${n}th`];
  return [...say(n), ...(m[1] ? ["dollars"] : [])];
}

const lev = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};
const sim = (a, b) => (a === b ? 1 : 1 - lev(a, b) / Math.max(a.length, b.length, 1));

/** Script word index -> { start, end } in transcript seconds. */
function align(sw, tw) {
  const n = sw.length, m = tw.length;
  const DEL = 1.0, INS = 0.45; // script word unspoken / extra transcript word
  const sub = (i, j) => { const s = sim(sw[i].n, tw[j].n); return s === 1 ? 0 : s >= 0.6 ? 0.5 : 1.3; };
  const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const B = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  for (let i = 1; i <= n; i++) { D[i][0] = i * DEL; B[i][0] = 1; }
  for (let j = 1; j <= m; j++) { D[0][j] = 0; B[0][j] = 2; } // free leading chatter
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const a = D[i - 1][j - 1] + sub(i - 1, j - 1), b = D[i - 1][j] + DEL, c = D[i][j - 1] + (i === n ? 0 : INS); // free trailing chatter
    if (a <= b && a <= c) { D[i][j] = a; B[i][j] = 0; } else if (b <= c) { D[i][j] = b; B[i][j] = 1; } else { D[i][j] = c; B[i][j] = 2; }
  }
  const map = new Array(n).fill(null);
  let i = n, j = m, cost = D[n][m];
  while (i > 0) {
    if (j > 0 && B[i][j] === 0) { map[i - 1] = tw[j - 1]; i--; j--; }
    else if (j === 0 || B[i][j] === 1) { i--; }
    else j--;
  }
  // unspoken script words: interpolate between neighbours
  for (let k = 0; k < n; k++) if (!map[k]) {
    const p = map.slice(0, k).reverse().find(Boolean), q = map.slice(k + 1).find(Boolean);
    const a = p ? p.end : (q ? q.start - 0.3 : 0), b = q ? q.start : a + 0.3;
    map[k] = { start: a, end: Math.max(a + 0.05, b), guessed: true };
  }
  return { map, cost };
}

const scenes = script.scenes.map((s) => ({ ...s, words: toks(s.text) }));
let out;

if (SYNC) {
  const T = JSON.parse(readFileSync(TRANSCRIPT, "utf8"));
  // Script words, each split into normalized sub-tokens; transcript words likewise (numbers expanded, time split evenly).
  const sw = [], owner = [];
  scenes.forEach((s, si) => s.words.forEach((w, wi) => expand(w).forEach((n) => { sw.push({ n }); owner.push([si, wi]); })));
  const tw = [];
  for (const w of T.words) {
    const parts = toks(w.text).flatMap(expand);
    parts.forEach((n, k) => {
      const d = (w.end - w.start) / parts.length;
      tw.push({ n, start: w.start + k * d, end: w.start + (k + 1) * d });
    });
  }
  const { map, cost } = align(sw, tw);
  // collapse sub-tokens back to script words
  const times = scenes.map((s) => s.words.map(() => null));
  map.forEach((t, k) => {
    const [si, wi] = owner[k];
    const cur = times[si][wi];
    times[si][wi] = cur ? { start: Math.min(cur.start, t.start), end: Math.max(cur.end, t.end), guessed: cur.guessed && t.guessed } : { ...t };
  });
  scenes.forEach((s, si) => s.words.forEach((_, wi) => { if (!times[si][wi]) times[si][wi] = { ...times[si][Math.max(0, wi - 1)] }; }));
  const guessed = times.flat().filter((t) => t.guessed).length;
  console.log(`aligned ${sw.length} script tokens to ${tw.length} transcript tokens (cost ${cost.toFixed(1)}; ${guessed} words not heard, interpolated)`);

  const SRC = join(ROOT, ".cache/voice-clean.wav");
  const srcDur = parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", SRC]).toString());
  mkdirSync(join(ROOT, "public/audio/vo"), { recursive: true });
  let t = 0;
  const outScenes = [];
  scenes.forEach((s, si) => {
    const ws = times[si];
    const prevEnd = si > 0 ? times[si - 1].at(-1).end + 0.05 : 0;
    const nextStart = si < scenes.length - 1 ? times[si + 1][0].start - 0.05 : srcDur;
    const a = Math.max(prevEnd, ws[0].start - PAD.pre), b = Math.min(nextStart, ws.at(-1).end + PAD.post);
    // segments: split at pauses longer than the cap for that boundary
    const segs = [[a, null]];
    for (let k = 0; k < ws.length - 1; k++) {
      const gap = ws[k + 1].start - ws[k].end;
      const cap = /[.!?]$/.test(s.words[k]) ? CAP.stop : /[,;:]$/.test(s.words[k]) ? CAP.comma : CAP.word;
      if (gap > cap + 0.06) { segs.at(-1)[1] = ws[k].end + cap * 0.55; segs.push([ws[k + 1].start - cap * 0.45, null]); }
    }
    segs.at(-1)[1] = b;
    // source time -> output seconds inside this scene's clip
    const offs = []; let acc = 0;
    for (const [x, y] of segs) { offs.push(acc - x); acc += y - x; }
    const mapT = (v) => { let k = segs.findIndex(([x, y]) => v >= x && v <= y); if (k < 0) k = segs.findIndex(([x]) => v < x); if (k < 0) k = segs.length - 1; const [x, y] = segs[k]; return Math.min(Math.max(v, x), y) + offs[k]; };
    const file = `audio/vo/${s.id}.wav`;
    const fc = segs.map(([x, y], k) => `[0:a]atrim=${x.toFixed(4)}:${y.toFixed(4)},asetpts=PTS-STARTPTS,afade=t=in:d=0.012,afade=t=out:st=${Math.max(0, y - x - 0.012).toFixed(4)}:d=0.012[s${k}]`).join(";")
      + ";" + segs.map((_, k) => `[s${k}]`).join("") + `concat=n=${segs.length}:v=0:a=1[o]`;
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", SRC, "-filter_complex", fc, "-map", "[o]", "-ar", "48000", "-c:a", "pcm_s16le", join(ROOT, "public", file)]);
    const voFrames = Math.ceil(acc * FPS);
    const from = t, start = from + s.lead;
    const words = s.words.map((w, k) => ({ word: w, start: start + Math.round(mapT(ws[k].start) * FPS), end: start + Math.max(1, Math.round(mapT(ws[k].end) * FPS)) }));
    const dur = s.lead + voFrames + s.tail;
    outScenes.push({ id: s.id, from, durationInFrames: dur, lines: [{ text: s.text, file, startFrame: start, durationFrames: voFrames, words }] });
    console.log(`${s.id.padEnd(8)} src ${a.toFixed(2)}-${b.toFixed(2)}s  ${segs.length} segs  speech ${acc.toFixed(2)}s (cut ${(b - a - acc).toFixed(2)}s)  scene ${(dur / FPS).toFixed(1)}s`);
    t += dur;
  });
  out = { fps: FPS, placeholder: false, totalFrames: t, scenes: outScenes };
} else {
  // Even pacing: each word weighted by its length, plus a beat after commas and stops.
  let t = 0;
  const outScenes = scenes.map((s) => {
    const dur = s.seconds * FPS, from = t, start = from + s.lead;
    const avail = dur - s.lead - s.tail;
    const wt = s.words.map((w) => 0.55 + norm(w).length * 0.075);
    const pause = s.words.map((w) => (/[.!?]$/.test(w) ? 0.55 : /[,;:]$/.test(w) ? 0.3 : 0.04));
    const k = avail / (wt.reduce((a, b) => a + b, 0) + pause.slice(0, -1).reduce((a, b) => a + b, 0));
    let c = start;
    const words = s.words.map((w, i) => { const st = c, en = c + wt[i] * k; c = en + pause[i] * k; return { word: w, start: Math.round(st), end: Math.round(en) }; });
    t += dur;
    return { id: s.id, from, durationInFrames: dur, lines: [{ text: s.text, file: null, startFrame: start, durationFrames: avail, words }] };
  });
  out = { fps: FPS, placeholder: true, totalFrames: t, scenes: outScenes };
}

const music = existsSync(join(ROOT, ".cache/music.json")) ? JSON.parse(readFileSync(join(ROOT, ".cache/music.json"), "utf8")) : {};
out.music = { file: "audio/music.mp3", source: music.source || "none" };
writeFileSync(join(ROOT, "src/timing.json"), JSON.stringify(out, null, 1));
console.log(`${out.placeholder ? "PLACEHOLDER" : "synced"}: total ${out.totalFrames}f = ${(out.totalFrames / FPS).toFixed(2)}s`);
for (const s of out.scenes) console.log(`  ${s.id.padEnd(8)} from ${String(s.from).padStart(5)}  ${(s.durationInFrames / FPS).toFixed(1)}s`);
if (out.totalFrames > MAX) console.error(`OVER 2:00 (${out.totalFrames}f > ${MAX}f): tighten tails or pauses`);
