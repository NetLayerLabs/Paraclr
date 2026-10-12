// Sound effects via ElevenLabs /v1/sound-generation (min 0.5 s) -> public/audio/sfx/. Skips existing files.
//   node scripts/sfx.mjs                ONLY=impact,sheen node scripts/sfx.mjs (force some)
// Placement lives in src/sfx.json (scene + word + frame offset + volume).
import { writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, post, retry } from "./env.mjs";

const SFX = {
  lighton: ["Loud heavy stage spotlight switch clunk, a big metal lever thrown, then a low electric hum, reverberant hall", 1.6],
  sheen: ["Bright metallic shimmer sweep, a glint of light across polished chrome, airy, clean, no music", 1.4],
  impact: ["Deep clean cinematic impact with a metallic ring and a warm sub tail, premium logo reveal, single hit", 2.5],
  whoosh: ["Soft fast airy whoosh, smooth cinematic transition, no music", 1.0],
  type: ["Fast quiet mechanical keyboard typing, a short burst of crisp keystrokes, close, dry", 1.4],
  tick: ["Single crisp precise mechanical tick, close, dry, very short", 0.5],
  pop: ["Soft clean UI pop, single, modern, short", 0.5],
  blip: ["Single soft digital data blip, clean sine tone, short", 0.5],
  stamp: ["Firm rubber stamp thump on a wooden desk, single, close, punchy", 0.7],
  chime: ["Bright clean confirmation chime, two soft ascending notes, glassy, short tail", 1.5],
  race: ["Three fast digital zips racing past close together, sharp sci-fi engines, short, no music", 1.4],
  drain: ["A descending synth tone draining away with a dull low thud at the end, a loss, short", 1.6],
  alert: ["Short soft digital warning tone, two quick descending notes, clean, not harsh", 0.8],
  riser: ["Short tension riser, airy synth swell building to a peak, cinematic, no drums", 2.5],
};
const dir = join(ROOT, "public/audio/sfx");
mkdirSync(dir, { recursive: true });
const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
for (const [name, [text, dur]] of Object.entries(SFX)) {
  const f = join(dir, `${name}.mp3`);
  if (only ? !only.includes(name) : existsSync(f)) continue;
  try {
    const buf = await retry(async () => Buffer.from(await (await post("/sound-generation?output_format=mp3_44100_128", { text, duration_seconds: dur, prompt_influence: 0.5 })).arrayBuffer()));
    writeFileSync(f, buf);
    console.log(`${name}: ${(buf.length / 1024).toFixed(0)}kb`);
  } catch (e) { console.error(`${name}: FAILED ${e.message}`); }
}

// Level every effect to -20 LUFS (peaks limited to -3 dBFS), so the volumes in src/sfx.json are relative to one reference.
for (const name of Object.keys(SFX)) {
  const f = join(dir, `${name}.mp3`);
  if (!existsSync(f)) continue;
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", f, "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" });
  const I = parseFloat((r.stderr.match(/I:\s+(-?[\d.]+) LUFS\s*\n\s*Threshold/) || [])[1]);
  if (!isFinite(I) || I < -70 || Math.abs(I + 20) < 0.5) continue;
  const tmp = f.replace(/\.mp3$/, ".tmp.mp3");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", f, "-af", `volume=${(-20 - I).toFixed(2)}dB,alimiter=limit=0.7:level=false`, "-b:a", "192k", tmp]);
  renameSync(tmp, f);
  console.log(`${name}: ${I.toFixed(1)} -> -20 LUFS`);
}
