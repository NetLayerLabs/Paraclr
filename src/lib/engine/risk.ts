// Pure margin math for one cross-margin account.

import { MAINTENANCE_MARGIN, unrealizedPnl } from "@/lib/store";
import type { AccountHealth, ClearingAccount } from "@/lib/types";
import type { MarkPrices } from "./accounts";

export interface AccountRisk {
  equity: number; // collateral + unrealised PnL, AUSD
  notional: number; // Σ |size| * mark
  maintenance: number; // notional * MM
  /** equity / notional (Infinity when flat). Liquidatable below MAINTENANCE_MARGIN. */
  marginRatio: number;
  health: AccountHealth;
}

/** Accounts within this multiple of maintenance are flagged "warning". */
export const WARNING_MULTIPLE = 2;

export function evaluateAccount(
  account: ClearingAccount,
  marks: MarkPrices,
  mm = MAINTENANCE_MARGIN,
): AccountRisk {
  let pnl = 0;
  let notional = 0;
  for (const p of account.positions) {
    const mark = marks[p.symbol];
    pnl += unrealizedPnl(p, mark);
    notional += p.size * mark;
  }
  const equity = account.collateral + pnl;
  const maintenance = notional * mm;
  const marginRatio = notional > 0 ? equity / notional : Infinity;
  const health: AccountHealth =
    equity < maintenance
      ? "liquidatable"
      : equity < maintenance * WARNING_MULTIPLE
        ? "warning"
        : "healthy";
  return { equity, notional, maintenance, marginRatio, health };
}

export function bookStats(accounts: ClearingAccount[], marks: MarkPrices) {
  let tvl = 0;
  let atRisk = 0;
  let liquidatable = 0;
  for (const a of accounts) {
    tvl += a.collateral;
    const r = evaluateAccount(a, marks);
    if (r.health !== "healthy") atRisk++;
    if (r.health === "liquidatable") liquidatable++;
  }
  return { tvl, atRisk, liquidatable };
}
