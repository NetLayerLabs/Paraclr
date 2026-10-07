import React from 'react'
import { AbsoluteFill, interpolate } from 'remotion'
import { CUT, cue } from './timing'
import { Accent, C, CLAMP, Chip, Chrome, Corners, DISPLAY, MONO, Word, mix, pop, prog } from './ui'

/**
 * 02 — black. "A fixed fee, decided by gas." The trader's equity bar loses a fixed
 * chunk on "fee"; in the mempool card the priority fee spikes red and the bots' bids
 * stack up, one outbidding the next, until "gas" lands.
 */

type Layout = {
  hx: number; hy: number; hs: number; as: number; lines: string[][]
  bar: { x: number; y: number; w: number; h: number }
  card: { x: number; y: number; w: number; h: number }
  corner: number; cornerSize: number; u: number
}
const WIDE: Layout = {
  hx: 120, hy: 196, hs: 104, as: 150, lines: [['A', 'fixed', 'fee,'], ['decided', 'by']],
  bar: { x: 120, y: 700, w: 800, h: 64 },
  card: { x: 1060, y: 176, w: 740, h: 700 },
  corner: 48, cornerSize: 21, u: 1,
}
const SQUARE: Layout = {
  hx: 80, hy: 130, hs: 76, as: 112, lines: [['A', 'fixed', 'fee,'], ['decided', 'by']],
  bar: { x: 80, y: 930, w: 920, h: 44 },
  card: { x: 80, y: 420, w: 920, h: 450 },
  corner: 40, cornerSize: 19, u: 0.86,
}

const BIDS = [
  { id: 'bot 0x3f', w: 0.42, at: () => cue('l2', 'whoever') },
  { id: 'bot 0x9c', w: 0.64, at: () => cue('l2', 'pays') },
  { id: 'bot 0xa1', w: 0.9, at: () => cue('l2', 'most') },
]

// The priority-fee trace: calm, a few nervous steps, then the spike. Schematic, no units.
const TRACE = [0.12, 0.13, 0.12, 0.15, 0.14, 0.16, 0.15, 0.19, 0.18, 0.24, 0.22, 0.31, 0.29, 0.42, 0.4, 0.58, 0.55, 0.8, 0.97]

