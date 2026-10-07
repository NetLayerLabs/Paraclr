// Reads ELEVENLABS_API_KEY at runtime from an env file OUTSIDE this repo (default:
// Syntura's), or from the environment. The key is never printed, logged or written.
const fs = require('fs')
const FILES = [process.env.ELEVEN_ENV, '/Users/mrnetwork/Syntura/video/.env'].filter(Boolean)
for (const file of FILES) {
  if (!fs.existsSync(file)) continue
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
const key = process.env.ELEVENLABS_API_KEY
if (!key) {
  console.error('No ELEVENLABS_API_KEY found. Set ELEVEN_ENV to an env file that has it.')
  process.exit(1)
}

const API = 'https://api.elevenlabs.io/v1'

/** POST JSON to ElevenLabs. Errors carry only the response body, never the key. */
async function post(path, body) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`)
  return res
}

async function retry(fn, tries = 4) {
  let last
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      if (/^(400|401|402|403|422)\b/.test(String(e.message))) break // not retryable
      await new Promise((r) => setTimeout(r, 1500 * i))
    }
  }
  throw last
}

module.exports = { key, API, post, retry }
