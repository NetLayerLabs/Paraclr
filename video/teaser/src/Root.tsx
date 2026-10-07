import React from 'react'
import { Composition } from 'remotion'
import { DURATION, FPS } from './timing'
import { Teaser, Thumb } from './Teaser'

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="Teaser" component={Teaser} durationInFrames={DURATION} fps={FPS} width={1920} height={1080} />
    <Composition id="TeaserSquare" component={Teaser} durationInFrames={DURATION} fps={FPS} width={1080} height={1080} />
    <Composition id="Thumb" component={Thumb} durationInFrames={1} fps={FPS} width={1920} height={1080} />
  </>
)