export const S2Gas: React.FC<{ frame: number; sq?: boolean }> = ({ frame, sq }) => {
  const L = sq ? SQUARE : WIDE
  const u = L.u
  const t0 = CUT.s2
  const tFee = cue('l2', 'fee,')
  const tDecided = cue('l2', 'decided')
  const tGas = cue('l2', 'gas.')

  // Equity bar
  const barIn = prog(frame, t0 + 2, 18)
  const chop = prog(frame, tFee, 10)
  const fall = prog(frame, tFee + 10, 50)
  const keepW = 0.66

  // Card
  const cardIn = pop(frame, t0 + 3, { damping: 15, stiffness: 160 })
  const pad = 34 * u
  const chartW = L.card.w - pad * 2
  const chartH = (sq ? 150 : 250) * u
  const draw = interpolate(frame, [tDecided - 10, tGas + 2], [0, 1], { ...CLAMP })
  const n = TRACE.length - 1
  const pts = TRACE.map((v, i) => [(i / n) * chartW, chartH - v * chartH * 0.92] as const)
  const head = draw * n
  const shown = pts.filter((_, i) => i <= Math.floor(head))
  const fi = Math.floor(head), fr = head - fi
  const tip = fi < n ? [mix(pts[fi][0], pts[fi + 1][0], fr), mix(pts[fi][1], pts[fi + 1][1], fr)] : pts[n]
  const linePts = [...shown, tip].map((p) => p.join(',')).join(' ')
  const hot = interpolate(draw, [0.55, 1], [0, 1], CLAMP)
  const spike = pop(frame, tGas, { damping: 9, stiffness: 260 })

  return (
    <AbsoluteFill style={{ background: C.black }}>
      <Corners frame={frame} n="02" label="gas war" tone="dark" pad={L.corner} size={L.cornerSize} />

      {/* Headline */}
      <div style={{ position: 'absolute', left: L.hx, top: L.hy, fontFamily: DISPLAY, fontWeight: 800, fontSize: L.hs, letterSpacing: '-0.045em', lineHeight: 1.04, color: C.dInk }}>
        {L.lines.map((line, i) => (
          <div key={i}>
            {line.map((w, j) => (
              <React.Fragment key={w}>
                {j > 0 ? ' ' : null}
                <Word frame={frame} at={cue('l2', w)}>{w}</Word>
              </React.Fragment>
            ))}
            {i === L.lines.length - 1 ? (
              <>
                {' '}
                <Accent frame={frame} color={C.negDark} size={L.as} underline={tGas + 10} words={[{ t: 'gas.', at: tGas }]} style={{ marginLeft: 6 }} />
              </>
            ) : null}
          </div>
        ))}
      </div>

      {/* Trader equity: a fixed chunk goes, whoever wins the race */}
      <div style={{ position: 'absolute', left: L.bar.x, top: L.bar.y - 46 * u, width: L.bar.w, display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 20 * u, color: C.dInk3, opacity: barIn }}>
        <span>your equity</span>
        <span style={{ color: C.negDark, opacity: chop }}>− fixed fee → first bot</span>
      </div>
      <div style={{ position: 'absolute', left: L.bar.x, top: L.bar.y, width: L.bar.w, height: L.bar.h }}>
        <div style={{ position: 'absolute', inset: 0, borderRadius: 16 * u, boxShadow: 'inset 0 0 0 1.5px rgba(255,255,255,0.10)', opacity: barIn }} />
        <div
          style={{
            position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(chop > 0 ? keepW : 1) * 100 * barIn}%`, borderRadius: 16 * u,
            background: C.posDark, transform: `scaleX(${chop > 0 ? 1 : 1})`, transition: 'none',
          }}
        />
        {chop > 0 ? (
          <div
            style={{
              position: 'absolute', left: `${keepW * 100}%`, top: 0, bottom: 0, width: `${(1 - keepW) * 100}%`, borderRadius: 16 * u,
              background: mix(0, 1, chop) > 0.5 ? C.negDark : C.posDark,
              transform: `translate(${chop * 14 + fall * 120}px, ${fall * fall * 220}px) rotate(${fall * 14}deg)`,
              opacity: 1 - fall,
            }}
          />
        ) : null}
        {/* the cut line */}
        <div style={{ position: 'absolute', left: `calc(${keepW * 100}% - 2px)`, top: -14, bottom: -14, width: 4, borderRadius: 4, background: C.dInk, opacity: chop * (1 - prog(frame, tFee + 8, 10)) }} />
      </div>

      {/* Mempool card */}
      <div
        style={{
          position: 'absolute', left: L.card.x, top: L.card.y, width: L.card.w, height: L.card.h, borderRadius: 28 * u,
          background: C.dSurface, border: `1px solid ${C.dLine}`, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 60px 120px -40px rgba(0,0,0,0.9)',
          opacity: Math.min(1, cardIn * 1.4), transform: `translateY(${(1 - cardIn) * 60}px) scale(${mix(0.94, 1, cardIn)})`, overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 * u, padding: `${24 * u}px ${pad}px ${18 * u}px`, borderBottom: `1px solid ${C.dLine}` }}>
          <Chrome dark size={12 * u} />
          <span style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 26 * u, letterSpacing: '-0.025em', color: C.dInk }}>Mempool</span>
          <span style={{ marginLeft: 'auto' }}>
            <Chip tone="dneg" size={18 * u} dot={C.negDark}>gas war</Chip>
          </span>
        </div>

        <div style={{ padding: `${22 * u}px ${pad}px 0`, fontFamily: MONO, fontSize: 17 * u, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.dInk3, display: 'flex', justifyContent: 'space-between' }}>
          <span>priority fee</span>
          <span style={{ color: C.negDark, opacity: hot, letterSpacing: '0.04em' }}>▲ spiking</span>
        </div>
        <svg width={chartW} height={chartH + 20} style={{ display: 'block', margin: `${12 * u}px ${pad}px 0`, overflow: 'visible' }}>
          <defs>
            <linearGradient id="gasArea" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={C.negDark} stopOpacity={0.35 * hot + 0.05} />
              <stop offset="1" stopColor={C.negDark} stopOpacity="0" />
            </linearGradient>
            <linearGradient id="gasLine" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stopColor={C.dInk3} />
              <stop offset="0.55" stopColor={C.dInk3} />
              <stop offset="0.8" stopColor={C.negDark} />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75, 1].map((g) => (
            <line key={g} x1={0} x2={chartW} y1={chartH * g} y2={chartH * g} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
          ))}
          {draw > 0 ? (
            <>
              <polygon points={`0,${chartH} ${linePts} ${tip[0]},${chartH}`} fill="url(#gasArea)" />
              <polyline points={linePts} fill="none" stroke="url(#gasLine)" strokeWidth={4 * u} strokeLinejoin="round" strokeLinecap="round" />
              <circle cx={tip[0]} cy={tip[1]} r={8 * u} fill={hot > 0.5 ? C.negDark : C.dInk2} />
              {frame >= tGas ? <circle cx={tip[0]} cy={tip[1]} r={8 * u + spike * 26 * u} fill="none" stroke={C.negDark} strokeWidth={2.5} opacity={1 - prog(frame, tGas, 30)} /> : null}
            </>
          ) : null}
        </svg>

        <div style={{ padding: `${(sq ? 18 : 30) * u}px ${pad}px ${12 * u}px`, fontFamily: MONO, fontSize: 17 * u, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.dInk3 }}>
          priority bids
        </div>
        <div style={{ position: 'relative', margin: `0 ${pad}px`, height: (sq ? 3 * 50 : 3 * 66) * u }}>
          {BIDS.map((b, i) => {
            const at = b.at()
            const inP = pop(frame, at, { damping: 15, stiffness: 220 })
            // Newest bid on top: each later bid pushes this row down one slot.
            const below = BIDS.slice(i + 1).reduce((acc, nb) => acc + pop(frame, nb.at(), { damping: 16, stiffness: 200 }), 0)
            const outbid = BIDS.slice(i + 1).some((nb) => frame >= nb.at())
            const rowH = (sq ? 50 : 66) * u
            return (
              <div
                key={b.id}
                style={{
                  position: 'absolute', left: 0, right: 0, top: below * rowH, height: rowH - 12 * u, display: 'grid',
                  gridTemplateColumns: `${150 * u}px 1fr ${120 * u}px`, alignItems: 'center', gap: 16 * u,
                  padding: `0 ${16 * u}px`, borderRadius: 14 * u, background: outbid ? 'rgba(255,255,255,0.02)' : 'rgba(255,92,122,0.08)',
                  border: `1px solid ${outbid ? C.dLine : 'rgba(255,92,122,0.35)'}`,
                  opacity: inP * (outbid ? 0.55 : 1), transform: `translateX(${(1 - inP) * 80}px)`,
                  fontFamily: MONO, fontSize: 19 * u, color: outbid ? C.dInk3 : C.dInk,
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 10 * u }}>
                  <i style={{ width: 9 * u, height: 9 * u, borderRadius: 9, background: outbid ? C.dInk3 : C.negDark }} />
                  {b.id}
                </span>
                <span style={{ height: 10 * u, borderRadius: 10, background: 'rgba(255,255,255,0.06)', position: 'relative', overflow: 'hidden' }}>
                  <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${b.w * 100 * prog(frame, at + 2, 16)}%`, borderRadius: 10, background: outbid ? C.dInk3 : C.negDark }} />
                </span>
                <span style={{ textAlign: 'right', fontSize: 16 * u, color: outbid ? C.dInk3 : C.negDark }}>{outbid ? 'outbid' : 'top bid'}</span>
              </div>
            )
          })}
        </div>
      </div>
    </AbsoluteFill>
  )
}
