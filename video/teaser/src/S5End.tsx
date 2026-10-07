import React from 'react'
import { AbsoluteFill, Img, staticFile } from 'remotion'
import { CUT, cue } from './timing'
import { C, DISPLAY, EASE_IN_OUT, MONO, SANS, SERIF, Word, mix, pop, prog } from './ui'

/**
 * 05 — black end card. The white Paraclr lockup (cut at full resolution from the repo's
 * artwork by scripts/logos.cjs) draws in, then "Coming soon.", "on" + the official Monad
 * logo (monad.xyz brand kit, inverted variant, small), and a redacted address that
 * keeps scrambling (a tease: the address is never shown).
 * Arrives through a black iris ringed by eight lanes.
 */

// Source pixel geometry of the lockup (lockup-white.png 1633x466: mark 0..581, word 633..1633).
const SRC = { w: 1633, h: 466, markW: 581, wordX: 633, wordW: 1000 }
const MONAD_ASPECT = 423 / 80

type Layout = { lockH: number; lockY: number; comingY: number; comingS: number; monadY: number; monadH: number; urlY: number; urlS: number }
const WIDE: Layout = { lockH: 200, lockY: 262, comingY: 548, comingS: 84, monadY: 682, monadH: 38, urlY: 800, urlS: 30 }
const SQUARE: Layout = { lockH: 168, lockY: 250, comingY: 506, comingS: 80, monadY: 636, monadH: 36, urlY: 820, urlS: 30 }

