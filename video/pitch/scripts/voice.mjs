// Cleans the founder's recording(s) -> .cache/voice-clean.wav (48 kHz mono, -16 LUFS).
//   node scripts/voice.mjs <take.m4a> [take2.m4a ...]
// Per take: high-pass 80 Hz, light FFT denoise (noise floor tracked), a gentle de-ess,
// 2.5:1 compression, then two-pass linear loudnorm to -16 LUFS / -1.5 dBTP.
// Several takes are joined in order with 1 s of silence; timing.mjs finds the words in them.
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const takes = process.argv.slice(2).map((p) => resolve(p));
if (!takes.length) { console.error("usage: node scripts/voice.mjs <take> [take ...]"); process.exit(1); }
for (const t of takes) if (!existsSync(t)) { console.error(`missing: ${t}`); process.exit(1); }
mkdirSync(join(ROOT, ".cache/voice"), { recursive: true });
const ff = (a) => execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...a]);

const CLEAN = [
  "highpass=f=80:poles=2",
  "afftdn=nr=9:nf=-48:tn=1",                // light: about 9 dB off the noise floor, tracks the room
  "deesser=i=0.25:m=0.5:f=0.5",
  "acompressor=threshold=-21dB:ratio=2.5:attack=8:release=140:makeup=2",
].join(",");
const LN = "loudnorm=I=-16:TP=-1.5:LRA=9";

const parts = [];
for (const [i, t] of takes.entries()) {
  const pre = join(ROOT, `.cache/voice/take${i}-pre.wav`);
  ff(["-i", t, "-vn", "-ac", "1", "-ar", "48000", "-af", CLEAN, "-c:a", "pcm_s24le", pre]);
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", pre, "-af", `${LN}:print_format=json`, "-f", "null", "-"], { encoding: "utf8" });
  const m = JSON.parse(r.stderr.slice(r.stderr.lastIndexOf("{"), r.stderr.lastIndexOf("}") + 1));
  const out = join(ROOT, `.cache/voice/take${i}.wav`);
  ff(["-i", pre, "-af", `${LN}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`, "-ar", "48000", "-c:a", "pcm_s24le", out]);
  console.log(`take ${i}: ${t.split("/").pop()}  in ${m.input_i} LUFS (TP ${m.input_tp}) -> -16 LUFS`);
  parts.push(out);
}
const dst = join(ROOT, ".cache/voice-clean.wav");
if (parts.length === 1) ff(["-i", parts[0], "-c", "copy", dst]);
else {
  const inputs = parts.flatMap((p) => ["-i", p]);
  const fc = parts.map((_, i) => `[${i}:a]apad=pad_dur=1[p${i}]`).join(";") + ";" + parts.map((_, i) => `[p${i}]`).join("") + `concat=n=${parts.length}:v=0:a=1[o]`;
  ff([...inputs, "-filter_complex", fc, "-map", "[o]", "-c:a", "pcm_s24le", dst]);
}
const dur = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", dst]).toString().trim();
console.log(`-> ${dst} (${(+dur).toFixed(1)} s). Next: node scripts/transcribe.mjs && node scripts/timing.mjs`);
