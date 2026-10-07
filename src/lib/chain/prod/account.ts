// Account read for the production clearinghouse, returned in the same
// ChainAccountSnapshot shape the rest of the app renders.
//
// Health views (`accountHealth`, `freeCollateral`) value positions at the Pyth
// price stored on chain (or the lane's last price) and revert once it is older
// than `maxStoredPriceAge` (no one pushed an update recently). Then the snapshot is valued at the latest
// Pyth (Hermes) price this browser streams instead, flagged `estimated` and
// labelled as such — the contract re-checks everything with a fresh price on
// every order and withdrawal.

import { erc20Abi, type Address } from "viem";
import { MARKETS, type MarketSymbol, type Position } from "../../types";
import { getState } from "../../store";
import { CHAIN_MAINTENANCE_MARGIN, crossLiquidationPrice, type ChainAccountSnapshot } from "../account";
import { getLatestBlock, publicClient } from "../clients";
import { readableError } from "../errors";
import type { LiveContracts } from "../runtime";
import { ausdToNumber, nativeToNumber, priceToNumber, sizeToNumber } from "../units";
import { prodAbi } from "./abi";
import { big, readLoose, signedNumber, tuple, type LooseCall } from "./state";

/** `getPosition` (v2+): `id` after `isLong` (orders bind to it; a taken / replaced position gets a new id). */
interface ProdPosition {
  isLong: boolean;
  id: bigint;
  size: bigint;
  entryPrice: bigint;
  entryNotional: bigint;
  margin: bigint;
  fundingIndex: bigint;
}

const signedAusd = (v: bigint) => (v < BigInt(0) ? -ausdToNumber(-v) : ausdToNumber(v));

