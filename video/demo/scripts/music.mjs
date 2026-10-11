// Music bed -> public/audio/music.mp3, sized to src/timing.json totalFrames/30 + 2s.
//   node scripts/music.mjs            (skips if music.mp3 exists; FORCE=1 to redo)
// Path A: ElevenLabs Music API (POST /v1/music). Path B (fallback): several looped
// sound-generation beds stitched with ffmpeg crossfades. Writes .cache/music.json
// { source, bpm, offsetSec } for timing.mjs (beats).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, post, retry } from "./env.mjs";

const OUT = join(ROOT, "public/audio/music.mp3");
const META = join(ROOT, ".cache/music.json");
mkdirSync(join(ROOT, ".cache/music"), { recursive: true });
const timing = existsSync(join(ROOT, "src/timing.json")) ? JSON.parse(readFileSync(join(ROOT, "src/timing.json"), "utf8")) : { totalFrames: 3540 };
const seconds = Math.ceil(timing.totalFrames / 30 + 2);

const PROMPT =
  "Precise, modern cinematic electronic score for a fintech product film about liquidations and a block clock on a fast blockchain, about 100 BPM, dark and elegant, violet night mood, no vocals. 0-14s: cold open, tension, a low sub drone, a fast ticking clock-like hi-hat racing, glitchy digital blips, rising unease. 14-27s: the race, a pulsing driving synth bass, nervous arpeggio, tension building, a long riser that swells to a peak at 27s. At 28s: silence for a breath, then one clean deep hit and a bright release. 28-38s: spacious, a warm wide pad and a single clean bell motif, calm and assured. 38-71s: a steady, intelligent minimal electronic groove, crisp tight percussion on every beat like a metronome, warm analog bass, precise plucks, eight-voice layered arpeggio that never collides. 71-92s: the groove opens up, confident and forward-moving, brighter plucks. 92-106s: suspense and impact, the drums drop for a moment, a sharp hit at 93s, then a driving pulse returns, urgent but controlled. 106-140s: proof, the arrangement lifts and widens, more energy, a feeling of clarity and confidence. 140-155s: full and uplifting, steady. 155-168s: resolves on a clean final chord and one soft final hit, then a short airy tail. No vocals, no lyrics.";

const ff = (a) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...a]);
const dur = (f) => parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f]).toString());

// Rough BPM + first-beat offset from an onset envelope (low-passed energy, 10ms hops) via autocorrelation.
function detectBpm(file) {
  const raw = execFileSync("ffmpeg", ["-loglevel", "error", "-i", file, "-t", "60", "-ac", "1", "-ar", "8000", "-af", "lowpass=f=200", "-f", "s16le", "-"], { maxBuffer: 1 << 28 });
  const s = new Int16Array(raw.buffer, raw.byteOffset, raw.length >> 1);
  const hop = 80; // 10ms
  const env = [];
  for (let i = 0; i + hop <= s.length; i += hop) { let e = 0; for (let j = 0; j < hop; j++) e += s[i + j] * s[i + j]; env.push(Math.sqrt(e / hop)); }
  const on = env.map((v, i) => Math.max(0, v - (env[i - 1] ?? v)));
  let best = { bpm: 100, score: -1 };
  for (let bpm = 80; bpm <= 140; bpm += 0.5) {
    const lag = 6000 / bpm; // in 10ms hops
    let sc = 0;
    for (let i = 0; i + lag * 2 < on.length; i++) sc += on[i] * (on[Math.round(i + lag)] + on[Math.round(i + 2 * lag)]);
    if (sc > best.score) best = { bpm, score: sc };
  }
  // phase: best offset within one beat
  const lag = 6000 / best.bpm;
  let ph = { off: 0, sc: -1 };
  for (let o = 0; o < lag; o++) { let sc = 0; for (let t = o; t < on.length; t += lag) sc += on[Math.round(t)] || 0; if (sc > ph.sc) ph = { off: o, sc }; }
  return { bpm: best.bpm, offsetSec: +(ph.off / 100).toFixed(3) };
}

if (existsSync(OUT) && !process.env.FORCE) {
  console.log("music.mp3 exists (FORCE=1 to regenerate)");
} else {
  let source;
  try {
    const buf = await retry(async () => {
      const res = await post("/music?output_format=mp3_44100_128", { prompt: PROMPT, music_length_ms: seconds * 1000, force_instrumental: true });
      return Buffer.from(await res.arrayBuffer());
    }, 2);
    writeFileSync(OUT, buf);
    source = "elevenlabs-music";
  } catch (e) {
    console.error(`Music API unavailable (${e.message.slice(0, 160)}); falling back to sound-generation beds`);
    const BEDS = [
      ["tense", "Tense low synth pulse loop with muted kick like a racing heartbeat, 100 bpm, minimal electronic, sparse, no vocals", 17],
      ["swell", "Reversed cinematic swell rising into silence, 100 bpm, no drums", 5],
      ["groove", "Confident uplifting minimal electronic groove loop, 100 bpm, crisp percussion, warm plucks, no vocals", 22],
      ["build", "Rising optimistic minimal electronic groove loop building energy, 100 bpm, crisp hats, warm plucks, no vocals", 22],
      ["outro", "Soft resolving minimal electronic outro, 100 bpm, warm pads, ends with one clean final hit, no vocals", 12],
    ];
    const parts = [];
    for (const [n, text, d] of BEDS) {
      const f = join(ROOT, ".cache/music", `${n}.mp3`);
      if (!existsSync(f)) {
        const res = await retry(() => post("/sound-generation?output_format=mp3_44100_128", { text, duration_seconds: d, prompt_influence: 0.5 }));
        writeFileSync(f, Buffer.from(await res.arrayBuffer()));
      }
      parts.push(f);
    }
    // layout: tense(loop to 17s) swell(5) groove(loop) build(loop) outro(12) with 1s crossfades
    const grooveLen = (seconds - 17 - 5 - 12) / 2 + 2;
    const segs = [[parts[0], 17.5], [parts[1], 5.5], [parts[2], grooveLen], [parts[3], grooveLen], [parts[4], 12]];
    const inputs = segs.flatMap(([f]) => ["-stream_loop", "-1", "-i", f]);
    let fc = segs.map(([, d], i) => `[${i}:a]atrim=0:${d},asetpts=PTS-STARTPTS[s${i}]`).join(";");
    let prev = "s0";
    for (let i = 1; i < segs.length; i++) { fc += `;[${prev}][s${i}]acrossfade=d=1[x${i}]`; prev = `x${i}`; }
    fc += `;[${prev}]atrim=0:${seconds},afade=t=out:st=${seconds - 1.5}:d=1.5[out]`;
    ff([...inputs, "-filter_complex", fc, "-map", "[out]", "-b:a", "192k", OUT]);
    source = "sound-generation-stitched";
  }
  const beat = detectBpm(OUT);
  writeFileSync(META, JSON.stringify({ source, ...beat, seconds }, null, 1));
}
const meta = JSON.parse(readFileSync(META, "utf8"));
console.log(`music.mp3 ${dur(OUT).toFixed(1)}s (target ${seconds}s) via ${meta.source}; bpm ~${meta.bpm}, first beat ${meta.offsetSec}s`);
console.log("re-run: node scripts/timing.mjs  (to write bpm/beats)");
