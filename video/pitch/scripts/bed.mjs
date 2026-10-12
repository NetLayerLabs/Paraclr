// Low music bed for the on-camera pitch -> public/audio/bed.mp3, sized to src/edit.json total + 1 s.
//   node scripts/bed.mjs   (FORCE=1 to regenerate). Instrumental, sits ~20 dB under the voice in Pitch.tsx.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, post, retry } from "./env.mjs";

const E = JSON.parse(readFileSync(join(ROOT, "src/edit.json"), "utf8"));
const seconds = Math.ceil(E.total / 30 + 1);
const talk = Math.round(E.speechFrames / 30);
const OUT = join(ROOT, "public/audio/bed.mp3");
const PROMPT = `Minimal, warm, premium electronic underscore for a founder speaking to camera, ${seconds} seconds, about 90 BPM, no vocals. ` +
  `0-${talk}s: a steady, unobtrusive bed: soft analog pad, a gentle pulsing low synth, light ticking percussion, quietly confident, no lead melody and nothing in the vocal range, constant energy so it can sit under speech. ` +
  `At ${talk}s: a clean soft hit and a wide resolving chord for a logo end card, then an airy tail to silence by ${seconds}s. No vocals, no lyrics.`;
if (existsSync(OUT) && !process.env.FORCE) console.log("bed.mp3 exists (FORCE=1 to redo)");
else {
  const buf = await retry(async () => Buffer.from(await (await post("/music?output_format=mp3_44100_192", { prompt: PROMPT, music_length_ms: seconds * 1000, force_instrumental: true })).arrayBuffer()), 2);
  writeFileSync(OUT, buf);
  console.log(`bed.mp3 ${seconds}s`);
}
