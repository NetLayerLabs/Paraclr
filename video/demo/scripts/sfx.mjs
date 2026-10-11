// Sound effects via ElevenLabs /v1/sound-generation (min 0.5 s). Skips files that already exist.
//   node scripts/sfx.mjs                     all missing
//   ONLY=tick,impact node scripts/sfx.mjs    force regenerate some
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, post, retry } from "./env.mjs";

const SFX = {
  tick: ["Single crisp precise clock tick, close, dry, very short", 0.5],
  ticker: ["Fast mechanical counter digits rolling and clicking, like a departure board flipping quickly, dry, no music", 2.5],
  glitch: ["Short digital glitch, data static burst, crisp, single", 0.7],
  race: ["Three fast engine-like digital zips racing past, close together, sci-fi, short, no music", 1.4],
  thud: ["Heavy dull block slam, a weight dropping onto a surface, single, short", 0.8],
  whoosh: ["Soft fast airy whoosh, smooth cinematic transition, no music", 1.0],
  sweep: ["Several thin bright synth lines sweeping past in parallel, shimmering whoosh, clean, no drums", 1.6],
  riser: ["Tension riser, rising airy synth swell building to a peak, cinematic, no drums", 3.5],
  impact: ["Deep clean cinematic impact with a warm sub tail, modern, single hit", 2],
  click: ["Soft modern UI click, single, clean, short", 0.5],
  pop: ["Soft bubbly UI pop, single, clean, short", 0.5],
  blip: ["Single soft digital data blip, clean sine tone, short", 0.5],
  alert: ["Short soft digital warning tone, two quick descending notes, clean, not harsh", 0.8],
  crash: ["Market crash sound design: a sharp downward pitch drop whoosh with a low boom, cinematic, short", 1.6],
  chime: ["Bright clean confirmation chime, two soft ascending notes, modern, short tail", 1.5],
  stamp: ["Firm soft rubber stamp hit on paper, single, close, dry", 0.6],
  bell: ["Single soft auction bell ding, clean and warm, short tail", 1.2],
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
