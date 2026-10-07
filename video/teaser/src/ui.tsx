import React from 'react'
import { Easing, interpolate, spring } from 'remotion'
import { loadFont as loadSora } from '@remotion/google-fonts/Sora'
import { loadFont as loadGeist } from '@remotion/google-fonts/Geist'
import { loadFont as loadGeistMono } from '@remotion/google-fonts/GeistMono'
import { loadFont as loadInstrument } from '@remotion/google-fonts/InstrumentSerif'
import { FPS } from './timing'

/**
 * Shared furniture, set to docs/DESIGN.md: Sora 800 display with tight tracking, Geist
 * for UI, Geist Mono for every number and label, one purple accent (#6E54FF), green only
 * for what the trader keeps, red only for the bot / gas race. The italic serif accent
 * word is the teaser's one borrowed device from the style reference.
 */

/* ------------------------------------------------------------------ palette */

export const C = {
  purple: '#6E54FF',
  purpleText: '#5A3FF2',
  purpleOnDark: '#A898FF',
  purpleSoft: '#F1EEFF',
  purpleLine: '#D9D1FF',
  lane: '#8F7CFF',
  black: '#07060C',
  white: '#FFFFFF',
  ink: '#0B0A12',
  ink2: '#45434F',
  ink3: '#6B6979',
  display2: '#8B8996',
  line: '#E9E8F0',
  lineStrong: '#D9D7E3',
  subtle: '#F6F6F9',
  // dark chapter
  dSurface: '#111019',
  dSurface2: '#16141F',
  dLine: 'rgba(255,255,255,0.09)',
  dInk: '#F5F4FA',
  dInk2: '#B6B3C6',
  dInk3: '#8E8AA2',
  dDisplay2: '#77748A',
  // meaning only
  pos: '#0E9F6E',
  posText: '#067A52',
  posSoft: '#E8F7F0',
  posLine: '#BCE9D4',
  posDark: '#3DDC97',
  neg: '#E5484D',
  negText: '#C2282E',
  negSoft: '#FDEDED',
  negLine: '#F6CACC',
  negDark: '#FF5C7A',
  warnText: '#A15C07',
  warnSoft: '#FEF6E7',
  warnLine: '#F6DCAA',
}

/* -------------------------------------------------------------------- fonts */

const sora = loadSora('normal', { weights: ['600', '700', '800'], subsets: ['latin'] })
const geist = loadGeist('normal', { weights: ['400', '500', '600'], subsets: ['latin'] })
const mono = loadGeistMono('normal', { weights: ['400', '500', '600'], subsets: ['latin'] })
const serif = loadInstrument('italic', { weights: ['400'], subsets: ['latin'] })

export const DISPLAY = `${sora.fontFamily}, sans-serif`
export const SANS = `${geist.fontFamily}, system-ui, sans-serif`
export const MONO = `${mono.fontFamily}, ui-monospace, monospace`
export const SERIF = `${serif.fontFamily}, Georgia, serif`

/* ------------------------------------------------------------------- motion */

export const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
/** The brand's one easing curve (--pc-ease). */
export const EASE = Easing.bezier(0.2, 0.7, 0.2, 1)
export const EASE_IN_OUT = Easing.bezier(0.65, 0, 0.35, 1)
export const EASE_IN = Easing.bezier(0.55, 0, 0.9, 0.4)

/** 0 → 1 between two frames with the brand ease. */
export const prog = (frame: number, start: number, dur: number, ease = EASE) =>
  interpolate(frame, [start, start + dur], [0, 1], { ...CLAMP, easing: ease })

/** A spring that starts at `start`; snappy by default, for pops and lands. */
export const pop = (frame: number, start: number, cfg: { damping?: number; stiffness?: number; mass?: number } = {}) =>
  spring({ frame: frame - start, fps: FPS, config: { damping: 14, stiffness: 190, mass: 0.7, ...cfg } })

export const mix = (a: number, b: number, t: number) => a + (b - a) * t

/* --------------------------------------------------------------- headlines */

/** One word, uncovered from its own baseline at `at` (masked rise + a little blur). */
export const Word: React.FC<{ frame: number; at: number; children: React.ReactNode; style?: React.CSSProperties; dur?: number }> = ({
  frame, at, children, style, dur = 16,
}) => {
  const p = prog(frame, at, dur)
  return (
    <span style={{ display: 'inline-block', overflow: 'hidden', verticalAlign: 'top', padding: '0.06em 0.04em 0.16em', margin: '-0.06em -0.04em -0.16em' }}>
      <span style={{ display: 'inline-block', transform: `translateY(${(1 - p) * 105}%)`, filter: `blur(${(1 - p) * 6}px)`, opacity: p > 0 ? 1 : 0, ...style }}>
        {children}
      </span>
    </span>
  )
}