export const S5End: React.FC<{ frame: number; sq?: boolean; width: number; height: number }> = ({ frame, sq, width, height }) => {
  const L = sq ? SQUARE : WIDE
  const t0 = CUT.s5
  const s = L.lockH / SRC.h
  const lockW = SRC.w * s
  const lx = (width - lockW) / 2

  const markP = prog(frame, t0 + 2, 26)
  const wordP = prog(frame, t0 + 10, 24)
  const tComing = Math.max(cue('l5', 'Coming'), t0 + 20)
  const tSoon = cue('l5', 'soon,')
  const tOn = cue('l5', 'on')
  const tMonad = cue('l5', 'Monad.')
  const monadP = pop(frame, tMonad - 2, { damping: 15, stiffness: 200 })
  const urlP = prog(frame, tMonad + 10, 18)
  // A very slow push-in so the hold never reads as a freeze-frame.
  const push = mix(1, 1.025, prog(frame, t0, 135, EASE_IN_OUT))

  return (
    <AbsoluteFill style={{ background: C.black }}>
      <AbsoluteFill style={{ transform: `scale(${push})` }}>
        {/* Lockup: the mark's lanes flow in from the left, then the wordmark uncovers */}
        <div style={{ position: 'absolute', left: lx, top: L.lockY, width: lockW, height: L.lockH }}>
          <Img
            src={staticFile('brand/mark-white.png')}
            style={{
              position: 'absolute', left: 0, top: 0, height: L.lockH, width: SRC.markW * s,
              clipPath: `inset(0 ${(1 - markP) * 100}% 0 0)`, transform: `translateX(${(1 - markP) * -40}px)`,
            }}
          />
          <Img
            src={staticFile('brand/word-white.png')}
            style={{
              position: 'absolute', left: SRC.wordX * s, top: 0, height: L.lockH, width: SRC.wordW * s,
              clipPath: `inset(0 ${(1 - wordP) * 100}% 0 0)`, transform: `translateX(${(1 - wordP) * 30}px)`, opacity: Math.min(1, wordP * 3),
            }}
          />
        </div>

        {/* Coming soon. */}
        <div style={{ position: 'absolute', left: 0, right: 0, top: L.comingY, textAlign: 'center', fontFamily: DISPLAY, fontWeight: 800, fontSize: L.comingS, letterSpacing: '-0.045em', lineHeight: 1.1, color: C.dInk }}>
          <Word frame={frame} at={tComing}>Coming</Word>{' '}
          <span style={{ fontFamily: SERIF, fontStyle: 'italic', fontWeight: 400, fontSize: L.comingS * 1.3, letterSpacing: '-0.01em', color: C.purpleOnDark }}>
            <Word frame={frame} at={tSoon}>soon.</Word>
          </span>
        </div>

        {/* on Monad: official logo, small */}
        <div style={{ position: 'absolute', left: 0, right: 0, top: L.monadY, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: L.monadH * 0.45 }}>
          <span style={{ fontFamily: SANS, fontWeight: 500, fontSize: L.monadH * 0.86, color: C.dInk3, opacity: prog(frame, tOn, 12), transform: `translateY(${(1 - prog(frame, tOn, 12)) * 12}px)` }}>on</span>
          <Img
            src={staticFile('monad/monad-logo-inverted.svg')}
            style={{ height: L.monadH, width: L.monadH * MONAD_ASPECT, opacity: Math.min(1, monadP * 1.6), transform: `translateY(${(1 - monadP) * 16}px) scale(${mix(0.86, 1, monadP)})` }}
          />
        </div>

        {/* Redacted address: a scramble of shade cells that keeps cycling and never resolves.
            No glyph of the real address is ever drawn, so no frame can be read. */}
        <div style={{ position: 'absolute', left: 0, right: 0, top: L.urlY, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: L.urlS * 0.6, opacity: urlP, transform: `translateY(${(1 - urlP) * 14}px)` }}>
          <Redacted frame={frame} cell={L.urlS * 0.62} height={L.urlS * 1.05} />
          <span style={{ fontFamily: MONO, fontSize: L.urlS * 0.62, letterSpacing: '0.02em', color: C.dDisplay2 }}>// soon</span>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}

const SHADES = [0.9, 0.62, 0.38, 0.16] // █ ▓ ▒ ░
/** Eleven shade cells re-dealt every few frames (deterministic per frame, so renders repeat). */
const Redacted: React.FC<{ frame: number; cell: number; height: number }> = ({ frame, cell, height }) => {
  const tick = Math.floor(frame / 4)
  const rnd = (i: number) => {
    const x = Math.sin((tick + 1) * 12.9898 + (i + 1) * 78.233) * 43758.5453
    return x - Math.floor(x)
  }
  return (
    <span style={{ display: 'inline-flex', gap: cell * 0.18, padding: `${height * 0.12}px ${cell * 0.3}px`, borderRadius: 6, background: 'rgba(255,255,255,0.04)', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)' }}>
      {Array.from({ length: 11 }, (_, i) => (
        <i key={i} style={{ width: cell, height: height * 0.76, borderRadius: 2, background: `rgba(245,244,250,${SHADES[Math.floor(rnd(i) * SHADES.length)]})` }} />
      ))}
    </span>
  )
}

/** The iris into the end card: a black circle opening from the centre, ringed by 8 lanes. */
export const Iris: React.FC<{ frame: number; start: number; dur: number; width: number; height: number; color: string; ring: string; children: React.ReactNode; cx?: number; cy?: number }> = ({
  frame, start, dur, width, height, color, ring, children, cx = width / 2, cy = height / 2,
}) => {
  const p = prog(frame, start, dur, EASE_IN_OUT)
  const maxR = Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy)) + 8 * 14 + 20
  const r = p * maxR
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ clipPath: `circle(${r}px at ${cx}px ${cy}px)`, background: color }}>{children}</AbsoluteFill>
      {p > 0 && p < 1 ? (
        <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
          {Array.from({ length: 8 }, (_, k) => (
            <circle key={k} cx={cx} cy={cy} r={r + 10 + k * 13} fill="none" stroke={ring} strokeWidth={2} strokeOpacity={0.75 - k * 0.08} />
          ))}
        </svg>
      ) : null}
    </AbsoluteFill>
  )
}
