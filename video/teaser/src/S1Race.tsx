import React from 'react'
import { AbsoluteFill, Easing, interpolate } from 'remotion'
import { CUT, cue } from './timing'
import { Accent, C, CLAMP, Corners, DISPLAY, MONO, Word, mix, pop, prog } from './ui'

/**
 * 01 — white. "Most perps liquidate you / first bot wins." Three bots race along eight
 * lanes that funnel into one LIQUIDATE slot; one gets in, the rest are shut out, and a
 * "fixed fee" stamp slams on. Red is the race's colour and nothing else's.
 */

type Layout = {
  hx: number; hy: number; hs: number; as: number
  x0: number; xb: number; xs: number; y0: number; pitch: number
  slotW: number; slotH: number; pill: number; corner: number; cornerSize: number
  lines: string[][]
}

const WIDE: Layout = {
  hx: 120, hy: 160, hs: 104, as: 150,
  x0: 120, xb: 1000, xs: 1500, y0: 612, pitch: 38,
  slotW: 290, slotH: 108, pill: 20, corner: 48, cornerSize: 21,
  lines: [['Most', 'perps', 'liquidate', 'you']],
}
const SQUARE: Layout = {
  hx: 80, hy: 150, hs: 84, as: 128,
  x0: 80, xb: 420, xs: 740, y0: 660, pitch: 38,
  slotW: 262, slotH: 100, pill: 18, corner: 40, cornerSize: 19,
  lines: [['Most', 'perps'], ['liquidate', 'you']],
}

const BOTS = [
  { k: 1, id: 'bot 0x3f', stop: 0.86, lag: 4 },
  { k: 3, id: 'bot 0xa1', stop: 1, lag: 0 }, // the one that gets in
  { k: 6, id: 'bot 0x9c', stop: 0.8, lag: 7 },
]

