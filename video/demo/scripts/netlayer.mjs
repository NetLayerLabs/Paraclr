// "Built by NetLayer Labs" artwork: flat white-on-transparent PNGs lifted from NetLayer's
// header render (/Users/mrnetwork/Downloads/NetLayer Labs/header-logo.png, a 3D render on black;
// read only). Luminance becomes alpha between LO and HI, tight crops drop the floor reflection
// and the spotlight haze.
//   node scripts/netlayer.mjs  -> public/brand/nl-mark.png, public/brand/nl-word.png
import sharp from "sharp";
import { join } from "node:path";

const SRC = "/Users/mrnetwork/Downloads/NetLayer Labs/header-logo.png";
const OUT = join(new URL("..", import.meta.url).pathname, "public/brand");
const { data, info } = await sharp(SRC).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width;

async function cut(name, box, lo, hi) {
  const { left, top, width, height } = box;
  const out = Buffer.alloc(width * height * 4);
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = ((top + y) * W + left + x) * 3;
    const l = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
    const a = Math.max(0, Math.min(1, (l - lo) / (hi - lo)));
    const q = (y * width + x) * 4;
    out[q] = out[q + 1] = out[q + 2] = 255;
    out[q + 3] = Math.round(a * 255);
    if (a > 0.5) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  const pad = 4;
  const crop = { left: Math.max(0, x0 - pad), top: Math.max(0, y0 - pad) };
  crop.width = Math.min(width - crop.left, x1 - x0 + 1 + 2 * pad);
  crop.height = Math.min(height - crop.top, y1 - y0 + 1 + 2 * pad);
  const r = await sharp(out, { raw: { width, height, channels: 4 } }).extract(crop).png({ compressionLevel: 9 }).toFile(join(OUT, name));
  console.log(name, `${r.width}x${r.height}`);
}
// the stacked-bars mark, above the floor line (y < 520), clear of the spotlight cone
await cut("nl-mark.png", { left: 300, top: 196, width: 545, height: 322 }, 160, 205);
// "NETLAYER" / "L A B S"
await cut("nl-word.png", { left: 930, top: 268, width: 1130, height: 192 }, 70, 190);
