// Technical demo: copies the lines marked "reuse" in script-tech.json from the film's takes
// (.cache/raw/<src>.mp3 + .cache/words/<src>.json) into the tech cut's own folders, never touching
// the film's audio. "cutAfter": n keeps words 0..n and ends the take between word n and n+1 with a
// short fade.
//   node scripts/reuse.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { renderVo } from "./vofx.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const script = JSON.parse(readFileSync(join(ROOT, "script-tech.json"), "utf8"));
const DIRS = { raw: ".cache/raw-tech", out: "public/audio/vo-tech", words: ".cache/words-tech" };
for (const d of Object.values(DIRS)) mkdirSync(join(ROOT, d), { recursive: true });
for (const scene of script.scenes) for (const [i, line] of scene.lines.entries()) {
  if (!line.reuse) continue;
  const id = `${scene.id}_${i}`;
  const w = JSON.parse(readFileSync(join(ROOT, ".cache/words", `${line.reuse}.json`), "utf8"));
  copyFileSync(join(ROOT, ".cache/raw", `${line.reuse}.mp3`), join(ROOT, DIRS.raw, `${id}.mp3`));
  let post = "";
  let words = w.words;
  if (line.cutAfter != null) {
    const a = words[line.cutAfter], b = words[line.cutAfter + 1];
    const cut = b ? (a.end + b.start) / 2 : a.end + 0.2;
    post = `atrim=0:${cut.toFixed(3)},afade=t=out:st=${(cut - 0.04).toFixed(3)}:d=0.04,apad=pad_dur=0.25,`;
    words = words.slice(0, line.cutAfter + 1);
  }
  const shown = line.text.split(/\s+/);
  if (shown.length !== words.length) throw new Error(`${id}: ${words.length} words in take vs ${shown.length} in script`);
  words = words.map((x, k) => ({ ...x, word: shown[k] }));
  renderVo(id, 1, DIRS, post);
  writeFileSync(join(ROOT, DIRS.words, `${id}.json`), JSON.stringify({ tempo: 1, words }, null, 1));
  console.log(`${id} <- ${line.reuse}${line.cutAfter != null ? ` (cut after "${words.at(-1).word}")` : ""}`);
}
