import React from 'react'
import { AbsoluteFill, interpolate } from 'remotion'
import { CUT, cue } from './timing'
import { Accent, C, CLAMP, Chip, Chrome, Corners, DISPLAY, MONO, SANS, Word, mix, pop, prog } from './ui'

/**
 * 03 — white, purple accents. "Paraclr auctions it, block by block." The landing page's
 * auction board, schematic: the block clock steps +0 → +3 while the discount ticks
 * 0 → 25 → 50 → 75 bps, "backstop ✓" lands at 75, and the equity bar splits into
 * P (purple, the taker) and E − P (green, what you keep).
 */

type Layout = {
  hx: number; hy: number; hs: number; as: number; lines: string[][]
  card: { x: number; y: number; w: number }
  u: number; corner: number; cornerSize: number; rows: number
}
const WIDE: Layout = {
  hx: 120, hy: 236, hs: 100, as: 132, lines: [['Paraclr'], ['auctions', 'it,']],
  card: { x: 1010, y: 128, w: 790 }, u: 1, corner: 48, cornerSize: 21, rows: 8,
}
const SQUARE: Layout = {
  hx: 80, hy: 120, hs: 76, as: 104, lines: [['Paraclr', 'auctions', 'it,']],
  card: { x: 140, y: 400, w: 800 }, u: 0.78, corner: 40, cornerSize: 19, rows: 4,
}

const STEP_BPS = 25
const ACTIVE = 3 // the lane whose position is in auction

