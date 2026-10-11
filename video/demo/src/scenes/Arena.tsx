import React from "react";
import { AbsoluteFill, Freeze, interpolate } from "remotion";
import { C, mono, sora } from "../theme";
import { useScene } from "../ui/use";
import { Browser, markOf } from "../ui/Browser";
import { Label } from "../ui/Label";
import { clamp, expo, pop, ramp } from "../ui/motion";

const MaybeFreeze: React.FC<{ at: number; children: React.ReactNode }> = ({ at, children }) => {
  const { f } = useScene("arena");
  return f > at ? <Freeze frame={at}>{children}</Freeze> : <>{children}</>;
};

/** One real press of "Crash the market" on paraclr.xyz/arena: eight lanes clear on their own. */
export const Arena: React.FC = () => {
  const { f, rel } = useScene("arena");
  const START = 20; // clip frame shown at scene frame 0
  const press = markOf("arena2", "a2_press") - START;
  const lanesAt = markOf("arena2", "a2_lanes") - START;
  const take = markOf("arena2", "a2_take") - START;
  // hold on the cleared lanes: the recording scrolls on to the run's tally after this
  const hold = markOf("arena2", "a2_cleared") - START + 90;
  // the crash panel only (button, status, limits): the headline to its left stays out of frame
  const panel = { x: 1000, y: 200, w: 480, h: 230 };
  const stamp = Math.min(1, pop(f, rel("twenty") - 2));
  const W = 1400, L = 260, TOP = 112;
  return (
    <AbsoluteFill style={{ background: C.night, fontFamily: sora }}>
      <AbsoluteFill style={{ background: "radial-gradient(60% 50% at 70% 0%, rgba(255,92,122,0.10), transparent 70%)" }} />
      <Label color={C.dInk3} dot={C.negDark} style={{ position: "absolute", left: L, top: TOP - 40 }}>
        paraclr.xyz/arena · one real press · demo stack on Monad testnet · synthetic accounts · each lane: its own auction, pool, ledger
      </Label>
      <MaybeFreeze at={hold}>
      <Browser name="arena2" url="paraclr.xyz/arena" width={W} left={L} top={TOP} startFrom={START}
        {...(f < lanesAt ? { focus: panel, zoom: 2.2, focusAt: [press - 50, press - 20] as [number, number], unfocusAt: [press + 22, press + 46] as [number, number] }
          : { focus: { x: 128, y: 66, w: 1344, h: 566 }, zoom: 1.16, spotlight: true, focusAt: [lanesAt + 20, lanesAt + 50] as [number, number] })} />
      </MaybeFreeze>
      <div style={{ position: "absolute", right: 1920 - L - W - 30, top: TOP + 120, opacity: stamp * (1 - ramp(f, lanesAt - 10, lanesAt + 4)),
        transform: `rotate(-5deg) scale(${1.6 - 0.6 * stamp})`, fontFamily: sora, fontWeight: 800, fontSize: 120, letterSpacing: "-0.05em", color: C.negDark,
        textShadow: "0 10px 40px rgba(0,0,0,0.6)" }}>−20%</div>
    </AbsoluteFill>
  );
};
