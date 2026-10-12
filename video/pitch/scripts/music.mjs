// Score -> public/audio/music.mp3 via the ElevenLabs Music API, timed to src/timing.json.
//   node scripts/music.mjs      (skips if the file matches the current length; FORCE=1 to redo)
// The prompt is written from the scene start times, so after the voice sync re-run it and the
// hit, the drop and the lift land on the new cuts. Instrumental only. Writes .cache/music.json.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, post, retry } from "./env.mjs";

const OUT = join(ROOT, "public/audio/music.mp3");
const META = join(ROOT, ".cache/music.json");
mkdirSync(join(ROOT, "public/audio"), { recursive: true });
mkdirSync(join(ROOT, ".cache"), { recursive: true });
const T = JSON.parse(readFileSync(join(ROOT, "src/timing.json"), "utf8"));
const sec = (f) => Math.round(f / 30);
const S = Object.fromEntries(T.scenes.map((s) => [s.id, { a: sec(s.from), b: sec(s.from + s.durationInFrames) }]));
const word = (id, w) => { const x = T.scenes.find((s) => s.id === id).lines[0].words.find((v) => v.word.toLowerCase().replace(/[^a-z]/g, "") === w); return sec(x.start); };
const seconds = Math.ceil(T.totalFrames / 30 + 1.5);

const PROMPT = [
  `Premium minimal cinematic electronic score for a ${seconds}-second studio introduction film. Black and chrome, polished, confident, modern, about 92 BPM, no vocals.`,
  `${S.reveal.a}-${S.reveal.b}s: near silence, a deep sub swell and an airy metallic shimmer as a single stage light switches on; at ${word("reveal", "netlayer")}s one clean, deep impact with a bright metallic ring, then a warm wide pad.`,
  `${S.founder.a}-${S.founder.b}s: intimate and human, a soft felt-piano motif over a slow pulsing low synth.`,
  `${S.record.a}-${S.record.b}s: a steady minimal groove enters, crisp tight ticking hats, confident clean plucks, quietly building pride.`,
  `${S.why.a}-${S.why.b}s: the groove drops away, a low tense drone and a nervous ticking pulse, a racing arpeggio, one dark, sharp hit at ${word("why", "penalty")}s.`,
  `${S.paraclr.a}-${S.paraclr.b}s: release and lift, a clean bright eight-step arpeggio over the full groove, forward-moving and precise.`,
  `${S.close.a}-${seconds}s: resolve on a final wide chord with one soft deep hit at ${word("close", "netlayer")}s, then a short airy tail to silence.`,
  "Leave space for a spoken voice throughout: no lead melody competing in the mid range. No vocals, no lyrics.",
].join(" ");

const dur = (f) => parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f]).toString());
const meta = existsSync(META) ? JSON.parse(readFileSync(META, "utf8")) : {};
if (existsSync(OUT) && !process.env.FORCE && meta.seconds === seconds) {
  console.log(`music.mp3 already ${seconds}s (FORCE=1 to regenerate)`);
} else {
  console.log(PROMPT);
  const buf = await retry(async () => {
    const res = await post("/music?output_format=mp3_44100_192", { prompt: PROMPT, music_length_ms: seconds * 1000, force_instrumental: true });
    return Buffer.from(await res.arrayBuffer());
  }, 2);
  writeFileSync(OUT, buf);
  writeFileSync(META, JSON.stringify({ source: "elevenlabs-music", seconds, prompt: PROMPT }, null, 1));
}
console.log(`music.mp3 ${dur(OUT).toFixed(1)}s. Re-run: node scripts/timing.mjs (records the source)`);
