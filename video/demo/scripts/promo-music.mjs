// 30 s music cue for the Promo, written to its beat map, via ElevenLabs Music.
//   node scripts/promo-music.mjs   -> public/audio/promo-music.mp3 (+ .cache/promo-music.json: bpm, first beat)
import { writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, post, retry } from "./env.mjs";

const OUT = join(ROOT, "public/audio/promo-music.mp3");
const PROMPT =
  "Punchy, confident modern electronic promo cue for a fast fintech product trailer, exactly 120 BPM, no vocals. " +
  "0-3.5s: tense ticking hi-hats racing, a pulsing sub, a short rising riser into a gap. " +
  "At 4.0s: one big clean impact hit and the full groove drops in: tight punchy kick on every beat, crisp claps, driving synth bass, bright plucks, energetic and rhythmic. " +
  "4-21s: high energy driving groove, steady four-on-the-floor, quick fills every two bars. " +
  "At 21s: a lift, bigger and wider for 4 seconds. " +
  "At 25s: a strong final hit, then a short confident outro and a clean ending by 30s. No vocals, no lyrics.";

if (existsSync(OUT) && !process.env.FORCE) console.log("promo-music.mp3 exists (FORCE=1 to regenerate)");
else {
  const buf = await retry(async () => Buffer.from(await (await post("/music?output_format=mp3_44100_192", { prompt: PROMPT, music_length_ms: 30000, force_instrumental: true })).arrayBuffer()), 2);
  writeFileSync(OUT, buf);
}
// onset envelope -> bpm + first-beat phase (same method as music.mjs)
const raw = execFileSync("ffmpeg", ["-loglevel", "error", "-i", OUT, "-ac", "1", "-ar", "8000", "-af", "lowpass=f=200", "-f", "s16le", "-"], { maxBuffer: 1 << 28 });
const s = new Int16Array(raw.buffer, raw.byteOffset, raw.length >> 1);
const hop = 80, env = [];
for (let i = 0; i + hop <= s.length; i += hop) { let e = 0; for (let j = 0; j < hop; j++) e += s[i + j] * s[i + j]; env.push(Math.sqrt(e / hop)); }
const on = env.map((v, i) => Math.max(0, v - (env[i - 1] ?? v)));
let best = { bpm: 120, score: -1 };
for (let bpm = 100; bpm <= 140; bpm += 0.5) { const lag = 6000 / bpm; let sc = 0; for (let i = 0; i + lag * 2 < on.length; i++) sc += on[i] * (on[Math.round(i + lag)] + on[Math.round(i + 2 * lag)]); if (sc > best.score) best = { bpm, score: sc }; }
const lag = 6000 / best.bpm; let ph = { off: 0, sc: -1 };
for (let o = 0; o < lag; o++) { let sc = 0; for (let t = o; t < on.length; t += lag) sc += on[Math.round(t)] || 0; if (sc > ph.sc) ph = { off: o, sc }; }
// the loudest onset between 3 and 6 s: the drop
let drop = { t: 0, v: -1 }; for (let i = 300; i < 600 && i < on.length; i++) if (on[i] > drop.v) drop = { t: i / 100, v: on[i] };
const meta = { bpm: best.bpm, offsetSec: +(ph.off / 100).toFixed(3), dropSec: drop.t, seconds: +(env.length / 100).toFixed(2) };
writeFileSync(join(ROOT, ".cache/promo-music.json"), JSON.stringify(meta, null, 1));
console.log(meta);
