import React from "react";
import { interpolate } from "remotion";
import { C, mono, sora } from "../theme";
import { useScene } from "../ui/use";
import { Mask } from "../ui/Browser";
import { markOf } from "../ui/Browser";
import { Shots, Seg, W, L, TOP } from "../ui/Shots";
import { Partner } from "../ui/Brand";
import { clamp, pop, ramp } from "../ui/motion";
import { num } from "../ui/format";
import data from "../data.json";

// Sign-in privacy (same covers as the film): the email and the one-time code never show.
const EMAIL_INPUT: Mask = { x: 690, y: 378, w: 262, h: 54 };
const EMAIL_LINE: Mask = { x: 745, y: 381, w: 172, h: 34 };
const CODE: Mask = { x: 650, y: 474, w: 300, h: 64 };
const APP = "paraclr.xyz/app";
// page regions (CSS px of the 1600x900 recordings)
const ORDER_PANEL = { x: 1205, y: 300, w: 395, h: 600 };
const POSITION = { x: 0, y: 700, w: 1210, h: 130 };
const MODAL = { x: 620, y: 258, w: 360, h: 384 };
const WALLET_MODAL = { x: 612, y: 336, w: 376, h: 228 };

/** A partner chip over the footage when that partner is on screen. */
const Chip: React.FC<{ scene: string; id: string; name: string; role: string; at: number; until: number }> = ({ scene, id, name, role, at, until }) => {
  const { f } = useScene(scene);
  if (f < at - 1 || f > until) return null;
  const p = Math.min(1, pop(f, at));
  const o = interpolate(f, [until - 10, until], [1, 0], clamp);
  return (
    <div style={{ position: "absolute", right: 1920 - L - W + 24, top: TOP + 64, display: "flex", alignItems: "center", gap: 14, padding: "12px 20px 12px 14px", borderRadius: 16,
      background: "rgba(17,16,25,0.88)", border: "1px solid rgba(255,255,255,0.14)", boxShadow: "0 20px 50px rgba(0,0,0,0.5)", backdropFilter: "blur(16px)",
      opacity: p * o, transform: `translateY(${(1 - p) * -16}px) scale(${0.92 + 0.08 * p})` }}>
      <div style={{ width: 46, height: 46, borderRadius: 12, background: "#1C1A27", display: "flex", alignItems: "center", justifyContent: "center" }}><Partner id={id} size={30} /></div>
      <div>
        <div style={{ fontFamily: sora, fontSize: 22, fontWeight: 700, color: C.dInk, letterSpacing: "-0.02em" }}>{name}</div>
        <div style={{ fontFamily: mono, fontSize: 13, color: C.dInk3, letterSpacing: "0.05em" }}>{role}</div>
      </div>
    </div>
  );
};

export const TSignin: React.FC = () => {
  const { rel, dur } = useScene("tsignin");
  const c1 = rel("by") - 6, c2 = rel("No") - 4;
  const segs: Seg[] = [
    { from: 0, to: c1, clip: "signin1", at: 0, url: APP, label: "sign in · privy", focus: MODAL, zoom: 1.6, spotlight: true, focusAt: [rel("sign") - 18, rel("sign") + 4], masks: [{ ...EMAIL_INPUT, from: 190 }] },
    { from: c1, to: c2, clip: "signin1", at: 196, url: APP, label: "sign in · privy · email blurred", focus: MODAL, zoom: 1.6, spotlight: true, masks: [{ ...EMAIL_INPUT, from: 190 }, { ...EMAIL_LINE, from: 300 }] },
    { from: c2, to: dur, clip: "signin2", at: 168, url: APP, label: "embedded wallet created", focus: WALLET_MODAL, zoom: 1.6, spotlight: true, masks: [{ ...CODE, to: 160 }, { ...EMAIL_LINE, to: 160 }] },
  ];
  return <Shots segs={segs}><Chip scene="tsignin" id="privy" name="Privy" role="email sign-in · embedded wallet" at={rel("Privy,") - 2} until={dur} /></Shots>;
};

