// MON budget for the production hot keys, from MEASURED gas.
//
// Monad bills gas LIMIT × (base fee + priority fee), not gas used (docs.monad.xyz gas-pricing), so
// every number here is a gas limit as the keeper sends it (estimateGas + KEEPER_GAS_MARGIN_BPS).
//
// MEASURED_GAS is filled from the mainnet-fork rehearsal (`npm run rehearse:mainnet`, report
// `gas` section). `keeper:fund -- --network mainnet --gas-report <report.json>` uses a newer
// report instead. Activity assumptions are env-overridable (BUDGET_* below) and printed with
// every preview, so the human can see exactly what the targets assume.

import { existsSync, readFileSync } from "node:fs";
import { formatEther, parseEther } from "viem";
import { envStr } from "../env";
import { envNum, LANES, net, prodMarkets } from "./config";

export interface GasTable {
  /** Where the numbers come from (printed with every preview). */
  source: string;
  /** Gas LIMIT per operation as sent by the keeper. */
  executeOrder: number;
  updateFunding: number;
  /** startAuctions for one account incl. the Pyth update verification. */
  startAuction: number;
  backstopTake: number;
  expire: number;
  cancelAuction: number;
  pause: number;
  /** pyth.updatePriceFeeds with a 3-feed Hermes update (the keeper's on-demand / interval push). */
  pythPush: number;
  /** Whole DeployProd.s.sol run (sum of gas limits as forge sent them). */
  deploy: number;
  /** Plain MON transfer. */
  transfer: number;
}

/**
 * Measured by the final `npm run rehearse:mainnet` on 2026-10-07 against contract v5 (sha256
 * 1643014507eaf16a…) with the real DeployProd on every leg — bench/rehearsal/143-fork-v5-*.json →
 * gas.limits — as gas LIMITs the keeper sends (estimateGas + 10 %): real Pyth contract verifying
 * real Wormhole-signed Hermes subsets on an anvil fork of Monad mainnet. Auction txs = the fork's
 * real-Pyth probe + the per-account work measured with the test MockPyth. Monad bills the LIMIT.
 */
export const MEASURED_GAS: GasTable = {
  source: "rehearse:mainnet 2026-10-07, contract v5 (bench/rehearsal/143-fork-v5-2026-10-07T05-41-11Z.json)",
  executeOrder: 446_080, // average limit (single-leg max 499,514; multi-leg with its appended update 676,627)
  updateFunding: 87_713,
  startAuction: 444_362,
  backstopTake: 606_336,
  expire: 458_835,
  cancelAuction: 183_153,
  pause: 33_374,
  pythPush: 183_349, // 3 feeds; 1 feed 125,691
  deploy: 18_090_000, // DeployProd.s.sol v5: 21 txs, 14.84M used
  transfer: 21_000,
};

/**
 * Monad TESTNET (chain 10143), measured by `npm run rehearse:testnet` on an anvil fork of the
 * testnet with the real testnet AUSD and the real Pyth (2 markets, SOL + BTC; Pyth fee 1 wei per
 * message) — filled from that report's gas.limits (see TESTNET_GAS_SOURCE). Auction gas = the
 * fork's real-Pyth probe + per-account work from the MockPyth leg, like mainnet.
 */
export const TESTNET_MEASURED_GAS: GasTable = {
  source: "rehearse:testnet 2026-10-07, contract v5 (bench/rehearsal/10143-fork-2026-10-07T15-51-49Z.json)",
  executeOrder: 453_659, // average limit (single-leg max ≈ 507k; multi-leg with its appended update 691,189)
  updateFunding: 87_713,
  startAuction: 334_770, // fork real-Pyth probe (2 feeds) + MockPyth-leg per-account work
  backstopTake: 584_078,
  expire: MEASURED_GAS.expire, // no expiry on the testnet legs: the mainnet figure (higher, conservative)
  cancelAuction: MEASURED_GAS.cancelAuction, // idem
  pause: 33_374,
  pythPush: 154_472, // 2 feeds; 1 feed 125,731
  deploy: 18_050_000, // DeployProd v5 with 2 markets: 20 txs, 14.61M used
  transfer: 21_000,
};

