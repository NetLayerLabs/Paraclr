import { useCurrentFrame } from "remotion";
import { findWord, sceneIn, useTiming } from "../timing";

/** Words a cut leaves out resolve here, so cues on them simply never fire. */
export const NEVER = 1e6;

/** Scene-local frame plus word cues relative to the scene's start, on whichever timeline is in context. */
export const useScene = (id: string) => {
  const t = useTiming();
  const s = sceneIn(t, id);
  const f = useCurrentFrame();
  const rel = (w: string, n = 0) => { const v = findWord(t, id, w, n); return v == null ? NEVER : v - s.from; };
  const line = (i: number) => (s.lines[i] ? s.lines[i].startFrame - s.from : NEVER);
  return { f, rel, line, dur: s.durationInFrames };
};
