import React from "react";
import { Composition, Still } from "remotion";
import { Film } from "./Film";
import { Poster } from "./Poster";
import { T } from "./timing";
import { TechDemo, TT } from "./TechDemo";

export const Root: React.FC = () => (
  <>
    <Composition id="Paraclr" component={Film} durationInFrames={T.totalFrames} fps={T.fps} width={1920} height={1080} />
    <Composition id="TechDemo" component={TechDemo} durationInFrames={TT.totalFrames} fps={TT.fps} width={1920} height={1080} />
    <Still id="Poster" component={Poster} width={1920} height={1080} />
    <Still id="PosterTech" component={() => <Poster label="TECHNICAL DEMO · MONAD METROPOLIS · LIVE ON MONAD TESTNET · TEST FUNDS" />} width={1920} height={1080} />
  </>
);