export const TFund: React.FC = () => {
  const { rel, dur } = useScene("tfund");
  const c1 = rel("and") - 2;
  const segs: Seg[] = [
    { from: 0, to: c1, clip: "drip", at: 94 - rel("drips"), url: APP, label: "gas drip · 0.3 test MON, once per wallet", focus: ORDER_PANEL, zoom: 1.45 },
    { from: c1, to: dur, clip: "faucet", at: 87 - (rel("faucet") - c1), url: APP, label: "claim test AUSD · Agora's testnet faucet", focus: ORDER_PANEL, zoom: 1.45 },
  ];
  return <Shots segs={segs}><Chip scene="tfund" id="agora" name="Agora AUSD" role={"testnet faucet · 10 000 test AUSD"} at={rel("Agora's") - 4} until={dur} /></Shots>;
};

export const TOpen: React.FC = () => {
  const { rel, dur } = useScene("topen");
  const base = 1907 - rel("This"); // the fill lands on "This one filled in three seconds"
  const c1 = rel("This") - 16;
  const segs: Seg[] = [
    { from: 0, to: c1, clip: "trade", at: base, url: APP, label: "deposit 10 AUSD · long SOL 3x · 0.1 MON execution fee", focus: ORDER_PANEL, zoom: 1.45 },
    { from: c1, to: dur, clip: "trade", at: base + c1, url: APP, label: "filled at the next Pyth price", focus: POSITION, zoom: 1.55, focusAt: [c1, c1 + 14] },
  ];
  return <Shots segs={segs}><Chip scene="topen" id="pyth" name="Pyth" role="filled at the first price ≥ 3 s after commit" at={rel("Pyth") - 4} until={dur} /></Shots>;
};

export const TClose: React.FC = () => {
  const { rel, dur } = useScene("tclose");
  const click = markOf("close2", "c2_click");
  const at0 = click - 10; // the Close click lands 10 frames in; the dialog is up for "I close it"
  const c1 = markOf("close2", "c2_confirm") - at0 + 6; // zoom to Orders only once the dialog has closed
  const c2 = rel("with") - 4;
  const orders = { x: 1210, y: 280, w: 390, h: 270 };
  const card = { x: 445, y: 212, w: 710, h: 475 };
  const segs: Seg[] = [
    // the confirm dialog is up for "I close it"
    { from: 0, to: c1, clip: "close2", at: at0, url: APP, label: "close the SOL long" },
    // the close order waits for the next Pyth price
    { from: c1, to: c2, clip: "close2", at: at0 + c1, url: APP, label: "orders · submitted → next Pyth price → filled", focus: orders, zoom: 1.9, focusAt: [c1, c1 + 14] },
    // filled: the app's own share card for the round trip (+0.11 AUSD), as rendered
    { from: c2, to: dur, clip: "close2", at: 590, url: APP, label: "filled at 111.55 · the app's share card", focus: card, zoom: 1.25, hold: 760 },
  ];
  return <Shots segs={segs} />;
};

export const TChain: React.FC = () => {
  const { rel, dur } = useScene("tchain");
  const c1 = rel("Here") - 6;
  const row = { x: 0, y: 690, w: 1520, h: 150 };
  const segs: Seg[] = [
    { from: 0, to: c1, clip: "history", at: markOf("history", "hi_tab") - 20, url: APP, label: "history · indexed by Envio", focus: row, zoom: 1.5, focusAt: [30, 50] },
    { from: c1, to: dur, clip: "explorer", at: 0, url: "testnet.monadvision.com/tx/0x0ad5…8fba", label: "the close's fill · Monad testnet explorer" },
  ];
  return <Shots segs={segs}><Chip scene="tchain" id="envio" name="Envio" role="indexes every order and auction" at={rel("Envio") - 2} until={c1} /></Shots>;
};

export const TClearing: React.FC = () => {
  const { rel, dur } = useScene("tclearing");
  const URL = APP + " · Clearing";
  // page regions of the recording (CSS px): the 8-lane table, then (after the page scrolls) Envio's stats
  const lanes = { x: 0, y: 300, w: 1000, h: 590 };
  const stats = { x: 0, y: 560, w: 1060, h: 110 };
  const tRow = rel("Each"), tIf = rel("If"), tOn = rel("On");
  const segs: Seg[] = [
    { from: 0, to: tIf - 4, clip: "clearing", at: 0, url: URL, label: "clearing · 8 lanes · live on Monad testnet", focus: lanes, zoom: 1.5,
      focusAt: [tRow - 8, tRow + 18], unfocusAt: [tIf - 30, tIf - 4], hold: 465 },
    { from: tIf - 4, to: tOn - 10, clip: "clearing", at: tIf - 4, url: URL, label: "per-block dutch auction · +0.05% a block", hold: 465 },
    { from: tOn - 10, to: dur, clip: "clearing", at: tOn - 10, url: URL, label: "since deploy · indexed by Envio", focus: stats, zoom: 1.5, focusAt: [tOn - 10, tOn + 16], hold: 465 },
  ];
  return <Shots segs={segs} />;
};

