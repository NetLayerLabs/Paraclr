import React from 'react'
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { CUT, LINE_START, type LineId, cue, sec, speaking } from './timing'
import { C } from './ui'
import { S1Race } from './S1Race'
import { S2Gas } from './S2Gas'
import { S3Auction } from './S3Auction'
import { S4Lanes } from './S4Lanes'
import { Iris, S5End } from './S5End'

/**
 * Paraclr — 15 s "coming soon" teaser. Five chapters, each cut just ahead of the VO line
 * that carries it: white (the bot race), black (the gas war), white + purple (the
 * auction), purple (every block), black (end card). Works at 1920x1080 and 1080x1080;
 * the square version is recomposed per scene, not cropped.
 */

const VO_VOL = 1.0
// The music bed's swell lands at 13.9 s of the file; starting 1.15 s in puts it on the end-card cut.
const BED_OFFSET = 1.15

const S3_IRIS = 16
const S4_WIPE = 30
const S5_IRIS = 18

const Mix: React.FC = () => {
  // Music ducks under the voice, smoothed over a few frames either side.
  const bedVol = (f: number) => {
    let sp = 0
    for (let d = -8; d <= 8; d++) sp += speaking(f + d) ? 1 : 0
    const duck = sp / 17
    const fadeIn = Math.min(1, f / 10)
    return fadeIn * (0.3 - 0.19 * duck)
  }
  const ticks = [cue('l3', 'auctions'), cue('l3', 'block', 0), cue('l3', 'block', 1)]
  return (
    <>
      <Audio src={staticFile('sfx/bed.mp3')} trimBefore={sec(BED_OFFSET)} volume={bedVol} />
      {(Object.keys(LINE_START) as LineId[]).map((id) => (
        <Sequence key={id} from={sec(LINE_START[id])} layout="none">
          <Audio src={staticFile(`vo/${id}.mp3`)} volume={VO_VOL} />
        </Sequence>
      ))}
      <Sequence from={cue('l1', 'wins') + 1} layout="none">
        <Audio src={staticFile('sfx/stamp.mp3')} volume={0.9} />
      </Sequence>
      <Sequence from={CUT.s3 - 6} layout="none">
        <Audio src={staticFile('sfx/whoosh.mp3')} volume={0.22} />
      </Sequence>
      {ticks.map((t) => (
        <Sequence key={t} from={t} layout="none">
          <Audio src={staticFile('sfx/tick.mp3')} volume={0.75} />
        </Sequence>
      ))}
      <Sequence from={CUT.s4 - 4} layout="none">
        <Audio src={staticFile('sfx/whoosh.mp3')} volume={0.2} />
      </Sequence>
      <Sequence from={CUT.s5} layout="none">
        <Audio src={staticFile('sfx/impact.mp3')} volume={0.16} />
      </Sequence>
    </>
  )
}

export const Teaser: React.FC = () => {
  const frame = useCurrentFrame()
  const { width, height } = useVideoConfig()
  const sq = width === height
  return (
    <AbsoluteFill style={{ background: C.white }}>
      {frame < CUT.s2 ? <S1Race frame={frame} sq={sq} /> : null}
      {frame >= CUT.s2 && frame < CUT.s3 + S3_IRIS ? <S2Gas frame={frame} sq={sq} /> : null}
      {frame >= CUT.s3 && frame < CUT.s4 + S4_WIPE ? (
        <Iris frame={frame} start={CUT.s3} dur={S3_IRIS} width={width} height={height} color={C.white} ring={C.lane} cx={sq ? width / 2 : width * 0.7} cy={height * 0.55}>
          <S3Auction frame={frame} sq={sq} />
        </Iris>
      ) : null}
      {frame >= CUT.s4 && frame < CUT.s5 + S5_IRIS ? <S4Lanes frame={frame} sq={sq} width={width} height={height} /> : null}
      {frame >= CUT.s5 ? (
        <Iris frame={frame} start={CUT.s5} dur={S5_IRIS} width={width} height={height} color={C.black} ring="#FFFFFF">
          <S5End frame={frame} sq={sq} width={width} height={height} />
        </Iris>
      ) : null}
      <Mix />
    </AbsoluteFill>
  )
}

/** Thumbnail: the auction board mid-split, the frame that explains the product. */
export const Thumb: React.FC = () => {
  const { width, height } = useVideoConfig()
  const at = cue('l3', 'taker') + 30
  return (
    <AbsoluteFill style={{ background: C.white }}>
      <Iris frame={at} start={CUT.s3} dur={S3_IRIS} width={width} height={height} color={C.white} ring={C.lane}>
        <S3Auction frame={at} />
      </Iris>
    </AbsoluteFill>
  )
}
