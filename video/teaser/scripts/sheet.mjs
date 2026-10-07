// Contact sheet: 12 frames of each finished master, tiled 4x3 (times in TIMES; the film's
// own corner timecode shows on every chapter but the end card).
//   node scripts/sheet.mjs                  both masters in out/
//   node scripts/sheet.mjs out/x.mp4        one file
// Writes out/<name>-sheet.jpg.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['out/paraclr-teaser-15s.mp4', 'out/paraclr-teaser-15s-square.mp4'].map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f))
// One or two per chapter, on the beats that matter.
const TIMES = [0.9, 2.3, 2.85, 3.9, 5.5, 6.7, 7.9, 9.6, 10.9, 12.4, 13.7, 14.95]

for (const file of files) {
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim().split(',').map(Number)
  const tw = 640, th = Math.round((tw * h) / w)
  const tmp = fs.mkdtempSync(path.join(path.dirname(file), '.sheet-'))
  const frames = TIMES.map((t, i) => {
    const out = path.join(tmp, `${String(i).padStart(2, '0')}.png`)
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(Math.min(t, 14.98)), '-i', file, '-frames:v', '1', '-vf',
      `scale=${tw}:${th}:flags=lanczos`, out])
    return out
  })
  const sheet = file.replace(/\.mp4$/, '-sheet.jpg')
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', '1', '-i', path.join(tmp, '%02d.png'), '-vf', 'tile=4x3:padding=6:color=0x888888', '-frames:v', '1', '-q:v', '3', sheet])
  fs.rmSync(tmp, { recursive: true })
  console.log(sheet)
}
