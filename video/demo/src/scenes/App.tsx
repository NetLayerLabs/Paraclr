import React from "react";
import { AbsoluteFill, Sequence, interpolate } from "remotion";
import { C, mono, sora } from "../theme";
import { useScene } from "../ui/use";
import { Browser, Mask } from "../ui/Browser";
import { Partner } from "../ui/Brand";
import { Lanes } from "../ui/Lanes";
import { clamp, expo, pop, ramp } from "../ui/motion";

// Sign-in privacy: the email (in the input and on the code screen) and the one-time code are covered
// in every frame they could appear, on top of the in-page blur applied while recording.
const EMAIL_INPUT: Mask = { x: 690, y: 378, w: 262, h: 54 };
const EMAIL_LINE: Mask = { x: 745, y: 381, w: 172, h: 34 };
const CODE: Mask = { x: 650, y: 474, w: 300, h: 64 };

const W = 1400, L = 260, TOP = 112;

/** A partner chip that pops in over the footage when that partner is on screen. */
const Chip: React.FC<{ id: string; name: string; role: string; at: number; until: number }> = ({ id, name, role, at, until }) => {
  const { f } = useScene("app");
  const p = Math.min(1, pop(f, at));
  const o = interpolate(f, [until - 10, until], [1, 0], clamp);
  if (f < at - 1 || f > until) return null;
  return (
    <div style={{ position: "absolute", right: 1920 - L - W + 24, top: TOP + 64, display: "flex", alignItems: "center", gap: 14, padding: "12px 20px 12px 14px", borderRadius: 16,
      background: "rgba(17,16,25,0.86)", border: "1px solid rgba(255,255,255,0.14)", boxShadow: "0 20px 50px rgba(0,0,0,0.5)", backdropFilter: "blur(16px)",
      opacity: p * o, transform: `translateY(${(1 - p) * -16}px) scale(${0.92 + 0.08 * p})` }}>
      <div style={{ width: 46, height: 46, borderRadius: 12, background: "#1C1A27", display: "flex", alignItems: "center", justifyContent: "center" }}><Partner id={id} size={30} /></div>
      <div>
        <div style={{ fontFamily: sora, fontSize: 22, fontWeight: 700, color: C.dInk, letterSpacing: "-0.02em" }}>{name}</div>
        <div style={{ fontFamily: mono, fontSize: 13, color: C.dInk3, letterSpacing: "0.05em" }}>{role}</div>
      </div>
    </div>
  );
};

/** Live on Monad testnet: Privy sign-in, gas drip, Agora's faucet, a SOL long filled at the next Pyth price. */
export const App: React.FC = () => {
  const { f, rel, dur } = useScene("app");
  // cut points (scene frames) and where each clip is cued from (clip frames)
  const c1 = rel("by") - 6;            // modal open -> typing the (masked) email
  const c2 = rel("No") - 4;            // code accepted -> "All set"
  const c3 = rel("Get") - 2;           // gas drip
  const c4 = rel("claim") - 10;        // Agora faucet
  const c5 = rel("open") - 8;          // submit the long
  const c6 = rel("order") - 12;       // fill at the next Pyth price
  const segs = [
    { from: 0, to: c1, name: "signin1", start: 108 - rel("Sign") + 2, masks: [{ ...EMAIL_INPUT, from: 190 }, { ...EMAIL_LINE, from: 300 }] },
    { from: c1, to: c2, name: "signin1", start: 196, masks: [{ ...EMAIL_INPUT, from: 190 }, { ...EMAIL_LINE, from: 300 }] },
    { from: c2, to: c3, name: "signin2", start: 168, masks: [{ ...CODE, to: 160 }, { ...EMAIL_LINE, to: 160 }] },
    { from: c3, to: c4, name: "drip", start: 94 - (rel("drip,") - c3) - 4, masks: [] },
    { from: c4, to: c5, name: "faucet", start: 87 - (rel("faucet,") - c4) + 6, masks: [] },
    { from: c5, to: c6, name: "trade", start: 673 - (rel("SOL.") - c5) - 2, masks: [] },
    { from: c6, to: dur, name: "trade", start: 1907 - (rel("nobody") - c6) + 4, masks: [] },
  ];
  const order = { x: 1205, y: 300, w: 395, h: 600 };
  const modal = { x: 620, y: 258, w: 360, h: 384 };     // the email modal
  const codeModal = { x: 612, y: 336, w: 376, h: 228 }; // the "Creating your wallet" / "All set" modal
  const position = { x: 0, y: 700, w: 1210, h: 130 };
  return (
    <AbsoluteFill style={{ background: C.night, fontFamily: sora }}>
      <AbsoluteFill style={{ background: "radial-gradient(60% 50% at 50% 0%, rgba(110,84,255,0.16), transparent 70%)" }} />
      <Lanes y={1000} gap={7} color="rgba(255,255,255,0.05)" tick="rgba(168,152,255,0.35)" stroke={1} opacity={0.8} />
      {segs.map((s, i) => (
        <Sequence key={i} from={s.from} durationInFrames={s.to - s.from} layout="none">
          <Browser name={s.name} url="paraclr.xyz/app" width={W} left={L} top={TOP} startFrom={Math.max(0, s.start)} masks={s.masks} enter={i === 0 ? 0 : -100}
            {...(s.name === "trade" && i === 6 ? { focus: position, zoom: 1.55, focusAt: [rel("nobody") - c6 - 6, rel("nobody") - c6 + 16] as [number, number] } : {})}
            {...(s.name === "trade" && i === 5 ? { focus: order, zoom: 1.45, focusAt: [4, 22] as [number, number] } : {})}
            {...(s.name === "faucet" || s.name === "drip" ? { focus: order, zoom: 1.45, focusAt: [0, 1] as [number, number] } : {})}
            {...(i === 0 ? { focus: modal, zoom: 1.6, spotlight: true, focusAt: [rel("Sign") - 14, rel("Sign") + 8] as [number, number] } : {})}
            {...(i === 1 ? { focus: modal, zoom: 1.6, spotlight: true, focusAt: [0, 1] as [number, number] } : {})}
            {...(i === 2 ? { focus: codeModal, zoom: 1.6, spotlight: true, focusAt: [0, 1] as [number, number] } : {})} />
        </Sequence>
      ))}
      <Chip id="privy" name="Privy" role="passkey or email · embedded wallet" at={rel("Privy,") - 2} until={c3} />
      <Chip id="agora" name="Agora AUSD" role={"testnet faucet · 10\u2009000 test AUSD"} at={rel("Agora's") - 4} until={c5} />
      <Chip id="pyth" name="Pyth" role="filled at the first price ≥ 3 s after commit" at={rel("Pyth") - 4} until={dur} />
      <div style={{ position: "absolute", left: L, top: TOP - 38, fontFamily: mono, fontSize: 15, letterSpacing: "0.08em", color: C.dInk3, textTransform: "uppercase" }}>
        {f < c3 ? "sign in · privy" : f < c4 ? "gas drip · 0.3 test MON, once per wallet" : f < c5 ? "claim test AUSD · Agora's testnet faucet" : f < c6 ? "deposit 10 AUSD · long SOL 3x · 0.1 MON execution fee" : "filled at the next Pyth price"}
      </div>
    </AbsoluteFill>
  );
};