export interface Activity {
  days: number;
  /** Executions are paid back by users' execution fees (claimed by the keeper): float this many days. */
  executionFloatDays: number;
  /** User-paid execution fee per order (wei), for the net figure. */
  executionFeeWei: bigint;
  /** Executed orders per day across all lanes. */
  ordersPerDay: number;
  markets: number;
  /** Funding updates per market per day. */
  fundingUpdatesPerDay: number;
  /** Accounts liquidated per day across all lanes (start + take, plus a share that expires). */
  liquidationsPerDay: number;
  /** Fraction of liquidations that reach MAX and expire instead of a pool take. */
  expireShare: number;
  /** The busiest lane gets this multiple of the average lane's load (keys are per lane). */
  laneSkew: number;
  /** Pyth update fee per update, wei (getUpdateFee on Monad answered 0 on 2026-10-07). */
  pythFeeWei: bigint;
  gasPriceWei: bigint;
  /** Extra headroom on every target (1.5 = +50%). */
  safety: number;
  /** Pyth push policy (pricepush.ts): on-demand pushes only before multi-leg executions. */
  pushMode: "on-demand" | "interval" | "off";
  /** Share of executions whose account holds OTHER legs (they need a fresh stored price). */
  multiLegShare: number;
  /** Share of the time the stored price is too old without us (measured: 1 − ~0.4). */
  storedStaleShare: number;
  /** interval mode: our pushes per day on top of the third-party pushes (measured 5,469 at 12 s). */
  intervalPushesPerDay: number;
  /** v3 (EXEC_OTHER_LEGS=append): extra gas of a multi-leg execution carrying the other legs' update. */
  appendGas: number;
  otherLegs: "push" | "append";
}

/** Activity defaults per network: mainnet = the guarded beta; testnet = ~3 weeks of light demo use. */
function defaults() {
  return net().name === "testnet"
    ? { days: 21, orders: 30, liquidations: 1, fundingChanges: 12, maxAge: 21_600, floor: "0.2" }
    : { days: 14, orders: 200, liquidations: 20, fundingChanges: 48, maxAge: 3_600, floor: "0.5" };
}

export function activityFromEnv(gasPriceWei: bigint, pythFeeWei: bigint, fundingIntervalS?: number): Activity {
  const d = defaults();
  // The keeper's funding policy (funding.ts) updates a market when its rate would change by more
  // than FUNDING_MIN_CHANGE_BPS, or at least every FUNDING_MAX_AGE_S — never more often than the
  // contract interval. Budget: one update per max-age plus BUDGET_FUNDING_CHANGES_PER_DAY.
  const interval = fundingIntervalS && fundingIntervalS > 0 ? fundingIntervalS : 60;
  const minChange = envNum("FUNDING_MIN_CHANGE_BPS", 500);
  const maxAge = Math.max(interval, envNum("FUNDING_MAX_AGE_S", d.maxAge));
  const perDay = minChange === 0 ? 86_400 / interval : Math.min(86_400 / interval, 86_400 / maxAge + envNum("BUDGET_FUNDING_CHANGES_PER_DAY", d.fundingChanges));
  return {
    days: envNum("FUND_DAYS", d.days),
    executionFloatDays: envNum("BUDGET_EXECUTION_FLOAT_DAYS", 2),
    executionFeeWei: BigInt(Math.round(envNum("BUDGET_EXECUTION_FEE_MON", 0.1) * 1e6)) * BigInt(1e12),
    ordersPerDay: envNum("BUDGET_ORDERS_PER_DAY", d.orders),
    markets: envNum("BUDGET_MARKETS", Object.keys(prodMarkets()).length),
    fundingUpdatesPerDay: perDay,
    liquidationsPerDay: envNum("BUDGET_LIQUIDATIONS_PER_DAY", d.liquidations),
    expireShare: envNum("BUDGET_EXPIRE_SHARE", 0.2),
    laneSkew: envNum("BUDGET_LANE_SKEW", 2),
    pythFeeWei,
    gasPriceWei,
    safety: envNum("BUDGET_SAFETY", 1.5),
    pushMode: ((process.env.PYTH_PUSH_MODE ?? "on-demand").trim().toLowerCase() as Activity["pushMode"]),
    multiLegShare: envNum("BUDGET_MULTI_LEG_SHARE", 0.3),
    storedStaleShare: envNum("BUDGET_STORED_STALE_SHARE", 0.6),
    intervalPushesPerDay: envNum("BUDGET_INTERVAL_PUSHES_PER_DAY", 5_469),
    appendGas: envNum("BUDGET_APPEND_GAS", 177_000), // measured v3: 673,693 − 496,832
    otherLegs: (process.env.EXEC_OTHER_LEGS ?? "append").trim().toLowerCase() === "push" ? "push" : "append",
  };
}

