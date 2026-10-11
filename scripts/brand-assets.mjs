// Regenerates the transparent logo files in public/brand/ from the two master artworks:
//   public/brand/paraclr-logo-source.png    the mark (8 lanes into the gate, 6 out)
//   public/brand/paraclr-header-source.png  the mark + "Paraclr" wordmark
// Both masters sit on white. "Colour to alpha" against white keeps the
// lanes' soft fades as real transparency, then the result is cropped to the artwork. The white
// header (for dark surfaces) recolours only the neutral (wordmark) pixels; the purple mark is kept.
//
//   node scripts/brand-assets.mjs
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const NOISE = 0.1;
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "brand");

async function toAlpha(file) {
  const { data, info } = await sharp(join(dir, file)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  // Both masters sit on (near) white: colour-to-alpha against pure white. Measuring the corners
  // instead turned 1-2 levels of brightness noise above a 253 background into opaque pixels.
  const bg = [255, 255, 255];
  const out = Buffer.alloc(width * height * 4);
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  for (let p = 0; p < width * height; p++) {
    const c = [data[p * 3], data[p * 3 + 1], data[p * 3 + 2]];
    let a = 0;
    for (let k = 0; k < 3; k++) {
      const d = c[k] - bg[k];
      a = Math.max(a, d > 0 ? d / Math.max(1, 255 - bg[k]) : -d / Math.max(1, bg[k]));
    }
    // The masters carry a faint paper texture and JPEG noise: everything within NOISE of the
    // background is background, and the rest is rescaled so solid artwork stays opaque.
    a = Math.max(0, Math.min(1, (Math.min(1, a) - NOISE) / (1 - NOISE)));
    for (let k = 0; k < 3; k++) out[p * 4 + k] = a > 0 ? Math.max(0, Math.min(255, Math.round((c[k] - bg[k] * (1 - a)) / a))) : 0;
    out[p * 4 + 3] = Math.round(a * 255);
    if (a > 0.2) {
      const x = p % width, y = (p / width) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  const pad = Math.round(Math.min(width, height) * 0.01);
  const box = { left: Math.max(0, x0 - pad), top: Math.max(0, y0 - pad) };
  box.width = Math.min(width - box.left, x1 - x0 + 1 + 2 * pad);
  box.height = Math.min(height - box.top, y1 - y0 + 1 + 2 * pad);
  return { out, info: { width, height, channels: 4 }, box };
}

function whiten(buf) {
  const b = Buffer.from(buf);
  for (let i = 0; i < b.length; i += 4) {
    const r = b[i], g = b[i + 1], bl = b[i + 2];
    if (Math.max(r, g, bl) - Math.min(r, g, bl) < 40) { b[i] = 255; b[i + 1] = 255; b[i + 2] = 255; }
  }
  return b;
}

async function write(buf, info, box, name, height) {
  await sharp(buf, { raw: info }).extract(box).resize({ height, kernel: "lanczos3" }).png({ compressionLevel: 9 }).toFile(join(dir, name));
  console.log(`${name} (height ${height})`);
}

const mark = await toAlpha("paraclr-logo-source.png");
for (const h of [512, 128, 64]) await write(mark.out, mark.info, mark.box, `paraclr-mark-${h}.png`, h);

const header = await toAlpha("paraclr-header-source.png");
const white = whiten(header.out);
for (const h of [192, 96]) {
  await write(header.out, header.info, header.box, `paraclr-header-ink-${h}.png`, h);
  await write(white, header.info, header.box, `paraclr-header-white-${h}.png`, h);
}
