import { createContext, useContext } from "react";
import raw from "./timing.json";

export interface Word { word: string; start: number; end: number }
export interface Line { voice: string; text: string; file: string; startFrame: number; durationFrames: number; words: Word[] }
export interface Scene { id: string; from: number; durationInFrames: number; lines: Line[] }
export interface Timing { fps: number; totalFrames: number; bpm: number; beats: number[]; scenes: Scene[] }

/** The film's timeline (src/timing.json). The technical demo provides its own through TimingCtx. */
export const T = raw as unknown as Timing;
export const FPS = T.fps;
export const TimingCtx = createContext<Timing>(T);
export const useTiming = () => useContext(TimingCtx);

const clean = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, "");
export const sceneIn = (t: Timing, id: string): Scene => {
  const s = t.scenes.find((x) => x.id === id);
  if (!s) throw new Error(`scene ${id} missing from timing`);
  return s;
};
/** Absolute frame where `word` (case-insensitive, punctuation ignored) starts in a scene; null if absent. */
export const findWord = (t: Timing, sceneId: string, word: string, nth = 0): number | null => {
  const hits = sceneIn(t, sceneId).lines.flatMap((l) => l.words).filter((w) => clean(w.word) === clean(word));
  const hit = hits[nth] ?? hits[0];
  return hit ? hit.start : null;
};

// Film-timeline helpers (Film.tsx).
export const scene = (id: string): Scene => sceneIn(T, id);
export const wordAt = (sceneId: string, word: string, nth = 0): number => {
  const v = findWord(T, sceneId, word, nth);
  if (v == null) throw new Error(`word "${word}" not in ${sceneId}`);
  return v;
};
export const lineStart = (sceneId: string, i: number) => scene(sceneId).lines[i].startFrame;
export const lineEnd = (sceneId: string, i: number) => {
  const l = scene(sceneId).lines[i];
  return l.words[l.words.length - 1].end;
};