export const S3Auction: React.FC<{ frame: number; sq?: boolean }> = ({ frame, sq }) => {
  const L = sq ? SQUARE : WIDE
  const u = L.u
  const t0 = CUT.s3
  const steps = [cue('l3', 'auctions'), cue('l3', 'block', 0), cue('l3', 'block', 1)]
  const k = steps.filter((s) => frame >= s).length // 0..3
  const tBackstop = steps[2] + 12
  const tKeep = cue('l3', 'keep')
  const tTaker = cue('l3', 'taker')
  const tPaid = cue('l3', 'paid.')

  const cardIn = pop(frame, t0 + 6, { damping: 16, stiffness: 150 })
  const tilt = interpolate(frame, [t0, CUT.s4], [-9, -4], CLAMP)
  const pad = 32 * u

  // A rolling digit: the previous value slides up and out as the new one lands.
  const Roll: React.FC<{ values: string[]; color: string; size: number; minW: number }> = ({ values, color, size, minW }) => (
    <span style={{ position: 'relative', display: 'inline-block', height: size * 1.1, minWidth: minW, overflow: 'hidden', verticalAlign: 'bottom' }}>
      {values.map((v, i) => {
        const pin = i === 0 ? 1 : prog(frame, steps[i - 1], 12)
        const pout = i < values.length - 1 && i < 3 ? prog(frame, steps[i], 12) : 0
        if (pin <= 0 || pout >= 1) return null
        return (
          <span key={i} style={{ position: 'absolute', left: 0, bottom: 0, fontFamily: MONO, fontWeight: 600, fontSize: size, lineHeight: 1.1, color, fontVariantNumeric: 'tabular-nums', transform: `translateY(${(1 - pin) * 100 - pout * 100}%)`, opacity: Math.min(pin, 1 - pout) }}>
            {v}
          </span>
        )
      })}
    </span>
  )

  const split = prog(frame, tKeep - 4, 18)
  const P = 0.16 // schematic share, wide enough to read; no figure is implied
  const keepChip = pop(frame, tKeep + 2, { damping: 11, stiffness: 240 })
  const takerChip = pop(frame, tTaker, { damping: 13, stiffness: 240 })
  const backstop = pop(frame, tBackstop, { damping: 10, stiffness: 260 })
  const floatChip = pop(frame, steps[0] + 4, { damping: 14, stiffness: 200 })
  const paid = prog(frame, tPaid, 14)

  const rows = Array.from({ length: L.rows }, (_, i) => (sq ? i + 2 : i))

  return (
    <AbsoluteFill style={{ background: C.white }}>
      <Corners frame={frame} n="03" label="the auction" pad={L.corner} size={L.cornerSize} />

      {/* Headline */}
      <div style={{ position: 'absolute', left: L.hx, top: L.hy, fontFamily: DISPLAY, fontWeight: 800, fontSize: L.hs, letterSpacing: '-0.045em', lineHeight: 1.04, color: C.ink }}>
        {L.lines.map((line, i) => (
          <div key={i}>
            {line.map((w, j) => (
              <React.Fragment key={w}>
                {j > 0 ? ' ' : null}
                <Word frame={frame} at={cue('l3', w === 'Paraclr' ? 'Paraclear' : w)}>{w}</Word>
              </React.Fragment>
            ))}
          </div>
        ))}
        <div style={{ marginTop: L.hs * 0.06 }}>
          <Accent
            frame={frame}
            color={C.purple}
            size={L.as}
            underline={steps[2] + 8}
            words={[
              { t: 'block', at: cue('l3', 'block', 0) },
              { t: 'by', at: cue('l3', 'by') },
              { t: 'block.', at: cue('l3', 'block', 1) },
            ]}
          />
        </div>
        {!sq ? (
          <div style={{ marginTop: 44, display: 'flex', alignItems: 'center', gap: 16, fontFamily: SANS, fontWeight: 500, fontSize: 30, letterSpacing: '-0.01em', color: C.ink2, opacity: prog(frame, tKeep, 14), transform: `translateY(${(1 - prog(frame, tKeep, 14)) * 16}px)` }}>
            You keep <b style={{ fontFamily: MONO, fontWeight: 600, color: C.posText }}>E − P</b>
            <span style={{ color: C.display2, fontWeight: 400 }}>· the taker gets</span>
            <b style={{ fontFamily: MONO, fontWeight: 600, color: C.purpleText, opacity: prog(frame, tTaker, 12) }}>P</b>
          </div>
        ) : null}
      </div>

      {/* Auction board */}
      <div style={{ position: 'absolute', left: L.card.x, top: L.card.y, width: L.card.w, perspective: 1800 }}>
        <div
          style={{
            position: 'relative', borderRadius: 28 * u, background: C.white, border: `1.5px solid ${C.line}`,
            boxShadow: '0 48px 90px -30px rgba(26,18,74,0.34), 0 16px 32px -16px rgba(26,18,74,0.16)',
            transform: `translateY(${(1 - cardIn) * 80}px) rotateY(${tilt}deg) rotateX(3deg) rotateZ(${sq ? 0 : 1.2}deg) scale(${mix(0.92, 1, cardIn)})`,
            transformOrigin: '70% 50%', opacity: Math.min(1, cardIn * 1.5), paddingBottom: pad,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 * u, padding: `${22 * u}px ${pad}px`, borderBottom: `1.5px solid ${C.line}` }}>
            <Chrome size={12 * u} />
            <span style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 27 * u, letterSpacing: '-0.025em', color: C.ink }}>Auction board</span>
            <span style={{ marginLeft: 'auto' }}>
              <Chip size={17 * u}>schematic</Chip>
            </span>
          </div>

          {/* Block clock */}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 18 * u, margin: `${24 * u}px ${pad}px ${18 * u}px`, padding: `${18 * u}px ${24 * u}px`, borderRadius: 20 * u, background: C.subtle, border: `1.5px solid ${C.line}` }}>
            <div style={{ display: 'grid', gap: 6 * u }}>
              <span style={{ fontFamily: MONO, fontSize: 16 * u, letterSpacing: '0.12em', color: C.ink3 }}>BLOCK</span>
              <Roll values={['+0', '+1', '+2', '+3']} color={C.ink} size={64 * u} minW={110 * u} />
            </div>
            <div style={{ width: 1.5, alignSelf: 'stretch', background: C.line, margin: `0 ${10 * u}px` }} />
            <div style={{ display: 'grid', gap: 6 * u }}>
              <span style={{ fontFamily: MONO, fontSize: 16 * u, letterSpacing: '0.12em', color: C.ink3 }}>DISCOUNT</span>
              <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 10 * u }}>
                <Roll values={['0', '25', '50', '75']} color={C.purpleText} size={64 * u} minW={80 * u} />
                <span style={{ fontFamily: MONO, fontSize: 26 * u, color: C.ink3, paddingBottom: 10 * u }}>bps</span>
              </span>
            </div>
            <span style={{ marginLeft: 'auto', alignSelf: 'center' }}>
              <span style={{ display: 'inline-flex', gap: 7 * u }}>
                {[1, 2, 3].map((i) => (
                  <i key={i} style={{ width: 16 * u, height: 16 * u, borderRadius: 5 * u, background: k >= i ? C.purple : C.lineStrong, transform: `scale(${1 + 0.35 * Math.sin(Math.PI * prog(frame, steps[i - 1], 10))})` }} />
                ))}
              </span>
            </span>
          </div>

          {/* Lanes */}
          <div style={{ display: 'grid', gap: 12 * u, padding: `${4 * u}px ${pad}px ${8 * u}px` }}>
            {rows.map((lane) => {
              const active = lane === ACTIVE
              const fill = active ? interpolate(frame, [steps[0] - 30, steps[0], steps[1], steps[2]], [0, 1 / 3, 2 / 3, 1], CLAMP) : 0
              const rowIn = prog(frame, t0 + 14 + lane * 2, 16)
              return (
                <div key={lane} style={{ display: 'grid', gridTemplateColumns: `${40 * u}px 1fr ${190 * u}px`, alignItems: 'center', gap: 16 * u, height: 30 * u, opacity: rowIn }}>
                  <span style={{ fontFamily: MONO, fontSize: 18 * u, color: active ? C.ink : C.ink3, fontWeight: active ? 600 : 400 }}>L{lane}</span>
                  <span style={{ position: 'relative', height: 13 * u, borderRadius: 99, background: C.subtle, boxShadow: `inset 0 0 0 1.5px ${C.line}`, overflow: 'hidden' }}>
                    <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${fill * 100}%`, borderRadius: 99, background: C.purple }} />
                  </span>
                  <span style={{ position: 'relative', height: 30 * u }}>
                    {active ? (
                      <>
                        <span style={{ position: 'absolute', left: 0, top: 0, opacity: 1 - prog(frame, tBackstop - 2, 6) }}>
                          <Chip tone="warn" size={16 * u} dot="#F59E0B">auction</Chip>
                        </span>
                        <span style={{ position: 'absolute', left: 0, top: 0, opacity: Math.min(1, backstop * 2), transform: `translateY(${(1 - backstop) * -26}px) scale(${mix(1.3, 1, backstop)})`, transformOrigin: 'left center' }}>
                          <Chip tone="accent" size={16 * u}>backstop ✓</Chip>
                        </span>
                      </>
                    ) : (
                      <span style={{ fontFamily: MONO, fontSize: 16 * u, color: C.display2, lineHeight: `${30 * u}px` }}>healthy</span>
                    )}
                  </span>
                </div>
              )
            })}
          </div>

          {/* Equity split */}
          <div style={{ margin: `${18 * u}px ${pad}px 0`, paddingTop: 22 * u, borderTop: `1.5px solid ${C.line}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 17 * u, letterSpacing: '0.12em', color: C.ink3, marginBottom: 14 * u }}>
              <span>POSITION EQUITY · E</span>
              <span style={{ opacity: split, letterSpacing: '0.04em' }}>L{ACTIVE}</span>
            </div>
            <div style={{ position: 'relative', height: 54 * u }}>
              {/* E − P: what the trader keeps */}
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${mix(100, (1 - P) * 100, split)}%`, borderRadius: 14 * u, background: split > 0 ? C.pos : C.lineStrong, display: 'flex', alignItems: 'center', paddingLeft: 20 * u, overflow: 'hidden' }}>
                <span style={{ fontFamily: MONO, fontWeight: 600, fontSize: 22 * u, color: C.white, opacity: split }}>E − P</span>
              </div>
              {/* P: the taker's discount */}
              <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: `calc(${P * 100 * split}% - ${6 * u * split}px)`, borderRadius: 14 * u, background: C.purple, display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
                <span style={{ fontFamily: MONO, fontWeight: 600, fontSize: 22 * u, color: C.white, opacity: prog(frame, tKeep + 8, 10) }}>P</span>
              </div>
            </div>
            <div style={{ position: 'relative', height: 50 * u, marginTop: 14 * u }}>
              <span style={{ position: 'absolute', left: 0, top: 0, opacity: Math.min(1, keepChip * 2), transform: `translateY(${(1 - keepChip) * 18}px) scale(${mix(0.7, 1, keepChip)})`, transformOrigin: 'left top' }}>
                <Chip tone="pos" size={19 * u} dot={C.pos} style={{ fontWeight: 600, boxShadow: paid > 0 ? `0 0 0 ${paid * 6 * (1 - paid) * 4}px rgba(14,159,110,0.12)` : 'none' }}>you keep · E − P</Chip>
              </span>
              <span style={{ position: 'absolute', right: 0, top: 0, opacity: Math.min(1, takerChip * 2), transform: `translateY(${(1 - takerChip) * 18}px) scale(${mix(0.7, 1, takerChip)})`, transformOrigin: 'right top' }}>
                <Chip tone="accent" size={19 * u}>P · taker</Chip>
              </span>
            </div>
          </div>

          {/* Floating chip, like the hero's */}
          <span style={{ position: 'absolute', right: 150 * u, top: -24 * u, opacity: Math.min(1, floatChip * 2), transform: `translateY(${(1 - floatChip) * 20 + Math.sin(frame / 24) * 4}px)` }}>
            <span style={{ display: 'inline-flex', padding: `${10 * u}px ${18 * u}px`, borderRadius: 999, background: C.ink, color: C.white, fontFamily: MONO, fontSize: 19 * u, fontWeight: 500, boxShadow: '0 16px 36px -16px rgba(26,18,74,0.5)' }}>
              +{STEP_BPS} bps / block
            </span>
          </span>
        </div>
      </div>
    </AbsoluteFill>
  )
}
