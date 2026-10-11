// Film-resolution copies of the real Paraclr artwork, made exactly the way the app's
// scripts/brand-assets.mjs makes its PNGs (colour-to-alpha against white, crop to the art),
// but at 4K-friendly heights. Nothing is redrawn: the pixels are the masters'.
//   public/brand/paraclr-logo-source.png    -> video/demo/public/brand/mark.png
//   public/brand/paraclr-header-source.png  -> header-white.png (wordmark turned white, for dark)
//                                             header-ink.png
// Partner logos are copied unchanged from public/partners/.
import sharp from "sharp";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const APP = join(ROOT, "../..");
const src = join(APP, "public/brand");
const out = join(ROOT, "public/brand");
mkdirSync(out, { recursive: true });
const NOISE = 0.1;

async function toAlpha(file) {
  const { data, info } = await sharp(join(src, file)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const o = Buffer.alloc(width * height * 4);
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  for (let p = 0; p < width * height; p++) {
    let a = 0;
    for (let k = 0; k < 3; k++) a = Math.max(a, (255 - data[p * 3 + k]) / 255);
    a = Math.max(0, Math.min(1, (Math.min(1, a) - NOISE) / (1 - NOISE)));
    for (let k = 0; k < 3; k++) o[p * 4 + k] = a > 0 ? Math.max(0, Math.min(255, Math.round((data[p * 3 + k] - 255 * (1 - a)) / a))) : 0;
    o[p * 4 + 3] = Math.round(a * 255);
    if (a > 0.2) { const x = p % width, y = (p / width) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  const pad = Math.round(Math.min(width, height) * 0.01);
  const box = { left: Math.max(0, x0 - pad), top: Math.max(0, y0 - pad) };
  box.width = Math.min(width - box.left, x1 - x0 + 1 + 2 * pad);
  box.height = Math.min(height - box.top, y1 - y0 + 1 + 2 * pad);
  return { o, info: { width, height, channels: 4 }, box };
}
const whiten = (buf) => { const b = Buffer.from(buf); for (let i = 0; i < b.length; i += 4) { if (Math.max(b[i], b[i + 1], b[i + 2]) - Math.min(b[i], b[i + 1], b[i + 2]) < 40) b[i] = b[i + 1] = b[i + 2] = 255; } return b; };
const write = (buf, info, box, name) => sharp(buf, { raw: info }).extract(box).png({ compressionLevel: 9 }).toFile(join(out, name)).then((r) => console.log(name, `${r.width}x${r.height}`));

const mark = await toAlpha("paraclr-logo-source.png");
await write(mark.o, mark.info, mark.box, "mark.png");
const header = await toAlpha("paraclr-header-source.png");
await write(header.o, header.info, header.box, "header-ink.png");
await write(whiten(header.o), header.info, header.box, "header-white.png");

mkdirSync(join(ROOT, "public/partners"), { recursive: true });
for (const f of readdirSync(join(APP, "public/partners"))) copyFileSync(join(APP, "public/partners", f), join(ROOT, "public/partners", f));
console.log("partners copied");
