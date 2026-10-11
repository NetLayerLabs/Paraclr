// Auditions candidate narrators on two script lines, then scores each take objectively:
// pace (chars/s of speech), loudness range, and clarity (ElevenLabs speech-to-text word
// accuracy against the script). Takes go to .cache/audition/<voice>_<line>.mp3.
//   node scripts/audition.mjs
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, post, retry, key, API } from "./env.mjs";

const VOICES = {
  Sarah: "EXAVITQu4vr4xnSDxMaL",
  Lily: "pFZP5JQG7iQjIQuC4Bku",
  Alice: "Xb7hH8MSUJpSbSDYk0k2",
};
const LINES = [
  "October twenty twenty-five. Crypto's largest liquidation day ever. More than nineteen billion dollars. One point six million traders. In twenty-four hours.",
  "When an account goes underwater, it enters a Dutch auction. The discount starts at zero and rises five basis points every block. On Monad, that's a step every third of a second.",
];
const SETTINGS = { stability: 0.5, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true };
const dir = join(ROOT, ".cache/audition");
mkdirSync(dir, { recursive: true });
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter(Boolean);

function wer(ref, hyp) {
  const a = norm(ref), b = norm(hyp);
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length] / a.length;
}
async function stt(file) {
  const fd = new FormData();
  fd.append("model_id", "scribe_v1");
  fd.append("file", new Blob([readFileSync(file)]), "a.mp3");
  const r = await fetch(`${API}/speech-to-text`, { method: "POST", headers: { "xi-api-key": key }, body: fd });
  if (!r.ok) return null;
  return (await r.json()).text;
}
for (const [name, id] of Object.entries(VOICES)) {
  for (const [i, text] of LINES.entries()) {
    const res = await retry(() => post(`/text-to-speech/${id}/with-timestamps?output_format=mp3_44100_128`, { text, model_id: "eleven_multilingual_v2", voice_settings: SETTINGS }));
    const body = await res.json();
    const f = join(dir, `${name}_${i}.mp3`);
    writeFileSync(f, Buffer.from(body.audio_base64, "base64"));
    const a = body.alignment;
    const first = a.characters.findIndex((c) => /\S/.test(c));
    const speech = a.character_end_times_seconds.at(-1) - a.character_start_times_seconds[first];
    const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", f, "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" });
    const lra = r.stderr.match(/LRA:\s+([\d.]+) LU/g)?.at(-1);
    const hyp = await stt(f);
    console.log(`${name.padEnd(6)} line${i}  ${speech.toFixed(1)}s  ${(text.length / speech).toFixed(1)} cps  ${lra}  WER ${hyp == null ? "n/a" : (wer(text, hyp) * 100).toFixed(0) + "%"}  | ${hyp ?? ""}`);
  }
}
