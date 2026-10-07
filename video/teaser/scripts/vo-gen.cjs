// Voice-over for the teaser, generated with ElevenLabs *with timestamps*, so every
// graphic is cued to the word that names it rather than hand-timed (Judr's pattern).
//   node scripts/vo-gen.cjs            all lines
//   VO_ONLY=l3 node scripts/vo-gen.cjs one line
// Writes public/vo/<id>.mp3 and src/vo.json ({ voice, lines: { id: { text, say, dur, words } } }).
// The key is read at runtime from an env file outside this repo (scripts/env.cjs).
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { post, retry } = require('./env.cjs')

const ROOT = path.join(__dirname, '..')
const VOICE = process.env.ELEVENLABS_VOICE || 'CwhRBWXzGAHq8TQ4Fs17' // the Judr narrator
const MODEL = 'eleven_multilingual_v2'

// `text` is what the film shows; `say` is what the voice reads. "Paraclear" is a
// spelling for the voice only, so the name is said as meant ("para-clear").
const LINES = [
  { id: 'l1', text: 'Most perps liquidate you first-bot-wins.', say: 'Most perps liquidate you... first bot wins.' },
  { id: 'l2', text: 'A fixed fee, decided by whoever pays the most gas.', say: 'A fixed fee, decided by whoever pays the most gas.' },
  { id: 'l3', text: "Paraclr auctions it, block by block, and you keep the equity the taker isn't paid.", say: "Paraclear auctions it, block by block, and you keep the equity that the taker isn't paid." },
  { id: 'l4', text: 'Fair liquidations, cleared every block.', say: 'Fair liquidations. Cleared every block.' },
  { id: 'l5', text: 'Coming soon, on Monad.', say: 'Coming soon, on Monad.' },
]

const SETTINGS = { stability: 0.42, similarity_boost: 0.8, style: 0.32, use_speaker_boost: true, speed: Number(process.env.VO_SPEED || 1.08) }
// The two long lines are read a touch quicker so the whole script sits inside 15 s.
const PER_LINE = {
  l2: { speed: Number(process.env.VO_SPEED_L2 || 1.15) },
  l3: { speed: Number(process.env.VO_SPEED_L3 || 1.16) },
  l5: { stability: 0.5, speed: Number(process.env.VO_SPEED_L5 || 1.0) },
}

const OUT = path.join(ROOT, 'public/vo')
const JSON_OUT = path.join(ROOT, 'src/vo.json')
fs.mkdirSync(OUT, { recursive: true })
const prev = fs.existsSync(JSON_OUT) ? JSON.parse(fs.readFileSync(JSON_OUT, 'utf8')) : { lines: {} }
const only = process.env.VO_ONLY ? process.env.VO_ONLY.split(',') : null

const seconds = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim())

function toWords(a) {
  const words = []
  let cur = null
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) { if (cur) { words.push(cur); cur = null } return }
    if (!cur) cur = { w: '', s: a.character_start_times_seconds[i], e: 0 }
    cur.w += ch
    cur.e = a.character_end_times_seconds[i]
  })
  if (cur) words.push(cur)
  return words.map((w) => ({ w: w.w, s: +w.s.toFixed(3), e: +w.e.toFixed(3) }))
}

;(async () => {
  const lines = { ...prev.lines }
  for (let i = 0; i < LINES.length; i++) {
    const L = LINES[i]
    if (only && !only.includes(L.id)) continue
    try {
      const res = await retry(() => post(`/text-to-speech/${VOICE}/with-timestamps?output_format=mp3_44100_192`, {
        text: L.say,
        model_id: MODEL,
        voice_settings: { ...SETTINGS, ...(PER_LINE[L.id] || {}) },
        // Neighbouring lines keep the read continuous across the separate takes.
        previous_text: LINES.slice(0, i).map((x) => x.say).join(' ') || undefined,
        next_text: LINES.slice(i + 1).map((x) => x.say).join(' ') || undefined,
      }))
      const body = await res.json()
      const file = path.join(OUT, `${L.id}.mp3`)
      fs.writeFileSync(file, Buffer.from(body.audio_base64, 'base64'))
      const words = toWords(body.alignment)
      lines[L.id] = { text: L.text, say: L.say, dur: +seconds(file).toFixed(3), words }
      console.log(`${L.id}: ${lines[L.id].dur.toFixed(2)}s file, speech ${words[0].s.toFixed(2)}–${words.at(-1).e.toFixed(2)}s, ${words.length} words`)
    } catch (e) {
      console.error(`${L.id}: ${e.message}`)
    }
  }
  fs.writeFileSync(JSON_OUT, JSON.stringify({ voice: VOICE, model: MODEL, lines }, null, 1) + '\n')
  const total = Object.values(lines).reduce((n, l) => n + (l.words.at(-1).e - l.words[0].s), 0)
  console.log(`total speech: ${total.toFixed(2)}s`)
})()
