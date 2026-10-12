// Renders check stills: node scripts/stills.mjs 140 420 960 ...  -> out/stills/f<frame>.png (half scale)
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const frames = process.argv.slice(2).map(Number);
const DIR = process.env.COMP ? `out/stills-${process.env.COMP}` : "out/stills";
mkdirSync(join(ROOT, DIR), { recursive: true });
const serveUrl = await bundle({ entryPoint: join(ROOT, "src/index.ts"), publicDir: join(ROOT, "public") });
const composition = await selectComposition({ serveUrl, id: process.env.COMP || "Paraclr" });
for (const frame of frames) {
  const output = join(ROOT, DIR, `f${frame}.png`);
  await renderStill({ composition, serveUrl, frame, output, scale: 0.5 });
  console.log(output);
}
