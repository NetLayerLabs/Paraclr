import React from "react";
import { Composition, Still } from "remotion";
import { Film } from "./Film";
import { Poster } from "./Poster";
import { T } from "./timing";
import { Talk, TALK_FRAMES } from "./pitch/Talk";
import { Thumb } from "./pitch/Thumb";

export const Root: React.FC = () => (
  <>
    {/* The pitch as recorded on camera (the one we ship). hi=true reads the 4K intermediate. */}
    <Composition id="Pitch" component={Talk} durationInFrames={TALK_FRAMES} fps={30} width={1920} height={1080} defaultProps={{ hi: false }} />
    <Still id="Thumb" component={Thumb} width={1920} height={1080} defaultProps={{ hi: false }} />
    {/* Phase 1: the voice-only kinetic film, kept for reference. */}
    <Composition id="VoiceFilm" component={Film} durationInFrames={T.totalFrames} fps={T.fps} width={1920} height={1080} />
    <Still id="Poster" component={Poster} width={1920} height={1080} />
  </>
);