export async function readProdAccountSnapshot(address: Address, c: LiveContracts): Promise<ChainAccountSnapshot> {
  const ch = c.clearinghouse;
  const ids = MARKETS.map((s) => c.markets[s]);
  const call = (functionName: string, args?: readonly unknown[]): LooseCall => ({
    address: ch,
    abi: prodAbi,
    functionName,
    args,
  });
  const [res, nativeUnits] = await Promise.all([
    readLoose([
      call("getAccount", [address]),
      call("accountHealth", [address]),
      call("freeCollateral", [address]),
      { address: c.ausd, abi: erc20Abi, functionName: "balanceOf", args: [address] },
      { address: c.ausd, abi: erc20Abi, functionName: "allowance", args: [address, ch] },
      call("auctionOf", [address]),
      ...ids.map((id) => call("getPosition", [address, id])),
      ...ids.map((id) => call("unrealizedPnl", [address, id])),
    ]),
    publicClient().getBalance({ address }),
  ]);
  const [acctR, healthR, freeR, balR, allowR, aucR, ...rest] = res;
  const posR = rest.slice(0, MARKETS.length);
  const upnlR = rest.slice(MARKETS.length);

  const acct = tuple(acctR);
  if (!acct) throw acctR.status === "failure" ? acctR.error : new Error("getAccount returned nothing");
  const collateralUnits = acct[0] as bigint;
  const lane = Number(acct[1]);
  const registered = Boolean(acct[2]);
  const reservedUnits = acct[4] as bigint;

  // Marks: the Pyth prices streamed from Hermes (what orders fill near).
  const prices = getState().prices;
  const marks: Partial<Record<MarketSymbol, number>> = {};
  MARKETS.forEach((m) => {
    const p = prices[m]?.price;
    if (p !== undefined && p > 0) marks[m] = p;
  });

  const collateral = signedAusd(collateralUnits);
  const legs: { symbol: MarketSymbol; dir: 1 | -1; size: number; entry: number; mark: number }[] = [];
  const raw: { symbol: MarketSymbol; marketId: string; pos: ProdPosition; funding: number | null }[] = [];
  posR.forEach((r, i) => {
    if (r.status !== "success" || !r.result || typeof r.result !== "object") return;
    const pos = r.result as ProdPosition;
    if (pos.size === BigInt(0)) return;
    const symbol = MARKETS[i];
    const u = tuple(upnlR[i]);
    raw.push({ symbol, marketId: ids[i], pos, funding: u ? signedAusd(u[1] as bigint) : null });
    const entry = priceToNumber(pos.entryPrice);
    legs.push({ symbol, dir: pos.isLong ? 1 : -1, size: sizeToNumber(pos.size), entry, mark: marks[symbol] ?? entry });
  });

  const marginSum = raw.reduce((s, r) => s + ausdToNumber(r.pos.margin), 0);
  const positions: Position[] = raw.map((r, i) => {
    const margin = ausdToNumber(r.pos.margin);
    const entryNotional = ausdToNumber(r.pos.entryNotional);
    return {
      id: `chain:${r.symbol}`,
      owner: address,
      symbol: r.symbol,
      side: r.pos.isLong ? "long" : "short",
      size: legs[i].size,
      entryPrice: legs[i].entry,
      margin,
      // Effective leverage at entry (the prod contract stores margin, not a leverage field).
      leverage: margin > 0 ? Math.max(1, Math.round((entryNotional / margin) * 10) / 10) : 0,
      openedAt: 0,
      liquidationPrice: crossLiquidationPrice(collateral, legs, i),
      marketId: r.marketId,
      sizeUnits: r.pos.size,
    };
  });

  // Health: on chain when the stored Pyth price is fresh enough; otherwise an estimate.
  let equity: number | null = null;
  let maintenanceMargin: number | null = null;
  let notional: number | null = null;
  let healthError: string | null = null;
  let estimated = false;
  const h = tuple(healthR);
  if (h) {
    equity = signedNumber(h[0] as bigint) / 1e6;
    maintenanceMargin = ausdToNumber(h[1] as bigint);
    notional = ausdToNumber(h[3] as bigint);
  } else if (raw.length === 0) {
    equity = collateral;
    maintenanceMargin = 0;
    notional = 0;
  } else {
    estimated = true;
    const haveMarks = legs.every((l) => marks[l.symbol] !== undefined);
    if (haveMarks) {
      const pnl = legs.reduce((s, l) => s + l.dir * (l.mark - l.entry) * l.size, 0);
      const funding = raw.reduce((s, r) => s + (r.funding ?? 0), 0);
      notional = legs.reduce((s, l) => s + l.size * l.mark, 0);
      equity = collateral + pnl + funding;
      maintenanceMargin = notional * CHAIN_MAINTENANCE_MARGIN;
    }
    const why = healthR.status === "failure" ? readableError(healthR.error) : "";
    healthError = /refreshing|stale|older/i.test(why)
      ? "Estimated at the last Pyth price this app saw: the price stored on chain is older than the contract accepts, so its health views resume with the next price update."
      : `Estimated at the last Pyth price this app saw (the contract's health view didn't answer${why ? `: ${why}` : ""}).`;
  }

  const reserved = ausdToNumber(reservedUnits);
  let freeCollateralUnits = big(freeR);
  let freeCollateral: number | null = freeCollateralUnits !== null ? ausdToNumber(freeCollateralUnits) : null;
  if (freeCollateral === null && equity !== null) {
    const byEquity = raw.length ? Math.min(collateral, equity - marginSum) : collateral;
    freeCollateral = Math.max(0, byEquity - reserved);
    freeCollateralUnits = BigInt(Math.floor(freeCollateral * 1e6));
  }
  const walletAusdUnits = big(balR) ?? BigInt(0);
  const auc = tuple(aucR);
  const latest = getLatestBlock();

  return {
    address,
    block: latest === null ? null : Number(latest),
    lane,
    registered,
    collateral,
    equity,
    maintenanceMargin,
    initialMargin: marginSum,
    notional,
    freeCollateral,
    freeCollateralUnits: freeCollateralUnits ?? BigInt(0),
    walletAusd: ausdToNumber(walletAusdUnits),
    walletAusdUnits,
    allowanceUnits: big(allowR) ?? BigInt(0),
    native: nativeToNumber(nativeUnits),
    nativeUnits,
    positions,
    marks,
    liquidatable: positions.length > 0 && equity !== null && maintenanceMargin !== null && equity < maintenanceMargin,
    auction: auc ? { active: Boolean(auc[0]), startBlock: Number(auc[1]), discountBps: Number(auc[2]) } : null,
    healthError,
    readAt: Date.now(),
    collateralUnits,
    reservedMarginUnits: reservedUnits,
    marginSumUnits: raw.reduce((s, r) => s + r.pos.margin, BigInt(0)),
    estimated,
  };
}
