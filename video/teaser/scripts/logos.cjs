// Full-resolution Paraclr lockups for the film, cut from the repo's original artwork
// with the same colour-to-alpha treatment as the app's 96 px exports
// (public/brand/paraclr-header-{ink,white}-*.png), so the end card stays crisp at 1080p.
//   node scripts/logos.cjs
// Writes public/brand/lockup-{ink,white}.png, mark-{ink,white}.png and word-{ink,white}.png.
// Inputs: ../../public/brand/*-source.png.
const path = require('path')
const sharp = require('sharp')

const REPO = path.join(__dirname, '../../..')
const OUT = path.join(__dirname, '../public/brand')

async function unmatte(file, paper) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true })
  const { width: W, height: H, channels: C } = info
  const out = Buffer.alloc(W * H * 4)
  for (let p = 0; p < W * H; p++) {
    const i = p * C, o = p * 4
    // Smallest alpha that explains the pixel as foreground over paper (GIMP "colour to alpha").
    let a = 0
    for (let c = 0; c < 3; c++) {
      const v = data[i + c], bg = paper[c]
      const need = v < bg ? (bg - v) / bg : 0
      if (need > a) a = need
    }
    a = Math.max(0, Math.min(1, (a - 0.03) / 0.97)) // drop paper noise
    for (let c = 0; c < 3; c++) {
      const v = data[i + c], bg = paper[c]
      out[o + c] = a > 0 ? Math.max(0, Math.min(255, Math.round((v - (1 - a) * bg) / a))) : 0
    }
    out[o + 3] = Math.round(a * 255)
  }
  return { out, W, H }
}

function bbox(buf, W, H, thr = 24, x0 = 0, x1 = W - 1) {
  let bx0 = W, by0 = H, bx1 = 0, by1 = 0
  for (let y = 0; y < H; y++) for (let x = x0; x <= x1; x++) if (buf[(y * W + x) * 4 + 3] > thr) {
    if (x < bx0) bx0 = x; if (y < by0) by0 = y; if (x > bx1) bx1 = x; if (y > by1) by1 = y
  }
  return { x0: bx0, y0: by0, x1: bx1, y1: by1 }
}

const raw = (buf, W, H) => sharp(buf, { raw: { width: W, height: H, channels: 4 } })

;(async () => {
  const h = await unmatte(path.join(REPO, 'public/brand/paraclr-header-source.png'), [254, 254, 254])
  const b = bbox(h.out, h.W, h.H)
  // The gap between mark and wordmark: the widest empty column run.
  const colFilled = (x) => { for (let y = b.y0; y <= b.y1; y++) if (h.out[(y * h.W + x) * 4 + 3] > 24) return true; return false }
  let run = 0, best = { at: 0, len: 0 }
  for (let x = b.x0; x <= b.x1; x++) { if (!colFilled(x)) { run++; if (run > best.len) best = { at: x - Math.floor(run / 2), len: run } } else run = 0 }
  const split = best.at

  // White variant for dark surfaces: wordmark to white; mark lifted toward white so the
  // deep indigo reads on black the way it does on paper (same recipe as the app's).
  const light = Buffer.from(h.out)
  for (let y = 0; y < h.H; y++) for (let x = 0; x < h.W; x++) {
    const o = (y * h.W + x) * 4
    if (x >= split) { light[o] = light[o + 1] = light[o + 2] = 255; continue }
    const a = light[o + 3] / 255
    for (let c = 0; c < 3; c++) light[o + c] = Math.round(light[o + c] * 0.62 + 255 * 0.38)
    light[o + 3] = Math.round(Math.pow(a, 0.8) * 255)
  }

  const pad = Math.round((b.y1 - b.y0) * 0.04)
  const crop = (x0, x1) => {
    const left = Math.max(0, x0 - pad), top = Math.max(0, b.y0 - pad)
    return { left, top, width: Math.min(h.W - left, x1 - x0 + 2 * pad), height: Math.min(h.H - top, b.y1 - b.y0 + 2 * pad) }
  }
  const mb = bbox(h.out, h.W, h.H, 24, b.x0, split)
  const wb = bbox(h.out, h.W, h.H, 24, split, b.x1)
  for (const [tone, buf] of [['ink', h.out], ['white', light]]) {
    await raw(buf, h.W, h.H).extract(crop(b.x0, b.x1)).png({ compressionLevel: 9 }).toFile(path.join(OUT, `lockup-${tone}.png`))
    await raw(buf, h.W, h.H).extract(crop(mb.x0, mb.x1)).png({ compressionLevel: 9 }).toFile(path.join(OUT, `mark-${tone}.png`))
    await raw(buf, h.W, h.H).extract(crop(wb.x0, wb.x1)).png({ compressionLevel: 9 }).toFile(path.join(OUT, `word-${tone}.png`))
  }
  const c = crop(b.x0, b.x1), m = crop(mb.x0, mb.x1), w = crop(wb.x0, wb.x1)
  console.log(`lockup ${c.width}x${c.height} (aspect ${(c.width / c.height).toFixed(3)}), mark ${m.width}x${m.height} at x+${m.left - c.left}, word ${w.width}x${w.height} at x+${w.left - c.left}`)
  console.log(JSON.stringify({ lockup: [c.width, c.height], mark: [m.left - c.left, m.width], word: [w.left - c.left, w.width] }))
})()
