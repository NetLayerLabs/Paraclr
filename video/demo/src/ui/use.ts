import { useCurrentFrame } from "remotion";
import { scene, wordAt, lineStart } from "../timing";

/** Scene-local frame plus word cues relative to the scene's start. */
export const useScene = (id: string) => {
  const s = scene(id);
  const f = useCurrentFrame();
  const rel = (w: string, n = 0) => wordAt(id, w, n) - s.from;
  const line = (i: number) => lineStart(id, i) - s.from;
  return { f, rel, line, dur: s.durationInFrames };
};
