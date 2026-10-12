// Promo audio: (1) the music cue re-edited on bar lines so the drop lands at 4.0 s
// (public/audio/promo-music.mp3 -> public/audio/promo-cue.mp3), (2) two short new Sarah lines,
// plus the film's "Paraclr replaces the race with a clock." take, into public/audio/vo-promo/.
//   node scripts/promo-audio.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, post, retry } from "./env.mjs";
import { renderVo } from "./vofx.mjs";

// --- music: bars at 119.5 BPM from the first beat; the drop is the downbeat at 8.02 s
const m = JSON.parse(readFileSync(join(ROOT, ".cache/promo-music.json"), "utf8"));
const beat = 60 / m.bpm, bar = 4 * beat;
const drop = m.offsetSec + Math.round((8.0 - m.offsetSec) / beat) * beat;
const A = [drop - 2 * bar, drop];             // the last 2 bars of the build (into the gap)
const B = [drop, drop + 8 * bar];             // the drop and 8 bars of groove
const C = [drop + 4 * bar, drop + 8 * bar];   // the last 4 bars again
const src = join(ROOT, "public/audio/promo-music.mp3");
const cue = join(ROOT, "public/audio/promo-cue.mp3");
const seg = (i, [a, b]) => `[0:a]atrim=${a.toFixed(4)}:${b.toFixed(4)},asetpts=PTS-STARTPTS[s${i}]`;
const total = (A[1] - A[0]) + (B[1] - B[0]) + (C[1] - C[0]);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-filter_complex",
  `${seg(0, A)};${seg(1, B)};${seg(2, C)};[s0][s1]acrossfade=d=0.02:c1=tri:c2=tri[x];[x][s2]acrossfade=d=0.02:c1=tri:c2=tri,afade=t=out:st=${(total - 1.6).toFixed(3)}:d=1.6[out]`,
  "-map", "[out]", "-b:a", "256k", cue]);
writeFileSync(join(ROOT, ".cache/promo-cue.json"), JSON.stringify({ ...m, drop, bar, beat, dropInCue: A[1] - A[0], seconds: total }, null, 1));
console.log(`cue: ${total.toFixed(2)} s, drop at ${(A[1] - A[0]).toFixed(2)} s, beat ${beat.toFixed(4)} s`);

// --- voice
const script = JSON.parse(readFileSync(join(ROOT, "script.json"), "utf8"));
const v = script.voices.narrator;
const DIRS = { raw: ".cache/raw-promo", out: "public/audio/vo-promo", words: ".cache/words-promo" };
for (const d of Object.values(DIRS)) mkdirSync(join(ROOT, d), { recursive: true });
const LINES = {
  race: { text: "Liquidation is a race.", settings: { stability: 0.5, style: 0.35, speed: 0.95 } },
  fair: { text: "Fair liquidations for Monad. Crash it yourself.", settings: { stability: 0.55, style: 0.3, speed: 0.95 } },
};
const toWords = (a) => { const w = []; let c = null; a.characters.forEach((ch, i) => { if (/\s/.test(ch)) { if (c) { w.push(c); c = null; } return; } if (!c) c = { word: "", start: a.character_start_times_seconds[i], end: 0 }; c.word += ch; c.end = a.character_end_times_seconds[i]; }); if (c) w.push(c); return w; };
for (const [id, l] of Object.entries(LINES)) {
  if (existsSync(join(ROOT, DIRS.out, `${id}.mp3`)) && !process.env.FORCE) continue;
  const body = await retry(async () => (await post(`/text-to-speech/${v.id}/with-timestamps?output_format=mp3_44100_128`, { text: l.text, model_id: script.model, voice_settings: { ...v.settings, ...l.settings } })).json());
  writeFileSync(join(ROOT, DIRS.raw, `${id}.mp3`), Buffer.from(body.audio_base64, "base64"));
  renderVo(id, 1, DIRS);
  writeFileSync(join(ROOT, DIRS.words, `${id}.json`), JSON.stringify({ tempo: 1, words: toWords(body.alignment) }, null, 1));
  console.log(`${id}: generated`);
}
// the film's take, copied (never modified in place)
copyFileSync(join(ROOT, ".cache/raw/turn_0.mp3"), join(ROOT, DIRS.raw, "turn.mp3"));
renderVo("turn", 1, DIRS);
copyFileSync(join(ROOT, ".cache/words/turn_0.json"), join(ROOT, DIRS.words, "turn.json"));
const dur = (f) => parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString());
const out = {};
for (const id of ["race", "turn", "fair"]) out[id] = { file: `audio/vo-promo/${id}.mp3`, seconds: dur(join(ROOT, DIRS.out, `${id}.mp3`)), words: JSON.parse(readFileSync(join(ROOT, DIRS.words, `${id}.json`), "utf8")).words };
writeFileSync(join(ROOT, "src/promo-vo.json"), JSON.stringify(out, null, 1));
console.log(Object.entries(out).map(([k, x]) => `${k} ${x.seconds.toFixed(2)}s`).join(" · "));