/** The accent: italic serif, written in with a hand-drawn underline that draws after it. */
export const Accent: React.FC<{
  frame: number
  words: { t: string; at: number }[]
  color: string
  size: number
  underline?: number // frame the underline starts drawing
  underlineColor?: string
  style?: React.CSSProperties
}> = ({ frame, words, color, size, underline, underlineColor, style }) => {
  const u = underline === undefined ? 0 : prog(frame, underline, 18, EASE_IN_OUT)
  return (
    <span style={{ position: 'relative', display: 'inline-block', fontFamily: SERIF, fontStyle: 'italic', fontWeight: 400, fontSize: size, letterSpacing: '-0.01em', color, lineHeight: 1, ...style }}>
      {words.map((w, i) => (
        <React.Fragment key={i}>
          {i > 0 ? ' ' : null}
          <Word frame={frame} at={w.at} dur={14}>
            {w.t}
          </Word>
        </React.Fragment>
      ))}
      {underline !== undefined ? (
        <span
          style={{
            position: 'absolute', left: '1%', right: '3%', bottom: '-0.1em', height: Math.max(4, size * 0.042), borderRadius: 99,
            background: underlineColor ?? color, transform: `rotate(-0.8deg) scaleX(${u})`, transformOrigin: 'left center',
          }}
        />
      ) : null}
    </span>
  )
}

/* ------------------------------------------------------------- furniture */

const tc = (frame: number) => {
  const s = Math.floor(frame / FPS)
  const ff = frame % FPS
  return `00:00:${String(s).padStart(2, '0')}:${String(ff).padStart(2, '0')}`
}

/** `// 01 — label` top left and the brand + timecode top right, like a cut sheet. */
export const Corners: React.FC<{ frame: number; n: string; label: string; dark?: boolean; tone?: 'light' | 'dark' | 'purple'; pad?: number; size?: number }> = ({
  frame, n, label, tone = 'light', pad = 48, size = 21,
}) => {
  const color = tone === 'light' ? C.display2 : tone === 'dark' ? C.dDisplay2 : 'rgba(255,255,255,0.72)'
  const base: React.CSSProperties = { position: 'absolute', top: pad - 8, fontFamily: MONO, fontSize: size, letterSpacing: '0.02em', color, whiteSpace: 'pre', fontVariantNumeric: 'tabular-nums' }
  return (
    <>
      <div style={{ ...base, left: pad }}>{`// ${n} — ${label}`}</div>
      <div style={{ ...base, right: pad }}>{`PARACLR   ${tc(frame)}`}</div>
    </>
  )
}

/** Window chrome for product cards: three quiet dots. */
export const Chrome: React.FC<{ dark?: boolean; size?: number }> = ({ dark, size = 11 }) => (
  <span style={{ display: 'inline-flex', gap: size * 0.62 }}>
    {[0, 1, 2].map((i) => (
      <i key={i} style={{ width: size, height: size, borderRadius: 99, background: dark ? 'rgba(255,255,255,0.14)' : C.lineStrong }} />
    ))}
  </span>
)

type ChipTone = 'neutral' | 'accent' | 'pos' | 'neg' | 'warn' | 'dneg' | 'dneutral'
const CHIP: Record<ChipTone, [string, string, string]> = {
  neutral: [C.white, C.line, C.ink3],
  accent: [C.purpleSoft, C.purpleLine, C.purpleText],
  pos: [C.posSoft, C.posLine, C.posText],
  neg: [C.negSoft, C.negLine, C.negText],
  warn: [C.warnSoft, C.warnLine, C.warnText],
  dneg: ['rgba(255,92,122,0.10)', 'rgba(255,92,122,0.35)', C.negDark],
  dneutral: ['rgba(255,255,255,0.04)', 'rgba(255,255,255,0.14)', C.dInk2],
}

/** Mono pill that states a fact (network, status, role), with an optional leading dot. */
export const Chip: React.FC<{ tone?: ChipTone; size?: number; dot?: string; children: React.ReactNode; style?: React.CSSProperties }> = ({
  tone = 'neutral', size = 18, dot, children, style,
}) => {
  const [bg, line, fg] = CHIP[tone]
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: size * 0.45, padding: `${size * 0.28}px ${size * 0.7}px`,
        border: `1.5px solid ${line}`, borderRadius: 999, background: bg, color: fg,
        fontFamily: MONO, fontSize: size, fontWeight: 500, letterSpacing: '0.01em', whiteSpace: 'nowrap', lineHeight: 1.2, ...style,
      }}
    >
      {dot ? <i style={{ width: size * 0.42, height: size * 0.42, borderRadius: 99, background: dot }} /> : null}
      {children}
    </span>
  )
}
