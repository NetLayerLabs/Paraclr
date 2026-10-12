// Word timestamps for .cache/voice-clean.wav -> .cache/transcript.json  ({ words: [{ text, start, end }] }, seconds)
//   node scripts/transcribe.mjs
// ElevenLabs speech-to-text (scribe_v1, word granularity). The key is read at runtime by env.mjs, never printed.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, key, API, retry } from "./env.mjs";

const src = join(ROOT, ".cache/voice-clean.wav");
const up = join(ROOT, ".cache/voice-upload.flac");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-ac", "1", "-ar", "16000", up]);
const json = await retry(async () => {
  const fd = new FormData();
  fd.append("model_id", "scribe_v1");
  fd.append("language_code", "en");
  fd.append("timestamps_granularity", "word");
  fd.append("tag_audio_events", "true");
  fd.append("file", new Blob([readFileSync(up)], { type: "audio/flac" }), "voice.flac");
  const res = await fetch(`${API}/speech-to-text`, { method: "POST", headers: { "xi-api-key": key }, body: fd });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
});
const words = (json.words || []).filter((w) => w.type === "word").map((w) => ({ text: w.text, start: w.start, end: w.end }));
const events = (json.words || []).filter((w) => w.type === "audio_event").map((w) => ({ text: w.text, start: w.start, end: w.end }));
writeFileSync(join(ROOT, ".cache/transcript.json"), JSON.stringify({ source: "elevenlabs scribe_v1", text: json.text, words, events }, null, 1));
console.log(`${words.length} words, ${events.length} audio events`);
console.log(json.text);
