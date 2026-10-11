// Narration for every line in script.json, via ElevenLabs /with-timestamps.
//   node scripts/voiceover.mjs                 generate changed/missing lines (hash cache)
//   ONLY=clock_1 node scripts/voiceover.mjs    force one or more ids (comma list)
// The voice reads `say(text)`: the same words, with pronunciation-only respellings (SAY) that keep
// the word count, so each spoken word maps back to the script's word for captions and timing.
// Outputs: public/audio/vo/<id>.mp3 (-16 LUFS), .cache/raw/<id>.mp3, .cache/words/<id>.json, .cache/vo.json
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ROOT, post, retry } from "./env.mjs";
import { renderVo } from "./vofx.mjs";

const script = JSON.parse(readFileSync(join(ROOT, "script.json"), "utf8"));
const OUT = join(ROOT, "public/audio/vo");
const RAW = join(ROOT, ".cache/raw");
const WORDS = join(ROOT, ".cache/words");
const CACHE = join(ROOT, ".cache/vo.json");
for (const d of [OUT, RAW, WORDS]) mkdirSync(d, { recursive: true });
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : { lines: {}, charsUsed: 0 };

// Pronunciation only: one word in, one word out.
const SAY = [
  [/\bParaclr's\b/g, "Para-clear's"],
  [/\bParaclr\b/g, "Paraclear"],
  [/\bparaclr\b/g, "paraclear"],
  [/\bAUSD\b/g, "A-U-S-D"],
  [/\bSOL\b/g, "Sol"],
];
const say = (t) => SAY.reduce((s, [re, to]) => s.replace(re, to), t);

// Per-line performance direction.
const OVERRIDES = {
  open_0: { stability: 0.6, style: 0.25, speed: 0.92 },
  open_1: { stability: 0.6, style: 0.25, speed: 0.9 },
  turn_0: { stability: 0.6, style: 0.3, speed: 0.9 },
  turn_1: { stability: 0.6, style: 0.35, speed: 0.88 },
  kept_0: { speed: 0.96 },
  problem_1: { speed: 0.93 },
  xray_1: { stability: 0.6, style: 0.3, speed: 0.92 },
  builton_0: { speed: 1.02 },
  close_0: { stability: 0.62, style: 0.3, speed: 0.88 },
};
const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
const durationOf = (f) => parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f]).toString());

function toWords(a) {
  const words = [];
  let cur = null;
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) { if (cur) { words.push(cur); cur = null; } return; }
    if (!cur) cur = { word: "", start: a.character_start_times_seconds[i], end: 0 };
    cur.word += ch;
    cur.end = a.character_end_times_seconds[i];
  });
  if (cur) words.push(cur);
  return words;
}
const all = script.scenes.flatMap((s) => s.lines.map((l, i) => ({ id: `${s.id}_${i}`, ...l })));
async function synth(idx, voiceId, settings) {
  return retry(async () => {
    const res = await post(`/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, {
      text: say(all[idx].text), model_id: script.model, voice_settings: settings,
      previous_text: all.slice(Math.max(0, idx - 2), idx).map((l) => say(l.text)).join(" ") || undefined,
      next_text: all[idx + 1] ? say(all[idx + 1].text) : undefined,
    });
    const body = await res.json();
    return { audio: Buffer.from(body.audio_base64, "base64"), words: toWords(body.alignment) };
  });
}
const sane = (text, words) => { const sp = words.at(-1).end - words[0].start; const cps = text.length / sp; return { ok: cps >= 9 && cps <= 19, cps }; };

let used = 0;
for (const [idx, line] of all.entries()) {
  const id = line.id;
  const voice = script.voices[line.voice];
  const settings = { ...voice.settings, ...(OVERRIDES[id] || {}) };
  const hash = createHash("sha1").update(JSON.stringify([say(line.text), voice.id, settings, script.model])).digest("hex");
  const have = existsSync(join(OUT, `${id}.mp3`)) && existsSync(join(WORDS, `${id}.json`));
  if (only ? !only.includes(id) : have && cache.lines[id]?.hash === hash) { continue; }
  let take = await synth(idx, voice.id, settings);
  used += line.text.length;
  let chk = sane(line.text, take.words);
  if (!chk.ok) {
    console.log(`${id}: ${chk.cps.toFixed(1)} cps looks off, retaking once`);
    const again = await synth(idx, voice.id, settings);
    used += line.text.length;
    const chk2 = sane(line.text, again.words);
    if (Math.abs(chk2.cps - 14) < Math.abs(chk.cps - 14)) { take = again; chk = chk2; }
  }
  const shown = line.text.split(/\s+/);
  if (shown.length !== take.words.length) throw new Error(`${id}: ${take.words.length} spoken words vs ${shown.length} script words`);
  const words = take.words.map((w, i) => ({ ...w, word: shown[i] }));
  writeFileSync(join(RAW, `${id}.mp3`), take.audio);
  renderVo(id, 1);
  writeFileSync(join(WORDS, `${id}.json`), JSON.stringify({ tempo: 1, words }, null, 1));
  const dur = durationOf(join(OUT, `${id}.mp3`));
  cache.lines[id] = { hash, voice: voice.id, chars: line.text.length, dur };
  console.log(`${id}: ${dur.toFixed(2)}s  ${chk.cps.toFixed(1)} cps`);
}
cache.charsUsed = (cache.charsUsed || 0) + used;
writeFileSync(CACHE, JSON.stringify(cache, null, 1));
console.log(`chars this run: ${used}, total logged: ${cache.charsUsed}`);
