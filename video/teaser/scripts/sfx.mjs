// Sound for the teaser, generated with ElevenLabs: a few effects from the sound-generation
// endpoint and one 16 s music bed from the music endpoint (falls back to a sound-generation
// bed if the account has no music access).
//   node scripts/sfx.mjs            everything missing
//   ONLY=bed,tick node scripts/sfx.mjs  regenerate some
// Writes public/sfx/<name>.mp3. The key is read at runtime by scripts/env.cjs, never stored.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const { post, retry } = require('./env.cjs')

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'public/sfx')
fs.mkdirSync(OUT, { recursive: true })

const SFX = {
  whoosh: { text: 'Fast clean airy swish whoosh for a slide transition in a modern tech product video, short, crisp, no low rumble', dur: 0.8 },
  tick: { text: 'Single crisp soft digital UI tick, like a clean click of a counter incrementing, very short, dry, no reverb', dur: 0.5 },
  stamp: { text: 'Heavy rubber stamp slammed down on paper on a desk, one short punchy thud, dry, close', dur: 0.7 },
  impact: { text: 'Soft deep cinematic logo reveal impact, warm sub boom with a gentle airy shimmer tail, clean, modern, no distortion', dur: 2.4 },
}

// Sectioned so the music follows the cut: tension under the bot race and the gas war,
// a lift where Paraclr's auction appears, one hit into the end card, then a soft tail.
const BED = {
  ms: 16000,
  plan: {
    positive_global_styles: ['minimal modern electronic', 'sleek fintech product teaser', '120 bpm', 'polished clean mix', 'instrumental', 'sits under a voice-over'],
    negative_global_styles: ['vocals', 'lyrics', 'heavy distortion', 'dubstep drops', 'cheesy', 'lo-fi'],
    sections: [
      { section_name: 'tension', duration_ms: 5800, lines: [],
        positive_local_styles: ['tight ticking hi-hats', 'muted pulsing low synth bass', 'uneasy and restrained', 'filtered', 'sparse soft kick'],
        negative_local_styles: ['big drums', 'bright melody'] },
      { section_name: 'lift', duration_ms: 6950, lines: [],
        positive_local_styles: ['opens up, bright and confident', 'clean plucked synth arpeggio', 'punchy kick and crisp claps', 'warm wide pads', 'building energy'],
        negative_local_styles: ['dark', 'aggressive'] },
      { section_name: 'resolve', duration_ms: 3250, lines: [],
        positive_local_styles: ['starts with one big clean impact hit', 'drums stop', 'airy resolving pad chord with a soft shimmer', 'gentle fade'],
        negative_local_styles: ['drums', 'new melody'] },
    ],
  },
}
const BED_FALLBACK = { text: 'Minimal modern electronic loop for a tech product teaser, 120 bpm, punchy kick, ticking hats, clean plucked synth arpeggio, warm pad, confident, no vocals', dur: 16 }

const only = process.env.ONLY ? process.env.ONLY.split(',') : null
const want = (n) => (only ? only.includes(n) : !fs.existsSync(path.join(OUT, `${n}.mp3`)))
const save = (n, buf, how) => { fs.writeFileSync(path.join(OUT, `${n}.mp3`), buf); console.log(`${n}: ${(buf.length / 1024).toFixed(0)}kb (${how})`) }

const soundGen = async (text, dur) => {
  const res = await retry(() => post('/sound-generation?output_format=mp3_44100_192', { text, duration_seconds: dur, prompt_influence: 0.55 }))
  return Buffer.from(await res.arrayBuffer())
}

for (const [name, s] of Object.entries(SFX)) {
  if (!want(name)) continue
  try { save(name, await soundGen(s.text, s.dur), 'sound-generation') } catch (e) { console.error(`${name}: ${e.message}`) }
}

if (want('bed')) {
  try {
    const res = await retry(() => post('/music?output_format=mp3_44100_192', { composition_plan: BED.plan, model_id: 'music_v1' }), 2)
    save('bed', Buffer.from(await res.arrayBuffer()), 'music')
  } catch (e) {
    console.error(`bed via music failed (${e.message.slice(0, 160)}); trying sound-generation`)
    try { save('bed', await soundGen(BED_FALLBACK.text, BED_FALLBACK.dur), 'sound-generation fallback') } catch (e2) { console.error(`bed: ${e2.message}`) }
  }
}
