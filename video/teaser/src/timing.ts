import vo from './vo.json'

/**
 * The teaser's clock. Every beat is cued to a word the narrator says: line start times
 * are fixed here, word times come from ElevenLabs' alignment (src/vo.json, written by
 * scripts/vo-gen.cjs), so re-recording a line re-times the graphics without hand edits.
 */
export const FPS = 60
export const DURATION = 900 // exactly 15.0 s

export type LineId = 'l1' | 'l2' | 'l3' | 'l4' | 'l5'
type Word = { w: string; s: number; e: number }
const LINES = vo.lines as Record<LineId, { text: string; say: string; dur: number; words: Word[] }>

/** When each VO line starts, in seconds of film time. */
export const LINE_START: Record<LineId, number> = { l1: 0.18, l2: 3.02, l3: 5.88, l4: 10.35, l5: 12.95 }

export const sec = (s: number) => Math.round(s * FPS)

const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9'-]/g, '')

/** Film frame at which `word` (its `nth` occurrence in the line) starts, or ends with edge 'e'. */
export const cue = (line: LineId, word: string, nth = 0, edge: 's' | 'e' = 's'): number => {
  const hits = LINES[line].words.filter((w) => norm(w.w) === norm(word))
  const hit = hits[nth]
  if (!hit) throw new Error(`cue: "${word}" #${nth} not in ${line}`)
  return sec(LINE_START[line] + hit[edge])
}

/** Last spoken frame of a line. */
export const lineEnd = (line: LineId) => sec(LINE_START[line] + LINES[line].words.at(-1)!.e)

/** Scene cuts, each just ahead of the line that carries it. */
export const CUT = {
  s1: 0,
  s2: sec(LINE_START.l2 - 0.07),
  s3: sec(LINE_START.l3 - 0.08),
  s4: sec(LINE_START.l4 - 0.1),
  s5: sec(LINE_START.l5 - 0.2),
  end: DURATION,
}

/** Speech envelope for ducking the music: 1 while any line is speaking. */
export const speaking = (frame: number) =>
  (Object.keys(LINE_START) as LineId[]).some((id) => frame >= sec(LINE_START[id] + LINES[id].words[0].s) - 4 && frame <= lineEnd(id) + 6)