export const S1Race: React.FC<{ frame: number; sq?: boolean }> = ({ frame, sq }) => {
  const L = sq ? SQUARE : WIDE
  const yc = L.y0 + L.pitch * 3.5
  const yk = (k: number) => L.y0 + L.pitch * k

  // Lane path: straight, then an S-curve into the slot's mouth.
  const point = (k: number, p: number) => {
    const a = (L.xb - L.x0) / (L.xb - L.x0 + (L.xs - L.xb) * 1.05)
    if (p <= a) return { x: mix(L.x0, L.xb, p / a), y: yk(k) }
    const u = Math.min(1, (p - a) / (1 - a))
    const bx = 3 * u * (1 - u) ** 2 * 0.5 + 3 * u * u * (1 - u) * 0.5 + u ** 3
    const by = 3 * u * u * (1 - u) + u ** 3
    return { x: mix(L.xb, L.xs, bx), y: mix(yk(k), yc, by) }
  }
  const lanePath = (k: number) => {
    const mx = (L.xb + L.xs) / 2
    return `M${L.x0} ${yk(k)} H${L.xb} C${mx} ${yk(k)}, ${mx} ${yc}, ${L.xs} ${yc}`
  }

  const tStart = cue('l1', 'liquidate') - 8
  const tWin = cue('l1', 'bot') + 4
  const tStamp = cue('l1', 'wins')
  const won = frame >= tWin

  // Small shake when the stamp lands.
  const sh = frame >= tStamp + 3 && frame < tStamp + 12 ? Math.sin((frame - tStamp) * 2.6) * (1 - (frame - tStamp - 3) / 9) * 7 : 0

  const slot = { x: L.xs, y: yc - L.slotH / 2 }
  const slotFill = prog(frame, tWin, 6)
  const stampP = pop(frame, tStamp, { damping: 13, stiffness: 320, mass: 0.6 })

  return (
    <AbsoluteFill style={{ background: C.white, transform: `translate(${sh}px, ${sh * 0.5}px)` }}>
      <Corners frame={frame} n="01" label="liquidations" pad={L.corner} size={L.cornerSize} />

      {/* Headline */}
      <div style={{ position: 'absolute', left: L.hx, top: L.hy, fontFamily: DISPLAY, fontWeight: 800, fontSize: L.hs, letterSpacing: '-0.045em', lineHeight: 1.04, color: C.ink }}>
        {L.lines.map((line, i) => (
          <div key={i}>
            {line.map((w, j) => (
              <React.Fragment key={w}>
                {j > 0 ? ' ' : null}
                <Word frame={frame} at={cue('l1', w === 'you' ? 'you...' : w)}>
                  {w}
                </Word>
              </React.Fragment>
            ))}
          </div>
        ))}
        <div style={{ marginTop: L.hs * 0.08 }}>
          <Accent
            frame={frame}
            color={C.neg}
            size={L.as}
            underline={tStamp + 2}
            words={[
              { t: 'first', at: cue('l1', 'first') },
              { t: 'bot', at: cue('l1', 'bot') },
              { t: 'wins.', at: cue('l1', 'wins') },
            ]}
          />
        </div>
      </div>

      {/* Lanes */}
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0 }}>
        <defs>
          <linearGradient id="laneFade" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor={C.lineStrong} stopOpacity="0" />
            <stop offset="0.12" stopColor={C.lineStrong} stopOpacity="1" />
          </linearGradient>
        </defs>
        {Array.from({ length: 8 }, (_, k) => {
          const d = prog(frame, CUT.s1 + 4 + k * 2, 30)
          return (
            <path
              key={k}
              d={lanePath(k)}
              fill="none"
              stroke={won && k === 3 ? C.neg : 'url(#laneFade)'}
              strokeOpacity={won && k === 3 ? 0.55 : 1}
              strokeWidth={2}
              pathLength={1}
              strokeDasharray={1}
              strokeDashoffset={1 - d}
            />
          )
        })}
      </svg>

      {/* The one slot */}
      <div
        style={{
          position: 'absolute', left: slot.x, top: slot.y, width: L.slotW, height: L.slotH, borderRadius: 20,
          border: `2.5px ${slotFill > 0 ? 'solid' : 'dashed'} ${slotFill > 0 ? C.ink : C.ink3}`,
          background: `rgba(11,10,18,${slotFill})`, display: 'grid', placeItems: 'center',
          opacity: prog(frame, CUT.s1 + 10, 14), transform: `scale(${1 + 0.06 * Math.sin(Math.PI * slotFill)})`,
        }}
      >
        <span style={{ fontFamily: MONO, fontSize: L.pill + 4, fontWeight: 600, letterSpacing: '0.16em', color: slotFill > 0.5 ? C.white : C.ink }}>LIQUIDATE</span>
      </div>
      <div style={{ position: 'absolute', left: slot.x, top: slot.y - 40, width: L.slotW, textAlign: 'center', fontFamily: MONO, fontSize: L.pill - 2, color: C.ink3, opacity: prog(frame, CUT.s1 + 16, 14) }}>
        one slot
      </div>

      {/* Bots */}
      {BOTS.map((b) => {
        const s = tStart + b.lag
        // Accelerating run; the losers are shut out and brake hard when the slot is taken.
        const run = interpolate(frame, [s, tWin], [0, 1], { ...CLAMP, easing: Easing.bezier(0.45, 0, 0.8, 0.6) })
        const brake = b.stop < 1 ? prog(frame, tWin, 14) : 0
        // Runs start a little way in, so every pill is fully on screen when it pops in.
        const base = mix(0.15, b.stop < 1 ? b.stop + 0.04 : 1, run)
        const p = b.stop < 1 ? Math.min(base, mix(base, b.stop, brake)) : base
        const pt = point(b.k, p)
        const ahead = point(b.k, Math.min(1, p + 0.01))
        const ang = (Math.atan2(ahead.y - pt.y, ahead.x - pt.x) * 180) / Math.PI
        const runPrev = interpolate(frame - 3, [s, tWin], [0, 1], { ...CLAMP, easing: Easing.bezier(0.45, 0, 0.8, 0.6) })
        const v = frame < tWin ? point(b.k, mix(0.15, 1, run)).x - point(b.k, mix(0.15, 1, runPrev)).x : 0
        const dock = b.stop === 1 ? pop(frame, tWin, { damping: 16, stiffness: 260 }) * 22 : 0
        const winner = b.stop === 1
        const isIn = winner && frame >= tWin
        const out = !winner && frame >= tWin
        const appear = pop(frame, s - 6)
        const h = L.pill * 2.3
        return (
          <div key={b.id} style={{ position: 'absolute', left: 0, top: 0, transform: `translate(${pt.x + dock}px, ${pt.y}px) rotate(${ang}deg)` }}>
            {/* speed trail */}
            <div style={{ position: 'absolute', right: 6, top: -h * 0.22, width: Math.min(260, Math.abs(v) * 7), height: h * 0.44, borderRadius: 99, background: `linear-gradient(90deg, rgba(229,72,77,0), rgba(229,72,77,${out ? 0 : 0.28}))` }} />
            <div
              style={{
                position: 'absolute', right: -14, top: -h / 2, height: h, display: 'flex', alignItems: 'center', gap: 10,
                padding: `0 ${L.pill * 0.9}px`, borderRadius: 999, whiteSpace: 'nowrap',
                background: isIn ? C.neg : C.white, border: `2px solid ${out ? C.line : isIn ? C.neg : C.negLine}`,
                boxShadow: out ? 'none' : '0 14px 30px -14px rgba(194,40,46,0.45)',
                fontFamily: MONO, fontSize: L.pill, fontWeight: 500, color: isIn ? C.white : out ? C.display2 : C.negText,
                opacity: appear * (out ? mix(1, 0.55, prog(frame, tWin + 4, 12)) : 1), transform: `scale(${0.6 + 0.4 * appear}) rotate(${-ang}deg)`, transformOrigin: 'right center',
              }}
            >
              <i style={{ width: L.pill * 0.45, height: L.pill * 0.45, borderRadius: 99, background: isIn ? C.white : out ? C.lineStrong : C.neg }} />
              {b.id}
              {out ? <span style={{ color: C.display2, marginLeft: 2 }}>✕</span> : null}
            </div>
          </div>
        )
      })}

      {/* Stamp */}
      {frame >= tStamp ? (
        <div
          style={{
            position: 'absolute', left: slot.x + L.slotW / 2, top: yc + L.slotH * 0.62, transform: `translate(-50%, -50%) rotate(-8deg) scale(${mix(2.1, 1, stampP)})`,
            opacity: Math.min(1, stampP * 2.5),
          }}
        >
          <div style={{ padding: 5, border: `4px solid ${C.neg}`, borderRadius: 14, background: 'rgba(255,255,255,0.92)' }}>
            <div style={{ padding: '8px 22px', border: `2px solid ${C.neg}`, borderRadius: 9, fontFamily: DISPLAY, fontWeight: 800, fontSize: L.pill * 2.1, letterSpacing: '0.04em', color: C.neg, whiteSpace: 'nowrap' }}>
              FIXED FEE
            </div>
          </div>
        </div>
      ) : null}
    </AbsoluteFill>
  )
}