export function loadGasTable(reportPath?: string): GasTable {
  const base = net().name === "testnet" ? TESTNET_MEASURED_GAS : MEASURED_GAS;
  if (!reportPath) return base;
  if (!existsSync(reportPath)) throw new Error(`--gas-report ${reportPath} not found`);
  const r = JSON.parse(readFileSync(reportPath, "utf8")) as { gas?: Partial<GasTable> & { limits?: Partial<GasTable> & { executeOrderAvg?: number } } };
  const g = { ...(r.gas?.limits ?? r.gas) } as Partial<GasTable> & { executeOrderAvg?: number };
  if (!r.gas) throw new Error(`${reportPath} has no "gas" section (is it a rehearsal report?)`);
  // Burn is driven by the average execution; the max (a second-leg order) only matters per tx.
  if (typeof g.executeOrderAvg === "number") g.executeOrder = g.executeOrderAvg;
  const pick = (k: keyof Omit<GasTable, "source">) => (typeof g[k] === "number" && (g[k] as number) > 0 ? (g[k] as number) : base[k]);
  return {
    source: `rehearsal report ${reportPath}`,
    executeOrder: pick("executeOrder"),
    updateFunding: pick("updateFunding"),
    startAuction: pick("startAuction"),
    backstopTake: pick("backstopTake"),
    expire: pick("expire"),
    cancelAuction: pick("cancelAuction"),
    pause: pick("pause"),
    pythPush: pick("pythPush"),
    deploy: pick("deploy"),
    transfer: pick("transfer"),
  };
}

export interface BudgetRow {
  role: string;
  /** MON per day (wei). */
  perDay: bigint;
  /** Target balance (wei) for `days`, incl. safety and floors. */
  target: bigint;
  why: string;
}

const wei = (gas: number, a: Activity) => BigInt(Math.ceil(gas)) * a.gasPriceWei;
const scale = (v: bigint, f: number) => (v * BigInt(Math.round(f * 1_000))) / BigInt(1_000);

export interface Budget {
  rows: BudgetRow[];
  /** Σ targets (what keeper:fund wants on the keys). */
  total: bigint;
  /** Gross MON spent per day across all keys (average lane load). */
  perDayTotal: bigint;
  /** Gross MON spent over `days`, and net of the execution fees users pay the keepers. */
  periodGross: bigint;
  periodNet: bigint;
}

/**
 * Per-role MON targets. Keepers float `executionFloatDays` of executions (users' execution fees
 * reimburse them through claimExecutionFees) plus `days` of liquidations (not reimbursed); OPS
 * floats `days` of funding updates; the deployer one deploy. Every key gets at least
 * BUDGET_MIN_KEY_MON so it can act in an incident.
 */
export function computeBudget(gas: GasTable, a: Activity): Budget {
  const floor = parseEther(envStr("BUDGET_MIN_KEY_MON") ?? defaults().floor);
  const busiest = (x: number) => (x / LANES) * a.laneSkew;
  const avg = (x: number) => x / LANES;
  const liqGas = gas.startAuction + (1 - a.expireShare) * gas.backstopTake + a.expireShare * gas.expire + 0.1 * gas.cancelAuction;
  // Multi-leg executions: v3 appends the other legs' update (extra verification gas, always);
  // v2 pushes the stale feeds first (only when storage is stale).
  const pushPerOrder =
    a.otherLegs === "append" ? a.multiLegShare * a.appendGas : a.pushMode === "off" ? 0 : a.multiLegShare * a.storedStaleShare * gas.pythPush;
  const execDay = (orders: number) => wei(orders * (gas.executeOrder + pushPerOrder), a);
  const liqDay = (liqs: number) => wei(liqs * liqGas, a) + a.pythFeeWei * BigInt(Math.ceil(liqs * 2));
  const pythExec = (orders: number) => a.pythFeeWei * BigInt(Math.ceil(orders * 2));
  const keeperDayAvg = execDay(avg(a.ordersPerDay)) + liqDay(avg(a.liquidationsPerDay)) + pythExec(avg(a.ordersPerDay));
  const keeperTarget =
    (execDay(busiest(a.ordersPerDay)) + pythExec(busiest(a.ordersPerDay))) * BigInt(Math.round(a.executionFloatDays * 1_000)) / BigInt(1_000) +
    (liqDay(busiest(a.liquidationsPerDay)) * BigInt(Math.round(a.days * 1_000))) / BigInt(1_000);
  const intervalDay = a.pushMode === "interval" ? wei(a.intervalPushesPerDay * gas.pythPush, a) : BigInt(0);
  const opsDay = wei(a.markets * a.fundingUpdatesPerDay * gas.updateFunding, a) + intervalDay;
  const withFloor = (t: bigint) => {
    const v = scale(t, a.safety);
    return v > floor ? v : floor;
  };
  const rows: BudgetRow[] = [
    {
      role: "deployer",
      perDay: BigInt(0),
      target: withFloor(scale(wei(gas.deploy + 250_000, a), 1.3)),
      why: `one DeployProd run ≈ ${(gas.deploy / 1e6).toFixed(1)}M gas limit (+ Pyth refresh) × forge's 1.3 estimate margin; sweep the rest after deploy`,
    },
    {
      role: "guardian",
      perDay: BigInt(0),
      target: withFloor(wei(gas.pause * 4, a)),
      why: `pause() ≈ ${(gas.pause / 1e3).toFixed(0)}k gas; the floor keeps it able to act`,
    },
    {
      role: "ops",
      perDay: opsDay,
      target: withFloor((opsDay * BigInt(Math.round(a.days * 1_000))) / BigInt(1_000)),
      why:
        `${a.markets} markets × ${a.fundingUpdatesPerDay.toFixed(0)} funding updates/day × ${(gas.updateFunding / 1e3).toFixed(0)}k gas for ${a.days} days` +
        (a.pushMode === "interval" ? ` + interval Pyth pushes ${a.intervalPushesPerDay}/day × ${(gas.pythPush / 1e3).toFixed(0)}k gas` : ""),
    },
  ];
  for (let i = 0; i < LANES; i++) {
    rows.push({
      role: `keeper[${i}]`,
      perDay: keeperDayAvg,
      target: withFloor(keeperTarget),
      why:
        `busiest lane (${a.laneSkew}× average): ${busiest(a.ordersPerDay).toFixed(0)} executions/day × ${(gas.executeOrder / 1e3).toFixed(0)}k gas ` +
        `(+ ${a.otherLegs === "append" ? "appended other-leg updates" : "on-demand Pyth pushes"} ${(pushPerOrder / 1e3).toFixed(0)}k/order avg) floated ${a.executionFloatDays} days ` +
        `(users' execution fees pay them back) + ${busiest(a.liquidationsPerDay).toFixed(1)} liquidations/day × ${(liqGas / 1e3).toFixed(0)}k gas for ${a.days} days`,
    });
  }
  const total = rows.reduce((s, r) => s + r.target, BigInt(0));
  const perDayTotal = rows.reduce((s, r) => s + r.perDay, BigInt(0));
  const periodGross = (perDayTotal * BigInt(Math.round(a.days * 1_000))) / BigInt(1_000) + wei(gas.deploy + 250_000, a);
  const fees = a.executionFeeWei * BigInt(Math.round(a.ordersPerDay * a.days));
  const periodNet = periodGross - fees;
  return { rows, total, perDayTotal, periodGross, periodNet };
}

