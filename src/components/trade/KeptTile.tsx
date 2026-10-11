// "What you kept": one finished auction of the signed-in account, compared with the fixed-penalty
// liquidation it replaced (src/lib/kept.ts, the same formula as the bench). Renders nothing when
// an input is missing: never a made-up number.

import { fmtPenaltyPct, keptVsFixed, FIXED_PENALTY_BPS } from "@/lib/kept";
import { fmtAusd } from "./format";
import styles from "./KeptTile.module.css";

export type KeptOutcome = "taken" | "cured" | "expired";

export interface KeptTileProps {
  outcome: KeptOutcome;
  /** AUSD at auction start (AuctionStarted); null if unknown. */
  equityAtStart: number | null;
  notional: number | null;
  /** AUSD returned to the trader by the take (AuctionTaken.traderResidual). */
  traderResidual: number | null;
  /** Lane the account was closed against (expired only). */
  lane?: number;
  compact?: boolean;
}

/** The tile's sentence, or null when it can't be stated from real inputs. */
export function keptLine(p: KeptTileProps): { tone: "kept" | "even" | "worse" | "cured" | "expired"; text: string } | null {
  const pct = fmtPenaltyPct(FIXED_PENALTY_BPS);
  if (p.outcome === "cured") return { tone: "cured", text: "Cured: the auction cost you nothing." };
  if (p.outcome === "expired") {
    return {
      tone: "expired",
      text:
        `Expired: nobody took the auction in time, so your positions were closed at the mark against ` +
        `${p.lane !== undefined ? `L${p.lane}` : "the lane"} with the fixed ${pct} penalty, capped at your equity ` +
        "(any negative equity is written off against the lane, not charged to you). " +
        "That is the fixed-penalty path itself, so there is no saving to compare.",
    };
  }
  if (p.equityAtStart === null || p.notional === null || p.traderResidual === null) return null;
  const r = keptVsFixed({ notional: p.notional, equityAtStart: p.equityAtStart, traderResidual: p.traderResidual });
  if (!r) return null;
  const fixed = `A fixed ${pct} liquidation would have taken ${fmtAusd(r.fixedPenalty)} AUSD.`;
  if (r.auctionCost <= 0) {
    return {
      tone: "kept",
      text: `${fixed} The auction took nothing: prices moved your way before the take. You kept ${fmtAusd(r.kept)} AUSD.`,
    };
  }
  const took = `The auction took ${fmtAusd(r.auctionCost)} AUSD.`;
  if (r.kept >= 0.005) return { tone: "kept", text: `${fixed} ${took} You kept ${fmtAusd(r.kept)} AUSD.` };
  if (r.kept > -0.005) return { tone: "even", text: `${fixed} ${took} Same as the fixed penalty.` };
  return {
    tone: "worse",
    text: `${fixed} ${took} That is ${fmtAusd(-r.kept)} AUSD more than the fixed penalty: the discount grew past ${pct} before a taker stepped in, or prices moved against you during the auction.`,
  };
}

export function KeptTile(p: KeptTileProps) {
  const line = keptLine(p);
  if (!line) return null;
  return (
    <p className={styles.tile} data-tone={line.tone} data-compact={p.compact ? "" : undefined}>
      {!p.compact && <span className={styles.label}>vs a fixed {fmtPenaltyPct(FIXED_PENALTY_BPS)} liquidation</span>}
      <span>{line.text}</span>
    </p>
  );
}
