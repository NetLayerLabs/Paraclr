import React from 'react'
import { AbsoluteFill, interpolate } from 'remotion'
import { CUT, cue } from './timing'
import { Accent, C, CLAMP, Corners, DISPLAY, EASE_IN_OUT, Word, prog } from './ui'

/**
 * 04 — purple full-bleed. "Fair liquidations, cleared every block." The brand's 8-lane
 * bend sweeps across in two layers at different speeds (parallax); on "cleared",
 * "every" and "block" a pulse runs down every lane at once, each in its own lane.
 * It arrives as eight purple bands wiping in from the left, the lanes as a transition.
 */

type Layout = {
  hx: number; hy: number; hs: number; as: number; corner: number; cornerSize: number; accentLines: string[][]
  cx: number; cy: number; r: number; d: number; turn: 'up' | 'down'; farY: number; farPitch: number
}
const WIDE: Layout = {
  hx: 120, hy: 170, hs: 112, as: 140, corner: 48, cornerSize: 21, accentLines: [['cleared', 'every', 'block.']],
  cx: 1000, cy: 390, r: 250, d: 30, turn: 'up', farY: 905, farPitch: 22,
}
const SQUARE: Layout = {
  hx: 80, hy: 150, hs: 88, as: 118, corner: 40, cornerSize: 19, accentLines: [['cleared', 'every'], ['block.']],
  cx: 560, cy: 1010, r: 230, d: 26, turn: 'down', farY: 0, farPitch: 0,
}

/** Lane k: in from the left edge, a quarter turn around (cx, cy), out through the top (or bottom). */
const bend = (cx: number, cy: number, r: number, turn: 'up' | 'down', h: number) =>
  turn === 'up'
    ? `M -80 ${cy + r} H ${cx} A ${r} ${r} 0 0 0 ${cx + r} ${cy} V -80`
    : `M -80 ${cy - r} H ${cx} A ${r} ${r} 0 0 1 ${cx + r} ${cy} V ${h + 80}`

export const S4Lanes: React.FC<{ frame: number; sq?: boolean; width: number; height: number }> = ({ frame, sq, width, height }) => {
  const L = sq ? SQUARE : WIDE
  const t0 = CUT.s4
  const pulses = [cue('l4', 'cleared'), cue('l4', 'every'), cue('l4', 'block.')]

  // Parallax: the near bend drifts faster than the far, dashed lanes scroll (blocks passing).
  const drift = interpolate(frame, [t0, CUT.s5 + 30], [0, 1], CLAMP)
  const nearX = 50 - drift * 130
  const farShift = (frame - t0) * 1.1

  const lanes = (cx: number, cy: number, r: number, d: number, opacityScale: number, stroke: number, delay: number, withPulses: boolean) =>
    Array.from({ length: 8 }, (_, k) => {
      const rk = r + k * d
      const path = bend(cx, cy, rk, L.turn, height)
      const draw = prog(frame, t0 + delay + k * 2.5, 34, EASE_IN_OUT)
      const op = (0.78 - k * 0.075) * opacityScale
      return (
        <g key={k}>
          <path d={path} fill="none" stroke="#FFFFFF" strokeOpacity={op} strokeWidth={stroke} pathLength={1} strokeDasharray={1} strokeDashoffset={1 - draw} />
          {withPulses
            ? pulses.map((p, i) => {
                const t = interpolate(frame, [p + k * 1.5, p + k * 1.5 + 50], [0, 1], CLAMP)
                if (t <= 0 || t >= 1) return null
                const len = 0.07
                return (
                  <path
                    key={i}
                    d={path}
                    fill="none"
                    stroke="#FFFFFF"
                    strokeWidth={stroke + 3}
                    strokeLinecap="round"
                    pathLength={1}
                    strokeDasharray={`${len} ${2}`}
                    strokeDashoffset={-(t * (1 + len)) + len}
                    opacity={Math.min(1, (1 - t) * 3)}
                  />
                )
              })
            : null}
        </g>
      )
    })

  // Eight bands wipe in from the left, top lane first.
  const bands = Array.from({ length: 8 }, (_, i) => prog(frame, t0 + i * 1.6, 16, EASE_IN_OUT))

  return (
    <AbsoluteFill>
      {bands.map((b, i) => (
        <div key={i} style={{ position: 'absolute', left: 0, top: (height / 8) * i - 1, height: height / 8 + 2, width: `${b * 100}%`, background: C.purple }} />
      ))}
      <AbsoluteFill style={{ opacity: prog(frame, t0 + 6, 8) }}>
        <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
          {L.farPitch
            ? Array.from({ length: 8 }, (_, k) => (
                <line
                  key={k}
                  x1={-40}
                  x2={-40 + (width + 80) * prog(frame, t0 + 8 + k * 2, 30, EASE_IN_OUT)}
                  y1={L.farY + k * L.farPitch}
                  y2={L.farY + k * L.farPitch}
                  stroke="#FFFFFF"
                  strokeOpacity={0.26 - k * 0.022}
                  strokeWidth={1.5}
                  strokeDasharray="46 22"
                  strokeDashoffset={farShift * (1 + k * 0.04) + k * 17}
                />
              ))
            : null}
          <g transform={`translate(${nearX}, 0)`}>{lanes(L.cx, L.cy, L.r, L.d, 1, 2.2, 4, true)}</g>
        </svg>
        <Corners frame={frame} n="04" label="every block" tone="purple" pad={L.corner} size={L.cornerSize} />
        <div style={{ position: 'absolute', left: L.hx, top: L.hy, fontFamily: DISPLAY, fontWeight: 800, fontSize: L.hs, letterSpacing: '-0.045em', lineHeight: 1.04, color: C.white }}>
          <div>
            <Word frame={frame} at={cue('l4', 'Fair')}>Fair</Word>{' '}
            <Word frame={frame} at={cue('l4', 'liquidations.')}>liquidations,</Word>
          </div>
          <div style={{ marginTop: L.hs * 0.04 }}>
            {L.accentLines.map((line, i) => (
              <div key={i}>
                <Accent
                  frame={frame}
                  color={C.white}
                  size={L.as}
                  underline={i === L.accentLines.length - 1 ? pulses[2] + 8 : undefined}
                  words={line.map((w) => ({ t: w, at: cue('l4', w === 'cleared' ? 'Cleared' : w) }))}
                />
              </div>
            ))}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}
