// Shapes of the arena keeper's HTTP API (keeper/src/arena.ts, keeper/src/server.ts). The arena page
// reads only these endpoints; it never touches the app's chain-mode store. AUSD amounts are raw
// 6-decimal integers as strings.

import type { RunReport, XrayReport } from "@/lib/chain/keeper";

export type { RunReport, XrayReport };

export type ArenaState = "starting" | "seeding" | "ready" | "crashing" | "resolving" | "xray" | "recovering" | "error";

export type AccountState = "healthy" | "underwater" | "auction" | "backstop" | "external" | "cured" | "expired";

export type DesignName = "paraclr-lanes" | "naive-shared";

export interface ArenaAccount {
  account: `0x${string}`;
  lane: number;
  state: AccountState;
  profile: "healthy" | "underwater" | "deep" | "cure";
  /** Live discount while in auction; the take discount once taken. */
  discountBps: number | null;
  startBlock: number | null;
  resolvedBlock: number | null;
  equity: string | null;
  notional: string | null;
  residual: string | null;
  badDebt: string | null;
  /** What a classic fixed-penalty liquidation would take: min(max(equity, 0), notional × fee). */
  fixedPenalty: string | null;
  txHash: `0x${string}` | null;
}

export interface ArenaDesign {
  design: DesignName;
  label: "paraclr" | "naive";
  contract: `0x${string}`;
  params: { stepBps: number; maxBps: number; minDiscountBps: number[]; feeBps: number };
  counts: Record<AccountState, number>;
  others: { started: number; resolved: number; accountsInLanes: number };
  lanes: Array<{ lane: number; registered: number; accounts: ArenaAccount[] }>;
}

export interface ArenaAuctionsSummary {
  started: number;
  takenByBackstop: number;
  takenExternal: number;
  cured: number;
  expired: number;
  avgDiscountBps: number;
  traderResidualReturned: string;
  backstopPaid: string;
  badDebt: string;
  legacyCounterfactual: { traderLoss: string };
  traderEquityAtStart: string;
}

export interface ArenaLastRun {
  cycle: number;
  runId: string;
  status: "running" | "done" | "failed";
  error: string | null;
  startedAt: number;
  finishedAt: number;
  shockBlock: number | null;
  lastBlock: number;
  blocksToResolve: Record<DesignName, number | null>;
  naive: {
    auctions: ArenaAuctionsSummary;
    underwater: { maxBlocks: number; p50Blocks: number; p95Blocks: number; accounts: number };
    vsLegacy: { worse: number; equal: number; better: number; worstExtra: string };
    unresolved: number;
  } | null;
  xrayId: string | null;
  xrayError: string | null;
  recoverTxHash: `0x${string}` | null;
}

export interface ArenaFeedTx {
  at: number;
  block: number | null;
  design: DesignName | null;
  lane: number | null;
  kind: string;
  txHash: `0x${string}`;
  status: "pending" | "success" | "reverted" | "lost";
}

export interface ArenaView {
  state: ArenaState;
  stateSince: number;
  now: number;
  chainId: number;
  network: "anvil" | "monad-testnet";
  explorer: string | null;
  canCrash: boolean;
  reason: { code: string; message: string } | null;
  cooldownRemainingS: number;
  cooldownS: number;
  lastError: string | null;
  cycles: number;
  shockBps: number;
  head: number | null;
  current: { runId: string; startedAt: number; shockBlock: number | null; cycle: number | null } | null;
  last: ArenaLastRun | null;
  book: { seed: number | null; perLane: number; cure: boolean; designs: ArenaDesign[] };
  feed: ArenaFeedTx[];
  budget: {
    daily: { used: number; max: number; day: string };
    refuelling: boolean;
  };
  limits: { cooldownS: number; perIpWindowS: number; dailyMax: number };
}

/** GET /sweeper → recent[] (keeper/src/server.ts sweepTxJson). */
export interface SweepTxJson {
  design: DesignName;
  lane: number;
  kind: string;
  accounts: number;
  txHash: `0x${string}`;
  block: number | null;
  status: "pending" | "success" | "reverted" | "lost";
  submittedAt: number;
}

export interface SolvencyJson {
  block?: number;
  surplus?: string;
  solvent?: boolean;
}