export const TBackstop: React.FC = () => {
  const { rel, dur } = useScene("tbackstop");
  const base = 66;
  const URL = APP + " · Backstop";
  const pools = { x: 0, y: 180, w: 1220, h: 480 };
  const panel = { x: 1240, y: 290, w: 350, h: 390 };
  const earned = { x: 0, y: 180, w: 620, h: 110 };
  const c1 = rel("A") - 6, c2 = rel("Nothing") - 8, t75 = rel("seventy-five"), tEarn = rel("earnings");
  const segs: Seg[] = [
    { from: 0, to: c1, clip: "backstop", at: base, url: URL, label: "backstop · one LP pool per lane", focus: pools, zoom: 1.3,
      focusAt: [rel("Backstop"), rel("Backstop") + 24], unfocusAt: [c1 - 24, c1], hold: 370 },
    { from: c1, to: c2, clip: "backstop", at: base + c1, url: URL, label: "takes accounts at ≥ 0.75% discount", focus: panel, zoom: 1.8,
      focusAt: [t75 - 22, t75 + 4], unfocusAt: [c2 - 24, c2], hold: 370 },
    { from: c2, to: dur, clip: "backstop", at: base + c2, url: URL, label: "discount earned since deploy", focus: earned, zoom: 2.0, focusAt: [tEarn - 18, tEarn + 6], hold: 370 },
  ];
  return <Shots segs={segs} />;
};

export const TXray: React.FC = () => {
  const { f, rel, dur } = useScene("txray");
  const segs: Seg[] = [
    { from: 0, to: dur, clip: "arena_xray", at: 300, url: "paraclr.xyz/arena", label: "conflict x-ray · crash #4 · run mv4b7d4t-dx2sr · live trace", hold: 600 },
  ];
  const k = data.kept, x = data.xray;
  const tCard = rel("zero", 1) - 6, t28 = rel("twenty-eight") - 4;
  const card = ramp(f, tCard, tCard + 14), c28 = ramp(f, t28, t28 + 14);
  return (
    <Shots segs={segs}>
      <div style={{ position: "absolute", right: 1920 - L - W - 40, top: 470, width: 560, padding: "24px 28px", borderRadius: 18, background: "rgba(17,16,25,0.94)",
        border: "1px solid rgba(255,255,255,0.16)", boxShadow: "0 30px 80px rgba(0,0,0,0.6)", opacity: card, transform: `translateY(${(1 - card) * 24}px)`, fontFamily: sora, color: C.dInk }}>
        <div style={{ fontFamily: mono, fontSize: 13, letterSpacing: "0.08em", color: C.dInk3 }}>MEASURED RUNS · MONAD TESTNET</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginTop: 12 }}>
          <span style={{ fontSize: 64, fontWeight: 800, letterSpacing: "-0.05em", color: C.posDark }}>0</span>
          <span style={{ fontSize: 28, color: C.dInk3 }}>vs</span>
          <span style={{ fontSize: 64, fontWeight: 800, letterSpacing: "-0.05em", color: C.negDark }}>{x.naive.summary.crossLaneEdges}</span>
          <span style={{ fontSize: 18, color: C.dInk2, marginLeft: 6 }}>cross-lane edges</span>
        </div>
        <div style={{ fontFamily: mono, fontSize: 12, color: C.dInk3, marginTop: 2 }}>{x.file}</div>
        <div style={{ opacity: c28, marginTop: 16 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <span style={{ fontSize: 64, fontWeight: 800, letterSpacing: "-0.05em" }}>{Math.round(k.pctLess)}%</span>
            <span style={{ fontSize: 18, color: C.dInk2 }}>less taken than a fixed fee</span>
          </div>
          <div style={{ fontSize: 17, color: C.dInk2 }}>{num(k.taken, 2)} vs {num(k.fixed, 2)} AUSD</div>
          <div style={{ fontFamily: mono, fontSize: 12, color: C.dInk3, marginTop: 2 }}>{k.file}</div>
        </div>
      </div>
    </Shots>
  );
};
