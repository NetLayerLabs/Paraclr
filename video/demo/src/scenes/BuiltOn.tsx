import React from "react";
import { AbsoluteFill } from "remotion";
import { C, mono, sora } from "../theme";
import { useScene } from "../ui/use";
import { Partner } from "../ui/Brand";
import { Label } from "../ui/Label";
import { pop, ramp } from "../ui/motion";
import data from "../data.json";

/** The five partners, one line each, laid out as lanes; then ownership and the honest status. */
export const BuiltOn: React.FC = () => {
  const { f, rel } = useScene("builton");
  const rows = [
    { id: "monad", name: "Monad", role: "parallel lanes", at: rel("Monad.") - 4 },
    { id: "agora", name: "Agora AUSD", role: "collateral", at: rel("Agora") - 4 },
    { id: "pyth", name: "Pyth", role: "delayed fills", at: rel("Pyth") - 4 },
    { id: "privy", name: "Privy", role: "passkeys", at: rel("Privy") - 4 },
    { id: "envio", name: "Envio", role: "indexing every order and auction", at: rel("Envio") - 4 },
  ];
  const tOwn = rel("Owned"), tTest = rel("Tested"), tNot = rel("Not");
  const Y0 = 175, GAP = 112;
  const stamp = Math.min(1.15, pop(f, tNot));
  return (
    <AbsoluteFill style={{ background: C.paper, fontFamily: sora, color: C.ink }}>
      <Label color={C.ink3} style={{ position: "absolute", left: 150, top: 120 }}>built on</Label>
      {rows.map((r, i) => {
        const p = Math.min(1, pop(f, r.at));
        const y = Y0 + i * GAP;
        return (
          <div key={r.id} style={{ position: "absolute", left: 150, top: y, width: 1620, height: GAP, display: "flex", alignItems: "center", gap: 30, borderBottom: `1.5px solid ${C.line}`, opacity: p, transform: `translateX(${(1 - p) * -30}px)` }}>
            <div style={{ width: 72, height: 72, borderRadius: 18, background: C.ink, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}><Partner id={r.id} size={44} /></div>
            <div style={{ width: 520, fontSize: 48, fontWeight: 800, letterSpacing: "-0.04em" }}>{r.name}</div>
            <div style={{ fontSize: 36, fontWeight: 500, letterSpacing: "-0.02em", color: C.accent }}>{r.role}</div>
          </div>
        );
      })}
      <div style={{ position: "absolute", left: 150, top: Y0 + 5 * GAP + 44, display: "flex", gap: 70, alignItems: "flex-start" }}>
        <div style={{ opacity: ramp(f, tOwn - 4, tOwn + 10) }}>
          <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: "-0.03em" }}>Owned by a Safe behind a timelock</div>
          <div style={{ fontFamily: mono, fontSize: 15, color: C.ink3, marginTop: 6 }}>Safe {data.params.owner.slice(0, 6)}…{data.params.owner.slice(-4)} → timelock {data.params.timelock.slice(0, 6)}…{data.params.timelock.slice(-4)} · {data.params.timelockDelaySeconds} s delay</div>
        </div>
        <div style={{ opacity: ramp(f, tTest - 4, tTest + 10) }}>
          <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: "-0.03em" }}>Tested hard</div>
          <div style={{ fontFamily: mono, fontSize: 15, color: C.ink3, marginTop: 6 }}>256 Foundry tests · 23 invariant tests</div>
        </div>
      </div>
      <div style={{ position: "absolute", right: 150, top: Y0 + 5 * GAP + 30, transform: `rotate(-4deg) scale(${f >= tNot ? 1.9 - 0.9 * Math.min(1, stamp) : 0})`, opacity: Math.min(1, stamp),
        border: `4px solid ${C.ink}`, color: C.ink, fontFamily: mono, fontWeight: 500, fontSize: 30, letterSpacing: "0.14em", padding: "10px 22px", borderRadius: 8 }}>NOT YET AUDITED</div>
    </AbsoluteFill>
  );
};
