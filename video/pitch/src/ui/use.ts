import { useCurrentFrame } from "remotion";
import { scene, speechEnd, wordAt } from "../timing";

/** Scene-local frame, plus word cues relative to the scene's start. */
export const useScene = (id: string) => {
  const s = scene(id);
  const f = useCurrentFrame();
  const rel = (w: string, n = 0) => wordAt(id, w, n) - s.from;
  return { f, rel, dur: s.durationInFrames, end: speechEnd(id) - s.from, voice: s.lines[0].startFrame - s.from };
};