export function printAssumptions(gas: GasTable, a: Activity): void {
  const gwei = Number(a.gasPriceWei) / 1e9;
  console.log(`budget: gas ${gas.source}`);
  console.log(
    `        ${a.days} days (executions floated ${a.executionFloatDays} days) · gas price ${gwei.toFixed(1)} gwei (billed on gas LIMIT) · ${a.ordersPerDay} orders/day · ` +
      `${a.liquidationsPerDay} liquidations/day (${Math.round(a.expireShare * 100)}% expire) · lane skew ${a.laneSkew}× · ` +
      `${a.markets} markets × ${a.fundingUpdatesPerDay.toFixed(1)} funding updates/day · Pyth fee ${formatEther(a.pythFeeWei)} MON/update · safety ×${a.safety}`,
  );
  console.log(
    `        per-op gas limits: execute ${k(gas.executeOrder)} · funding ${k(gas.updateFunding)} · start ${k(gas.startAuction)} · ` +
      `take ${k(gas.backstopTake)} · expire ${k(gas.expire)} · cancel ${k(gas.cancelAuction)} · pause ${k(gas.pause)} · Pyth push ${k(gas.pythPush)} · deploy ${(gas.deploy / 1e6).toFixed(2)}M`,
  );
  console.log(
    `        multi-leg executions (${Math.round(a.multiLegShare * 100)}%): ${a.otherLegs === "append" ? `appended update ≈ ${(a.appendGas / 1e3).toFixed(0)}k gas each (v3)` : `on-demand push × ${Math.round(a.storedStaleShare * 100)}% stale-storage odds (v2)`}` +
      ` · Pyth push mode ${a.pushMode}${a.pushMode === "interval" ? ` (${a.intervalPushesPerDay} pushes/day)` : ""}`,
  );
  console.log("        override with BUDGET_ORDERS_PER_DAY, BUDGET_LIQUIDATIONS_PER_DAY, FUND_DAYS, BUDGET_EXECUTION_FLOAT_DAYS, BUDGET_SAFETY, … (docs/RUNBOOK.md)");
  if (a.pythFeeWei > BigInt(0)) {
    console.log(
      `        Pyth charges ${formatEther(a.pythFeeWei)} MON per update here, so keeper txs carry VALUE: Monad's reserve-balance rule lets a key below 10 MON send such a tx only as its first in 3 blocks.` +
        "\n        The keeper spaces them for you (MONAD_RESERVE_GUARD); keys holding ≥ 10 MON skip the spacing. The targets below do NOT include that 10 MON reserve.",
    );
  }
}

function k(n: number) {
  return `${(n / 1e3).toFixed(0)}k`;
}
