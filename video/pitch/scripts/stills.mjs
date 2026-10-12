// Check stills + contact sheet.
//   node scripts/stills.mjs                 4 frames per scene (after the in-fade, 40%, 70%, end) -> out/stills/, out/stills/sheet.jpg
//   node scripts/stills.mjs 140 420 ...     just those frames
//   COMP=Poster node scripts/stills.mjs     the poster
// Half scale (960x540) unless SCALE is set. Bundles once.
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition, openBrowser } from "@remotion/renderer";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DIR = join(ROOT, "out/stills");
const SCALE = Number(process.env.SCALE || 0.5);
const id = process.env.COMP || "Pitch";
const T = JSON.parse(readFileSync(join(ROOT, "src/timing.json"), "utf8"));
let frames = process.argv.slice(2).map(Number);
const auto = !frames.length && (id === "Pitch" || id === "VoiceFilm");
if (auto) {
  rmSync(DIR, { recursive: true, force: true });
  if (id === "VoiceFilm") frames = T.scenes.flatMap((s) => [0.12, 0.42, 0.72, 0.97].map((k) => s.from + Math.round(s.durationInFrames * k)));
  else { const E = JSON.parse(readFileSync(join(ROOT, "src/edit.json"), "utf8")); frames = Array.from({ length: 20 }, (_, k) => Math.round(30 + k * (E.total - 60) / 19)); }
}
if (id === "Poster" || id === "Thumb") frames = [0];
mkdirSync(DIR, { recursive: true });
const serveUrl = await bundle({ entryPoint: join(ROOT, "src/index.ts"), publicDir: join(ROOT, "public") });
const browser = await openBrowser("chrome");
try {
  const composition = await selectComposition({ serveUrl, id, puppeteerInstance: browser });
  const outs = [];
  for (const frame of frames) {
    const output = join(DIR, `${id === "Poster" || id === "Thumb" ? id.toLowerCase() : "f" + String(frame).padStart(5, "0")}.png`);
    await renderStill({ composition, serveUrl, frame, output, scale: SCALE, puppeteerInstance: browser });
    outs.push(output);
    console.log(output);
  }
  if (auto) {
    // Pitch: 5 columns x 4 rows, evenly spaced; VoiceFilm: one scene per row. 480 px tiles
    const cols = id === "Pitch" ? 5 : 4, tw = 480, th = 270;
    const inputs = outs.flatMap((o) => ["-i", o]);
    const fc = outs.map((_, i) => `[${i}]scale=${tw}:${th},pad=${tw}:${th}:0:0,drawbox=x=0:y=0:w=${tw}:h=${th}:color=0x333333:t=1[t${i}]`).join(";")
      + ";" + outs.map((_, i) => `[t${i}]`).join("") + `xstack=inputs=${outs.length}:layout=` + outs.map((_, i) => `${(i % cols) * tw}_${Math.floor(i / cols) * th}`).join("|") + "[o]";
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", fc, "-map", "[o]", "-q:v", "3", join(DIR, "sheet.jpg")]);
    console.log(join(DIR, "sheet.jpg"));
  }
} finally {
  await browser.close({ silent: true });
}
