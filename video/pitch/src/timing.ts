import raw from "./timing.json";

export interface Word { word: string; start: number; end: number }
export interface Line { text: string; file: string | null; startFrame: number; durationFrames: number; words: Word[] }
export interface Scene { id: string; from: number; durationInFrames: number; lines: Line[] }
export interface Timing { fps: number; placeholder: boolean; totalFrames: number; music: { file: string; source: string }; scenes: Scene[] }

/** src/timing.json, written by scripts/timing.mjs (placeholder pacing, or synced to the founder's voice). */
export const T = raw as unknown as Timing;

const clean = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, "");
export const scene = (id: string): Scene => {
  const s = T.scenes.find((x) => x.id === id);
  if (!s) throw new Error(`scene ${id} missing from timing`);
  return s;
};
/** Absolute frame where `word` (case and punctuation ignored) starts in a scene. */
export const wordAt = (sceneId: string, word: string, nth = 0): number => {
  const hits = scene(sceneId).lines.flatMap((l) => l.words).filter((w) => clean(w.word) === clean(word));
  const hit = hits[nth] ?? hits[0];
  if (!hit) throw new Error(`word "${word}" not in ${sceneId}`);
  return hit.start;
};
/** Absolute frame where the last word of a scene ends. */
export const speechEnd = (sceneId: string) => { const l = scene(sceneId).lines.at(-1)!; return l.words[l.words.length - 1].end; };
