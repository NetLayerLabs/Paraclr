// Quick look: render chosen frames of a composition as PNGs from one bundle, then tile them.
//   node scripts/stills.mjs Teaser 30,120,200          -> out/stills/Teaser-<f>.png + out/stills/Teaser-sheet.png
import path from 'node:path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { bundle } from '@remotion/bundler'
import { renderStill, selectComposition } from '@remotion/renderer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const id = process.argv[2] || 'Teaser'
const frames = (process.argv[3] || '30,150,240,330,420,520,600,700,760,800,860,899').split(',').map(Number)
const OUT = path.join(ROOT, 'out/stills')
fs.mkdirSync(OUT, { recursive: true })

const serveUrl = await bundle({ entryPoint: path.join(ROOT, 'src/index.ts') })
const browserExecutable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const composition = await selectComposition({ serveUrl, id, browserExecutable })
const files = []
for (const frame of frames) {
  const output = path.join(OUT, `${id}-${String(frame).padStart(3, '0')}.png`)
  await renderStill({ composition, serveUrl, output, frame, browserExecutable, imageFormat: 'png', overwrite: true })
  files.push(output)
}
const cols = 4
const w = 480, h = Math.round((480 * composition.height) / composition.width)
execFileSync('ffmpeg', ['-v', 'error', '-y', ...files.flatMap((f) => ['-i', f]), '-filter_complex',
  files.map((_, i) => `[${i}]scale=${w}:${h}[s${i}]`).join(';') + ';' + files.map((_, i) => `[s${i}]`).join('') +
  `xstack=inputs=${files.length}:layout=${files.map((_, i) => `${(i % cols) * w}_${Math.floor(i / cols) * h}`).join('|')}:fill=gray`,
  path.join(OUT, `${id}-sheet.png`)])
console.log(path.join(OUT, `${id}-sheet.png`))
