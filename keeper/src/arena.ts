// Arena mode — `npm run keeper -- --arena` (or ARENA=1): the demo keeper as a public, self-running
// flash-crash exhibit for the /arena page. Anyone can press "Crash the market"; everyone watching sees
// the same run.
//
// Cycle state machine (one cycle = one crash):
//
//   seeding → ready → crashing → resolving → xray → recovering → seeding → ready …
//
//   seeding     a fresh small book (ARENA_PER_LANE accounts in each of the 8 lanes, new PRNG seed per
//               cycle, identical in both designs) + backstop pools topped up when they run low;
//   ready       waiting for POST /arena/crash (global cooldown after each cycle, per-IP limit, daily
//               cap, gas guard);
//   crashing    the existing crash runner (crash.ts) pauses prices and sends ONE MockOracle.shockPrices;
//   resolving   the sweeper drives the per-block Dutch auctions of both designs to resolution;
//   xray        the Conflict X-ray of both designs' resolution txs is computed;
//   recovering  the pre-crash prices are restored (one setPrices tx).
//
// Prices are HELD between crashes in arena mode (no random-walk price loop): the book is sized
// against the baseline price, so a −20% shock always leaves most accounts underwater and a few
// healthy, and accounts left over from earlier cycles stay healthy. The baseline is persisted in
// ARENA_STATE_FILE so a restart neither forgets it nor re-seeds a book that was never crashed.
//
// Everything is demo-stack only: MockOracle shock, MockAUSD test funds, synthetic keyless accounts.

import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  getAddress,
  keccak256,
  maxUint256,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { abis, readOraclePrices, type DesignName, type DesignRef, type KeeperContext, type MarketRef } from "./context";
import { BusyError, fetchAuctionEvents, summarizeAuctions, type CrashController, type RunReport } from "./crash";
import { envInt, envStr, REPO_ROOT, sleep } from "./env";
import { keeperForLane, LANE_COUNT } from "./network";
import { fundBackstopPools, rng, seedBook, type SeedAccount } from "./seed";
import { estimateLimit, waitForReceipt } from "./sender";
import { decodeAuctionEvents, type Capture, type Sweeper } from "./sweeper";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ArenaConfig {
  /** Global cooldown after a cycle finishes (back to ready) before the next crash. */
  cooldownMs: number;
  /** Per-IP: one crash per this window. */
  ipWindowMs: number;
  /** Cycles per UTC day. */
  dailyMax: number;
  /** Use the first X-Forwarded-For hop as the client IP (only behind a trusted proxy). */
  trustProxy: boolean;
  /** x-admin-token for /crash, /recover, /price-loop, POST /demo-takers, /faucet (null = locked). */
  adminToken: string | null;
  perLane: number;
  /** Shock multiplier in bps (8000 = −20%). */
  bps: number;
  /** Gas guard thresholds (wei); null = derived from the last measured cycle. */
  minOperatorWei: bigint | null;
  minKeeperWei: bigint | null;
  /** After each cycle, lane keepers below this are topped back up to it from the operator (0 = off). */
  keeperRefillWei: bigint;
  /** Backstop cash target per lane pool (AUSD 6dp); topped up when a pool falls below half. */
  backstopCash: bigint;
  /** Top up one account per cycle mid-auction so it is cured (operator-funded demo top-up). */
  cure: boolean;
  /** Live account tracker poll interval. */
  pollMs: number;
  stateFile: string;
  /** Reference gas price for the MON estimate on a chain that isn't Monad (Monad: min base fee 100 + 2 tip). */
  refGasPriceWei: bigint;
  /** Back-off before retrying after a failed recover / seed. */
  retryMs: number;
}

function envMon(name: string): bigint | null {
  const v = envStr(name);
  if (v === undefined) return null;
  try {
    return parseEther(v);
  } catch {
    throw new Error(`${name} must be an amount of MON (e.g. 0.5), got "${v}"`);
  }
}

export function arenaEnabled(cli: Record<string, string | true>): boolean {
  if (cli.arena === true || cli.arena === "1" || cli.arena === "true") return true;
  const v = (envStr("ARENA") ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

export function loadArenaConfig(ctx: KeeperContext): ArenaConfig {
  const monad = ctx.info.network === "monad-testnet";
  const bps = envInt("ARENA_BPS", 8_000);
  if (bps < 1_000 || bps >= 10_000) throw new Error("ARENA_BPS must be in [1000, 9999] (8000 = −20%)");
  const perLane = envInt("ARENA_PER_LANE", 3);
  if (perLane < 1 || perLane > 20) throw new Error("ARENA_PER_LANE must be in [1, 20]");
  return {
    cooldownMs: Math.max(0, envInt("ARENA_COOLDOWN_S", 180)) * 1000,
    ipWindowMs: Math.max(0, envInt("ARENA_IP_WINDOW_S", 600)) * 1000,
    dailyMax: Math.max(1, envInt("ARENA_DAILY_MAX", 40)),
    trustProxy: envStr("ARENA_TRUST_PROXY") === "1",
    adminToken: envStr("ARENA_ADMIN_TOKEN") ?? null,
    perLane,
    bps,
    minOperatorWei: envMon("ARENA_MIN_OPERATOR_MON"),
    minKeeperWei: envMon("ARENA_MIN_KEEPER_MON"),
    keeperRefillWei: envMon("ARENA_KEEPER_REFILL_MON") ?? (monad ? parseEther("0.7") : BigInt(0)),
    backstopCash: BigInt(Math.max(1, envInt("ARENA_BACKSTOP_CASH", 500_000))) * BigInt(1e6),
    cure: (envStr("ARENA_CURE") ?? "1") !== "0",
    pollMs: Math.max(100, envInt("ARENA_POLL_MS", monad ? 500 : 250)),
    stateFile: envStr("ARENA_STATE_FILE") ?? join(REPO_ROOT, "keeper", ".arena", `${ctx.info.chainId}-${ctx.dep.clearinghouse.toLowerCase()}.json`),
    refGasPriceWei: BigInt(Math.max(1, envInt("ARENA_REF_GAS_GWEI", 102))) * BigInt(1e9),
    retryMs: Math.max(5_000, envInt("ARENA_RETRY_S", 30) * 1000),
  };
}

// ---------------------------------------------------------------------------
// Book: ARENA_PER_LANE accounts in every lane, sized against the shock
// ---------------------------------------------------------------------------

/**
 *   healthy     2–7x long (equity ≥ 6% of the shocked notional) or a short (gains on the crash);
 *   underwater  5–12x long, equity after the shock 0.9–2.3% of notional: below the 2.5% maintenance
 *               margin but positive, so a take at the pool's minimum discount leaves the trader a residual;
 *   deep        10–15x long, equity after the shock −1.5% … +0.5%: the lane funds a shortfall;
 *   cure        an underwater account the arena tops up mid-auction (operator-funded), so it is cured.
 */
export type ArenaProfile = "healthy" | "underwater" | "deep" | "cure";

export interface ArenaSeedAccount extends SeedAccount {
  lane: number;
  profile: ArenaProfile;
  /** Designed equity after the shock, bps of the shocked notional (null: short). */
  targetEquityBps: number | null;
}

const MARKET_MIX: Record<string, number> = { "MON/AUSD": 0.45, "SOL/AUSD": 0.3, "BTC/AUSD": 0.25 };

/** Keyless synthetic address: last 20 bytes of keccak("paraclr-arena", seed, i). */
export function arenaAddress(seed: number, i: number): Address {
  const h = keccak256(
    encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "uint256" }], ["paraclr-arena", BigInt(seed), BigInt(i)]),
  );
  return getAddress(`0x${h.slice(26)}`);
}

export function generateArenaBook(markets: MarketRef[], seed: number, perLane: number, shockBps: number, cure = true): ArenaSeedAccount[] {
  const rand = rng(seed);
  const weights = markets.map((m) => MARKET_MIX[m.symbol] ?? 0.1);
  const total = weights.reduce((s, w) => s + w, 0);
  const pick = () => {
    let r = rand() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return weights.length - 1;
  };
  const drop = BigInt(10_000 - shockBps); // 2000
  const keep = BigInt(shockBps); // 8000
  const lanes: ArenaSeedAccount[][] = Array.from({ length: LANE_COUNT }, () => []);
  let cureLeft = cure ? 1 : 0;
  for (let i = 0; lanes.some((l) => l.length < perLane) && i < 100_000; i++) {
    const account = arenaAddress(seed, i);
    const lane = Number(BigInt(account) % BigInt(LANE_COUNT));
    if (lanes[lane].length >= perLane) continue;
    const r = rand();
    let profile: ArenaProfile = r < 0.2 ? "healthy" : r < 0.33 ? "deep" : "underwater";
    if (profile === "underwater" && cureLeft > 0) {
      profile = "cure";
      cureLeft--;
    }
    const mi = pick();
    const margin = BigInt(Math.round(Math.pow(10, 2 + 1.2 * rand()))); // 100 … ~1,585 AUSD
    let isLong = true;
    let leverage: number;
    let eBps: number | null;
    if (profile === "healthy") {
      isLong = rand() < 0.6;
      leverage = 2 + Math.floor(rand() * 6);
      eBps = isLong ? 600 + Math.floor(rand() * 1_800) : null;
    } else if (profile === "deep") {
      leverage = 10 + Math.floor(rand() * 6);
      eBps = -150 + Math.floor(rand() * 200);
    } else {
      leverage = 5 + Math.floor(rand() * 8);
      eBps = 90 + Math.floor(rand() * 140);
    }
    const notional = margin * BigInt(leverage); // AUSD, at entry
    let collateral: bigint; // 6dp
    if (eBps === null) {
      collateral = (margin * BigInt(Math.round((1.1 + rand()) * 1e6)));
    } else {
      // Long: equity after the shock = C − drop·N; aim it at e·keep·N (bps² → /1e8, AUSD → ×1e6).
      collateral = (notional * (drop * BigInt(10_000) + keep * BigInt(eBps)) * BigInt(1e6)) / BigInt(1e8);
    }
    const minCollateral = margin * BigInt(1e6); // initial margin check at open
    if (collateral < minCollateral) collateral = minCollateral;
    lanes[lane].push({
      account,
      lane,
      profile,
      targetEquityBps: eBps,
      collateral,
      positions: [{ marketId: markets[mi].id, isLong, margin: margin * BigInt(1e6), leverage: BigInt(leverage) }],
    });
  }
  return lanes.flat();
}

// ---------------------------------------------------------------------------
// Live account states (from the designs' auction events)
// ---------------------------------------------------------------------------

export type AccountState = "healthy" | "underwater" | "auction" | "backstop" | "external" | "cured" | "expired";

interface Tracked {
  account: Address;
  lane: number;
  profile: ArenaProfile;
  state: AccountState;
  startBlock: number | null;
  /** Take discount (resolved) — the live one is computed from the block clock in the view. */
  discountBps: number | null;
  resolvedBlock: number | null;
  equity: bigint | null;
  notional: bigint | null;
  residual: bigint | null;
  badDebt: bigint | null;
  /** The classic fixed-penalty liquidation: min(max(equity, 0), notional × LIQUIDATION_FEE_BPS). */
  fixedPenalty: bigint | null;
  txHash: Hex | null;
}

interface DesignBook {
  ref: DesignRef;
  accounts: Map<string, Tracked>;
  /** Accounts registered in each lane (this book + earlier ones), read after seeding. */
  laneCounts: number[];
  /** Auctions of accounts NOT in this book seen during the run (left over from earlier runs). */
  others: { started: number; resolved: number };
  params: { stepBps: number; maxBps: number; minDiscountBps: number[]; feeBps: number };
}

// ---------------------------------------------------------------------------
// Gas ledger: what one cycle costs
// ---------------------------------------------------------------------------

type CostPhase = "prices" | "seed" | "backstop" | "crash" | "sweep" | "cure" | "recover";
type CostRole = "operator" | "keeper" | "taker";

interface LedgerTx {
  hash: Hex;
  phase: CostPhase;
  role: CostRole;
  /** Sender, when known up front (sweeper txs). */
  from?: Address;
  gasUsed?: bigint;
  gasLimit?: bigint;
  gasPrice?: bigint;
}

interface CycleRecord {
  n: number;
  seed: number;
  /** False when the book was seeded by an earlier process (its seeding cost is unknown). */
  seedMeasured: boolean;
  ledger: LedgerTx[];
  /**
   * seedMs: seeding the book · shockMs: crash request → shock receipt · resolveMs: shock → every
   * auction resolved · xrayMs: X-ray · recoverMs: recover tx · runMs: crash request → prices
   * recovered · cycleMs: seeding start → prices recovered (includes the wait in "ready").
   */
  timings: Partial<Record<"seedMs" | "shockMs" | "resolveMs" | "xrayMs" | "recoverMs" | "runMs" | "cycleMs", number>>;
  crashAt?: number;
  seedStartedAt: number;
}

export interface CycleCost {
  cycle: number;
  complete: boolean;
  txs: number;
  gasUsed: string;
  gasLimit: string;
  /** What this chain charged (Monad bills the gas LIMIT; anvil the gas used), wei. */
  paidWei: string;
  /** Σ gasLimit × gas price: the Monad testnet bill, at the live price on Monad, at refGasPriceGwei elsewhere. */
  monadEstimateWei: string;
  monadEstimateMon: string;
  gasPriceGwei: number;
  byPhase: Record<string, { txs: number; gasUsed: string; gasLimit: string }>;
  byRole: Record<string, { txs: number; gasLimit: string; monadEstimateMon: string }>;
  timings: CycleRecord["timings"];
}

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

interface Persisted {
  chainId: number;
  clearinghouse: string;
  baseline: Record<string, string> | null;
  cycles: number;
  day: string;
  dayCount: number;
  /** The book on chain that has not been crashed yet (reused after a restart). */
  book: { seed: number; perLane: number; bps: number; crashed: boolean } | null;
  lastCost: CycleCost | null;
}

export type ArenaState = "starting" | "seeding" | "ready" | "crashing" | "resolving" | "xray" | "recovering" | "error";

export class ArenaRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

interface FeedTx {
  at: number;
  block: number | null;
  design: DesignName | null;
  lane: number | null;
  kind: string;
  txHash: Hex;
  status: "pending" | "success" | "reverted";
}

interface LastRun {
  cycle: number;
  runId: string;
  status: RunReport["status"];
  error: string | null;
  startedAt: number;
  finishedAt: number;
  shockBlock: number | null;
  lastBlock: number;
  blocksToResolve: Record<DesignName, number | null>;
  /** The naive design's outcome: the same events-based summary as the RunReport (bench/run.ts). */
  naive: {
    auctions: ReturnType<typeof summarizeAuctions>["auctions"];
    underwater: { maxBlocks: number; p50Blocks: number; p95Blocks: number; accounts: number };
    vsLegacy: ReturnType<typeof summarizeAuctions>["vsLegacy"];
    unresolved: number;
  } | null;
  xrayId: string | null;
  xrayError: string | null;
  recoverTxHash: Hex | null;
}

const BOOK_DAY = () => new Date().toISOString().slice(0, 10);
const LIVE: ArenaState[] = ["crashing", "resolving", "xray"];

export class Arena {
  state: ArenaState = "starting";
  private stateSince = Date.now();
  private lastError: string | null = null;
  private persisted: Persisted;
  private book: ArenaSeedAccount[] = [];
  private bookSeed: number | null = null;
  private books = new Map<DesignName, DesignBook>();
  private cycle: CycleRecord | null = null;
  private readyAt: number | null = null;
  private readonly ipLast = new Map<string, number>();
  private current: { runId: string; startedAt: number; shockBlock: number | null; capture: Capture } | null = null;
  private last: LastRun | null = null;
  private head: number | null = null;
  private logFrom = 0;
  private feed: FeedTx[] = [];
  private balances: { at: number; operator: bigint; keepers: Array<{ lane: number; address: Address; balance: bigint }> } | null = null;
  private balancesLoading: Promise<void> | null = null;
  private cured = new Set<string>();
  private headAt = 0;
  private headLoading: Promise<void> | null = null;
  private readonly designs: DesignRef[];

  constructor(
    private readonly ctx: KeeperContext,
    private readonly crash: CrashController,
    private readonly sweeper: Sweeper,
    readonly config: ArenaConfig = loadArenaConfig(ctx),
    private readonly log: (m: string) => void = (m) => console.log(`[arena] ${m}`),
  ) {
    this.designs = ctx.designs.filter((d) => d.label === "paraclr" || ctx.config.sweepNaive !== "off");
    this.persisted = this.load();
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private load(): Persisted {
    const fresh: Persisted = {
      chainId: this.ctx.info.chainId,
      clearinghouse: this.ctx.dep.clearinghouse.toLowerCase(),
      baseline: null,
      cycles: 0,
      day: BOOK_DAY(),
      dayCount: 0,
      book: null,
      lastCost: null,
    };
    try {
      if (!existsSync(this.config.stateFile)) return fresh;
      const raw = JSON.parse(readFileSync(this.config.stateFile, "utf8")) as Persisted;
      if (raw.chainId !== fresh.chainId || raw.clearinghouse !== fresh.clearinghouse) return fresh;
      return { ...fresh, ...raw };
    } catch {
      return fresh;
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.config.stateFile), { recursive: true });
      writeFileSync(this.config.stateFile, JSON.stringify(this.persisted, null, 2) + "\n");
    } catch (err) {
      this.log(`could not write ${this.config.stateFile}: ${(err as Error).message}`);
    }
  }

  private setState(s: ArenaState): void {
    if (s !== this.state) this.log(`state ${this.state} → ${s}`);
    this.state = s;
    this.stateSince = Date.now();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Runs in the background: baseline prices, then the first book. */
  start(): void {
    void this.boot();
  }

  private async boot(): Promise<void> {
    for (;;) {
      try {
        await this.readParams();
        // Waiting for gas costs nothing: no baseline refresh (an operator tx) until the wallets
        // can afford a cycle.
        await this.refreshBalances(true);
        if (this.refuelling()) throw new Error("Arena is refuelling: waiting for the keeper wallets to be topped up");
        await this.ensureBaseline();
        await this.prepareBook();
        this.toReady(false);
        return;
      } catch (err) {
        this.fail("start", err);
        await sleep(this.config.retryMs);
      }
    }
  }

  private fail(what: string, err: unknown): void {
    this.lastError = `${what}: ${(err as Error)?.message?.split("\n")[0] ?? String(err)}`;
    this.log(`ERROR ${this.lastError}`);
    this.setState("error");
  }

  private toReady(cooldown: boolean): void {
    this.readyAt = cooldown ? Date.now() : Date.now() - this.config.cooldownMs;
    this.lastError = null;
    this.setState("ready");
  }

  private async readParams(): Promise<void> {
    const { client } = this.ctx;
    for (const d of this.designs) {
      const read = (functionName: string, args: unknown[] = []) =>
        client
          .readContract({ address: d.address, abi: abis.clearinghouse as never, functionName: functionName as never, args: args as never })
          .then((v) => Number(v as bigint));
      const [stepBps, maxBps, feeBps, ...mins] = await Promise.all([
        read("auctionStepBps"),
        read("auctionMaxDiscountBps"),
        read("LIQUIDATION_FEE_BPS").catch(() => 100),
        ...Array.from({ length: LANE_COUNT }, (_, lane) => read("backstopMinDiscountBps", [lane])),
      ]);
      const prev = this.books.get(d.design);
      this.books.set(d.design, {
        ref: d,
        accounts: prev?.accounts ?? new Map(),
        laneCounts: prev?.laneCounts ?? Array(LANE_COUNT).fill(0),
        others: prev?.others ?? { started: 0, resolved: 0 },
        params: { stepBps, maxBps, minDiscountBps: mins, feeBps },
      });
    }
  }

  /** Remember the price every book is sized against; restore it if the chain drifted or went stale. */
  private async ensureBaseline(): Promise<void> {
    const now = await readOraclePrices(this.ctx);
    if (!this.persisted.baseline) {
      this.persisted.baseline = Object.fromEntries(Object.entries(now).map(([s, p]) => [s, p.price.toString()]));
      this.save();
      this.log(`baseline prices: ${Object.entries(now).map(([s, p]) => `${s} ${Number(p.price) / 1e18}`).join(" · ")}`);
    }
    const base = this.persisted.baseline;
    const ageS = Math.floor(Date.now() / 1000) - Math.min(...Object.values(now).map((p) => p.updatedAt));
    const drifted = this.ctx.markets.some((m) => now[m.symbol]?.price.toString() !== base[m.symbol]);
    if (drifted || ageS > 30 * 60) {
      const hash = await this.operatorTx(this.ctx.dep.oracle, encodeFunctionData({
        abi: abis.oracle,
        functionName: "setPrices",
        args: [this.ctx.markets.map((m) => m.id), this.ctx.markets.map((m) => BigInt(base[m.symbol] ?? "0"))],
      }));
      this.cycleLedger({ hash, phase: "prices", role: "operator" });
      this.pushFeed({ kind: "setPrices", txHash: hash, design: null, lane: null, block: null, status: "success" });
      this.log(`prices ${drifted ? "restored to the baseline" : "refreshed (stale)"} (${hash})`);
    }
  }

  private cycleLedger(tx: LedgerTx): void {
    if (!this.cycle) this.cycle = { n: this.persisted.cycles + 1, seed: this.bookSeed ?? 0, seedMeasured: false, ledger: [], timings: {}, seedStartedAt: Date.now() };
    this.cycle.ledger.push(tx);
  }

  /** One operator tx, mined, or throw. */
  private async operatorTx(to: Address, data: Hex): Promise<Hex> {
    return (await this.operatorTxMined(to, data)).hash;
  }

  private async operatorTxMined(to: Address, data: Hex): Promise<{ hash: Hex; block: number }> {
    const { client, config } = this.ctx;
    const op = this.ctx.senders.for(this.ctx.roles.operator);
    const { limit } = await estimateLimit(client, { account: op.address, to, data }, config.gasMarginBps);
    const sub = await op.send({ to, data, gas: limit });
    const { receipt } = await waitForReceipt(client, sub.hash, { pollMs: Math.max(config.receiptPollMs, 100), timeoutMs: config.receiptTimeoutMs });
    if (receipt.status !== "success") throw new Error(`tx ${sub.hash} reverted`);
    return { hash: sub.hash, block: Number(receipt.blockNumber) };
  }

  /**
   * Top the lane keepers back up to keeperRefillWei from the operator, so a cycle's sweeper gas
   * doesn't leave the arena "refuelling" while the operator still has MON. Monad's reserve-balance
   * rule: below 10 MON a value transfer must be the sender's first tx in 3 blocks, so each transfer
   * waits 3 blocks after the previous one.
   */
  private async refillKeepers(): Promise<void> {
    const target = this.config.keeperRefillWei;
    if (target <= BigInt(0)) return;
    const { client, config } = this.ctx;
    const op = this.ctx.senders.for(this.ctx.roles.operator);
    let lastBlock: bigint | null = null;
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const to = keeperForLane(this.ctx.roles, lane).address;
      const bal = await client.getBalance({ address: to });
      if (bal >= target) continue;
      const opBal = await client.getBalance({ address: op.address });
      const need = target - bal;
      if (opBal < need + this.thresholds().operator) {
        this.log(`keeper refill stopped: the operator has ${formatEther(opBal)} MON`);
        return;
      }
      if (lastBlock !== null) while ((await client.getBlockNumber()) < lastBlock + BigInt(3)) await sleep(150);
      const sub = await op.send({ to, value: need, gas: BigInt(21_000) });
      const { receipt } = await waitForReceipt(client, sub.hash, { pollMs: Math.max(config.receiptPollMs, 100), timeoutMs: config.receiptTimeoutMs });
      if (receipt.status !== "success") throw new Error(`keeper refill ${sub.hash} reverted`);
      lastBlock = receipt.blockNumber;
      this.log(`refilled lane ${lane} keeper +${formatEther(need)} MON`);
    }
  }

  /** Reuse the uncrashed book of a previous process, else seed a new one. */
  private async prepareBook(): Promise<void> {
    const p = this.persisted.book;
    if (p && !p.crashed && p.perLane === this.config.perLane && p.bps === this.config.bps) {
      const book = generateArenaBook(this.ctx.markets, p.seed, p.perLane, p.bps, this.config.cure);
      if (await this.bookIsLive(book)) {
        this.installBook(p.seed, book);
        await this.readLaneCounts();
        this.cycle = { n: this.persisted.cycles + 1, seed: p.seed, seedMeasured: false, ledger: this.cycle?.ledger ?? [], timings: {}, seedStartedAt: Date.now() };
        this.log(`reusing the uncrashed book of seed ${p.seed} (${book.length} accounts per design)`);
        return;
      }
    }
    await this.seedCycle();
  }

  private async bookIsLive(book: ArenaSeedAccount[]): Promise<boolean> {
    const probe = book.filter((_, i) => i % Math.max(1, Math.floor(book.length / 4)) === 0);
    const rows = await Promise.all(
      this.designs.flatMap((d) =>
        probe.map((a) =>
          this.ctx.client.readContract({ address: d.address, abi: abis.clearinghouse, functionName: "getAccount", args: [a.account] }),
        ),
      ),
    );
    const auctions = await Promise.all(
      this.designs.flatMap((d) =>
        probe.map((a) => this.ctx.client.readContract({ address: d.address, abi: abis.clearinghouse, functionName: "auctionOf", args: [a.account] })),
      ),
    );
    return rows.every(([, , registered, open]) => registered && open.length > 0) && auctions.every(([active]) => !active);
  }

  private installBook(seed: number, book: ArenaSeedAccount[]): void {
    this.book = book;
    this.bookSeed = seed;
    this.cured.clear();
    for (const b of this.books.values()) {
      b.accounts = new Map(
        book.map((a) => [
          a.account.toLowerCase(),
          {
            account: a.account,
            lane: a.lane,
            profile: a.profile,
            state: "healthy" as AccountState,
            startBlock: null,
            discountBps: null,
            resolvedBlock: null,
            equity: null,
            notional: null,
            residual: null,
            badDebt: null,
            fixedPenalty: null,
            txHash: null,
          },
        ]),
      );
      b.others = { started: 0, resolved: 0 };
    }
  }

  private async readLaneCounts(): Promise<void> {
    for (const b of this.books.values()) {
      b.laneCounts = (
        await Promise.all(
          Array.from({ length: LANE_COUNT }, (_, lane) =>
            this.ctx.client.readContract({ address: b.ref.address, abi: abis.clearinghouse, functionName: "laneAccountCount", args: [lane] }),
          ),
        )
      ).map(Number);
    }
  }

  /** Mint + approve once for everything the operator will move this cycle (seeding, pools, cure). */
  private async ensureAusd(need: bigint): Promise<void> {
    const { client, dep } = this.ctx;
    const op = this.ctx.roles.operator.address;
    const bal = await client.readContract({ address: dep.ausd, abi: abis.ausd, functionName: "balanceOf", args: [op] });
    if (bal < need) {
      const hash = await this.operatorTx(dep.ausd, encodeFunctionData({ abi: abis.ausd, functionName: "ownerMint", args: [op, need - bal] }));
      this.cycleLedger({ hash, phase: "seed", role: "operator" });
    }
    for (const d of this.designs) {
      const allowance = await client.readContract({ address: dep.ausd, abi: abis.ausd, functionName: "allowance", args: [op, d.address] });
      if (allowance < need) {
        const hash = await this.operatorTx(dep.ausd, encodeFunctionData({ abi: abis.ausd, functionName: "approve", args: [d.address, maxUint256] }));
        this.cycleLedger({ hash, phase: "seed", role: "operator" });
      }
    }
  }

  /** Pools below half the target get topped up to it (the naive shared pool to 8×). */
  private async poolTopUpNeed(d: DesignRef): Promise<bigint> {
    const { client } = this.ctx;
    const shared = await client.readContract({ address: d.address, abi: abis.clearinghouse, functionName: "sharedState" });
    const keys = shared ? [0] : Array.from({ length: LANE_COUNT }, (_, i) => i);
    const target = shared ? this.config.backstopCash * BigInt(LANE_COUNT) : this.config.backstopCash;
    const navs = await Promise.all(keys.map((k) => client.readContract({ address: d.address, abi: abis.clearinghouse, functionName: "backstopNav", args: [k] })));
    if (!navs.some((n) => n[1] * BigInt(2) < target)) return BigInt(0);
    return navs.reduce((s, n) => (n[1] < target ? s + (target - n[1]) : s), BigInt(0));
  }

  private async seedCycle(): Promise<void> {
    this.setState("seeding");
    await this.refreshBalances(true);
    const minOp = this.thresholds().operator;
    if (this.balances && this.balances.operator < minOp) {
      throw new Error(
        `Arena is refuelling: the operator has ${Number(formatEther(this.balances.operator)).toFixed(3)} MON, ` +
          `a cycle needs ~${Number(formatEther(minOp)).toFixed(3)} (ARENA_MIN_OPERATOR_MON)`,
      );
    }
    const t0 = Date.now();
    const seed = Date.now() % 2_147_483_647;
    const book = generateArenaBook(this.ctx.markets, seed, this.config.perLane, this.config.bps, this.config.cure);
    const prior = this.cycle && this.cycle.ledger.every((t) => t.phase === "prices") ? this.cycle.ledger : [];
    this.cycle = { n: this.persisted.cycles + 1, seed, seedMeasured: true, ledger: prior, timings: {}, seedStartedAt: t0 };
    this.persisted.book = null; // nothing reusable until this book is fully seeded
    this.save();

    const collateral = book.reduce((s, a) => s + a.collateral, BigInt(0));
    const cureNeed = book.filter((a) => a.profile === "cure").reduce((s, a) => s + this.cureAmount(a), BigInt(0));
    const poolNeeds = await Promise.all(this.designs.map((d) => this.poolTopUpNeed(d)));
    const need = (collateral + cureNeed) * BigInt(this.designs.length) + poolNeeds.reduce((s, n) => s + n, BigInt(0));
    await this.ensureAusd(need);

    for (const [i, d] of this.designs.entries()) {
      const seeded = await seedBook(this.ctx, book, (m) => this.log(`${d.label}:${m}`), d.address);
      for (const t of seeded.txs) {
        this.cycleLedger({ hash: t.txHash, phase: "seed", role: "operator", gasUsed: BigInt(t.gasUsed), gasLimit: BigInt(t.gasLimit) });
        this.pushFeed({ kind: "seedAccounts", txHash: t.txHash, design: d.design, lane: null, block: t.block, status: "success" });
      }
      if (poolNeeds[i] > BigInt(0)) {
        const funded = await fundBackstopPools(this.ctx, d.address, this.config.backstopCash, (m) => this.log(`${d.label}:${m}`));
        for (const f of funded) this.cycleLedger({ hash: f.txHash, phase: "backstop", role: "operator" });
      }
    }
    this.installBook(seed, book);
    await this.readLaneCounts();
    this.cycle.timings.seedMs = Date.now() - t0;
    this.persisted.book = { seed, perLane: this.config.perLane, bps: this.config.bps, crashed: false };
    this.save();
    const mix = (["healthy", "underwater", "deep", "cure"] as const).map((p) => `${book.filter((a) => a.profile === p).length} ${p}`).join(", ");
    this.log(`seeded book ${seed}: ${book.length} accounts per design (${mix}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  /** Enough to lift a designed-underwater account to ~5% equity at the shocked price. */
  private cureAmount(a: ArenaSeedAccount): bigint {
    const notional = a.positions.reduce((s, p) => s + p.margin * p.leverage, BigInt(0));
    return (notional * BigInt(500)) / BigInt(10_000);
  }

  // ---------------------------------------------------------------------------
  // Crash requests
  // ---------------------------------------------------------------------------

  clientIp(headers: Record<string, string | string[] | undefined>, remote: string | undefined): string {
    if (this.config.trustProxy) {
      const xff = headers["x-forwarded-for"];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
      if (first) return first;
    }
    return remote ?? "unknown";
  }

  adminOk(token: string | string[] | undefined): boolean {
    const want = this.config.adminToken;
    if (!want || typeof token !== "string") return false;
    const a = Buffer.from(token);
    const b = Buffer.from(want);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private rollDay(): void {
    const today = BOOK_DAY();
    if (this.persisted.day !== today) {
      this.persisted.day = today;
      this.persisted.dayCount = 0;
    }
  }

  cooldownRemainingMs(): number {
    if (this.state !== "ready" || this.readyAt === null) return 0;
    return Math.max(0, this.readyAt + this.config.cooldownMs - Date.now());
  }

  /** Why a crash can't start now (null = it can). */
  private refusal(ip: string | null): ArenaRefusal | null {
    this.rollDay();
    if (!LIVE.includes(this.state) && this.refuelling()) {
      return new ArenaRefusal(409, "refuelling", "Arena is refuelling: the keeper wallets are low on testnet MON.");
    }
    switch (this.state) {
      case "crashing":
      case "resolving":
      case "xray":
        return new ArenaRefusal(409, "running", "A crash is already running - watch it below.", { runId: this.current?.runId ?? null });
      case "recovering":
      case "seeding":
        return new ArenaRefusal(409, "seeding", "Restoring prices and seeding a fresh book for the next crash.");
      case "starting":
        return new ArenaRefusal(409, "starting", "The arena is starting up.");
      case "error":
        return new ArenaRefusal(409, "error", "The arena hit an error and is retrying.", { detail: this.lastError });
    }
    if (this.crash.activeRunId) return new ArenaRefusal(409, "running", "A crash is already running.", { runId: this.crash.activeRunId });
    const cd = this.cooldownRemainingMs();
    if (cd > 0) return new ArenaRefusal(409, "cooldown", `Cooling down: the next crash opens in ${Math.ceil(cd / 1000)}s.`, { retryAfterS: Math.ceil(cd / 1000) });
    if (this.persisted.dayCount >= this.config.dailyMax) {
      return new ArenaRefusal(409, "daily-cap", `Today's ${this.config.dailyMax} crashes are used up. Back tomorrow (UTC).`);
    }
    if (this.refuelling()) return new ArenaRefusal(409, "refuelling", "Arena is refuelling: the keeper wallets are low on testnet MON.");
    if (ip !== null) {
      const at = this.ipLast.get(ip);
      if (at !== undefined && Date.now() - at < this.config.ipWindowMs) {
        const s = Math.ceil((at + this.config.ipWindowMs - Date.now()) / 1000);
        return new ArenaRefusal(409, "ip-limit", `You crashed it recently: one crash per visitor every ${Math.round(this.config.ipWindowMs / 60_000)} min (${s}s left).`, { retryAfterS: s });
      }
    }
    return null;
  }

  private thresholds(): { operator: bigint; keeper: bigint } {
    const monad = this.ctx.info.network === "monad-testnet";
    const c = this.persisted.lastCost;
    // Derived: 1.5 × what the last full cycle cost the role (busiest keeper for keepers).
    const derivedOp = c?.complete ? (parseEther(c.byRole.operator?.monadEstimateMon ?? "0") * BigInt(3)) / BigInt(2) : null;
    const derivedKeeper = c?.complete && c.byRole.keeperMax ? (parseEther(c.byRole.keeperMax.monadEstimateMon) * BigInt(3)) / BigInt(2) : null;
    return {
      operator: this.config.minOperatorWei ?? derivedOp ?? (monad ? parseEther("2.5") : parseEther("1")),
      keeper: this.config.minKeeperWei ?? derivedKeeper ?? (monad ? parseEther("0.3") : parseEther("1")),
    };
  }

  private refuelling(): boolean {
    const b = this.balances;
    if (!b) return false;
    const t = this.thresholds();
    return b.operator < t.operator || b.keepers.some((k) => k.balance < t.keeper);
  }

  async refreshBalances(force = false): Promise<void> {
    if (!force && this.balances && Date.now() - this.balances.at < 20_000) return;
    if (this.balancesLoading) return this.balancesLoading;
    this.balancesLoading = (async () => {
      const lanes = Array.from({ length: LANE_COUNT }, (_, lane) => ({ lane, address: keeperForLane(this.ctx.roles, lane).address }));
      const [operator, ...keepers] = await Promise.all([
        this.ctx.client.getBalance({ address: this.ctx.roles.operator.address }),
        ...lanes.map((l) => this.ctx.client.getBalance({ address: l.address })),
      ]);
      this.balances = { at: Date.now(), operator, keepers: lanes.map((l, i) => ({ ...l, balance: keepers[i] })) };
    })().finally(() => {
      this.balancesLoading = null;
    });
    return this.balancesLoading;
  }

  /** POST /arena/crash. Returns the runId every viewer will watch. */
  async requestCrash(ip: string): Promise<{ runId: string }> {
    let r = this.refusal(ip);
    if (r) throw r;
    await this.refreshBalances(true).catch(() => undefined);
    r = this.refusal(ip);
    if (r) throw r;

    this.ipLast.set(ip, Date.now());
    for (const [k, at] of this.ipLast) if (Date.now() - at > this.config.ipWindowMs) this.ipLast.delete(k);
    this.persisted.dayCount++;
    this.save();

    this.setState("crashing");
    const capture = this.sweeper.capture();
    let started: ReturnType<CrashController["start"]>;
    try {
      started = this.crash.start({ bps: this.config.bps, mode: "auctions", xray: true });
    } catch (err) {
      capture.close();
      this.persisted.dayCount--;
      this.save();
      this.toReady(false);
      if (err instanceof BusyError) throw new ArenaRefusal(409, "running", "A crash is already running.", { runId: err.runId });
      throw err;
    }
    this.current = { runId: started.runId, startedAt: Date.now(), shockBlock: null, capture };
    if (this.cycle) this.cycle.crashAt = this.current.startedAt;
    this.log(`crash ${started.runId} started by a visitor (cycle ${this.cycle?.n ?? "?"}, ${this.persisted.dayCount}/${this.config.dailyMax} today)`);
    void this.follow(started.runId, started.done);
    return { runId: started.runId };
  }

  // ---------------------------------------------------------------------------
  // Following a run
  // ---------------------------------------------------------------------------

  private async follow(runId: string, done: Promise<RunReport>): Promise<void> {
    const cur = this.current!;
    const cycle = this.cycle!;
    const t0 = cur.startedAt;
    let finished = false;
    void done.finally(() => {
      finished = true;
    });
    const report = () => this.crash.getRun(runId);
    let resolvedAt: number | null = null;
    let shockAt: number | null = null;

    // Live tracker: phases + account states until the run (incl. X-ray) is done.
    while (!finished) {
      const r = report();
      if (r && r.shock.block !== null && cur.shockBlock === null) {
        cur.shockBlock = r.shock.block;
        shockAt = Date.now();
        cycle.timings.shockMs = shockAt - t0;
        this.pushFeed({ kind: "shockPrices", txHash: r.shock.txHash, design: null, lane: null, block: r.shock.block, status: "success" });
        this.cycleLedger({ hash: r.shock.txHash, phase: "crash", role: "operator" });
        this.logFrom = r.shock.block;
        await this.markUnderwater(r.shock.block).catch((err: unknown) => this.log(`underwater read failed: ${(err as Error).message}`));
        this.setState("resolving");
      }
      if (r?.auctions && this.state === "resolving") {
        resolvedAt = Date.now();
        if (shockAt) cycle.timings.resolveMs = resolvedAt - shockAt;
        this.setState("xray");
      }
      if (cur.shockBlock !== null) await this.pollEvents().catch((err: unknown) => this.log(`event poll failed: ${(err as Error).message}`));
      await Promise.race([sleep(this.config.pollMs), done.catch(() => undefined)]);
    }
    const final = await done;
    if (final.shock.block === null) {
      // Nothing reached the chain (e.g. the shock could not be sent): same book, back to ready.
      cur.capture.close();
      this.current = null;
      this.persisted.dayCount = Math.max(0, this.persisted.dayCount - 1);
      this.save();
      this.log(`crash ${runId} failed before the shock: ${final.error ?? "unknown error"}`);
      if (this.crash.crashed) return this.recoverAndReseed(cycle);
      this.lastError = final.error ?? null;
      this.readyAt = Date.now();
      this.setState("ready");
      return;
    }
    await this.pollEvents().catch(() => undefined);
    if (resolvedAt) cycle.timings.xrayMs = Date.now() - resolvedAt;
    const txs = cur.capture.close();
    for (const t of txs) {
      this.cycleLedger({
        hash: t.hash,
        phase: "sweep",
        role: t.kind === "take" || t.kind === "closePosition" ? "taker" : "keeper",
        from: t.keeper,
        gasUsed: t.gasUsed ?? undefined,
        gasLimit: t.gasLimit,
      });
    }
    if (this.persisted.book) this.persisted.book.crashed = true;
    this.persisted.cycles++;
    this.save();

    const lastBlock = Math.max(final.shock.block ?? 0, ...txs.map((t) => t.block ?? 0));
    const naive = await this.naiveSummary(final, lastBlock).catch((err: unknown) => {
      this.log(`naive summary failed: ${(err as Error).message}`);
      return null;
    });
    this.last = {
      cycle: cycle.n,
      runId,
      status: final.status,
      error: final.error ?? null,
      startedAt: t0,
      finishedAt: Date.now(),
      shockBlock: final.shock.block,
      lastBlock,
      blocksToResolve: {
        "paraclr-lanes": final.underwater ? final.underwater.maxBlocks : null,
        "naive-shared": naive ? naive.underwater.maxBlocks : null,
      },
      naive,
      xrayId: final.xrayId ?? null,
      xrayError: final.xrayError ?? null,
      recoverTxHash: null,
    };
    this.log(
      `crash ${runId} ${final.status}${final.error ? ` (${final.error})` : ""}: shock block ${final.shock.block}, ` +
        `resolved in ${final.underwater?.maxBlocks ?? "?"} blocks (paraclr) / ${naive?.underwater.maxBlocks ?? "?"} (naive)`,
    );
    this.current = null;
    await this.recoverAndReseed(cycle);
  }

  private async recoverAndReseed(cycle: CycleRecord): Promise<void> {
    for (;;) {
      try {
        if (this.crash.crashed) {
          this.setState("recovering");
          const t = Date.now();
          const rec = await this.crash.recover();
          cycle.timings.recoverMs = Date.now() - t;
          this.cycleLedger({ hash: rec.txHash, phase: "recover", role: "operator" });
          this.pushFeed({ kind: "recover", txHash: rec.txHash, design: null, lane: null, block: rec.block, status: "success" });
          if (this.last) this.last.recoverTxHash = rec.txHash;
        } else {
          await this.ensureBaseline();
        }
        cycle.timings.cycleMs = Date.now() - cycle.seedStartedAt;
        if (cycle.crashAt) cycle.timings.runMs = Date.now() - cycle.crashAt;
        const cost = await this.measure(cycle);
        // Keep the last fully measured cycle for the budget (a reused book's seeding is unknown).
        if (cost.complete || !this.persisted.lastCost?.complete) this.persisted.lastCost = cost;
        this.save();
        this.log(
          `cycle ${cycle.n} cost: ${cost.txs} txs, ${cost.gasUsed} gas used / ${cost.gasLimit} limit ≈ ${cost.monadEstimateMon} MON on Monad ` +
            `(${cost.gasPriceGwei} gwei, billed on limit)${cost.complete ? "" : " (seeding not measured)"}`,
        );
        this.cycle = null;
        await this.refillKeepers();
        await this.refreshBalances(true).catch(() => undefined);
        await this.seedCycle();
        this.toReady(true);
        return;
      } catch (err) {
        this.fail("recover/seed", err);
        await sleep(this.config.retryMs);
      }
    }
  }

  /** Mark book accounts that the shock made liquidatable (as of the shock block). */
  private async markUnderwater(shockBlock: number): Promise<void> {
    await Promise.all(
      [...this.books.values()].map(async (b) => {
        const accts = [...b.accounts.values()];
        const flags = await Promise.all(
          accts.map((a) =>
            this.ctx.client.readContract({
              address: b.ref.address,
              abi: abis.clearinghouse,
              functionName: "isLiquidatable",
              args: [a.account],
              blockNumber: BigInt(shockBlock),
            }),
          ),
        );
        accts.forEach((a, i) => {
          if (flags[i] && a.state === "healthy") a.state = "underwater";
        });
      }),
    );
  }

  /** Pull new auction events of both designs and apply them to the book. */
  private async pollEvents(): Promise<void> {
    const head = Number(await this.ctx.client.getBlockNumber());
    this.head = head;
    if (head < this.logFrom) return;
    const addresses = [...this.books.values()].map((b) => b.ref.address);
    const byAddr = new Map([...this.books.values()].map((b) => [b.ref.address.toLowerCase(), b]));
    for (let a = this.logFrom; a <= head; a += 100) {
      const to = Math.min(head, a + 99);
      const logs = await this.ctx.client.getLogs({ address: addresses, fromBlock: BigInt(a), toBlock: BigInt(to) });
      const events = decodeAuctionEvents(logs).sort((x, y) => Number(x.blockNumber) - Number(y.blockNumber) || x.logIndex - y.logIndex);
      for (const e of events) {
        const b = byAddr.get(e.address.toLowerCase());
        if (b) this.apply(b, e);
      }
      this.logFrom = to + 1;
    }
  }

  private apply(b: DesignBook, e: ReturnType<typeof decodeAuctionEvents>[number]): void {
    const t = b.accounts.get(e.args.account.toLowerCase());
    const block = Number(e.blockNumber);
    if (!t) {
      if (e.eventName === "AuctionStarted") b.others.started++;
      else b.others.resolved++;
      return;
    }
    switch (e.eventName) {
      case "AuctionStarted": {
        if (t.startBlock !== null) return;
        t.state = "auction";
        t.startBlock = Number(e.args.startBlock);
        t.equity = e.args.equity;
        t.notional = e.args.notional;
        const eq = e.args.equity > BigInt(0) ? e.args.equity : BigInt(0);
        const pen = (e.args.notional * BigInt(b.params.feeBps)) / BigInt(10_000);
        t.fixedPenalty = pen < eq ? pen : eq;
        if (t.profile === "cure") void this.cure(b, t);
        return;
      }
      case "AuctionTaken":
        t.state = e.args.backstop ? "backstop" : "external";
        t.discountBps = Number(e.args.discountBps);
        t.residual = e.args.traderResidual;
        t.badDebt = e.args.badDebt;
        break;
      case "AuctionCancelled":
        t.state = "cured";
        break;
      case "AuctionExpired":
        t.state = "expired";
        t.badDebt = e.args.badDebt;
        break;
    }
    t.resolvedBlock = block;
    t.txHash = e.transactionHash as Hex;
  }

  /** Operator-funded demo top-up of the "cure" account while its auction runs (same in both designs). */
  private async cure(b: DesignBook, t: Tracked): Promise<void> {
    const key = `${b.ref.design}:${t.account.toLowerCase()}`;
    if (this.cured.has(key)) return;
    this.cured.add(key);
    const seed = this.book.find((a) => a.account.toLowerCase() === t.account.toLowerCase());
    if (!seed) return;
    try {
      const data = encodeFunctionData({
        abi: abis.clearinghouse,
        functionName: "seedAccounts",
        args: [[{ account: seed.account, collateral: this.cureAmount(seed), positions: [] }]],
      });
      const { hash, block } = await this.operatorTxMined(b.ref.address, data);
      this.cycleLedger({ hash, phase: "cure", role: "operator" });
      this.pushFeed({ kind: "top-up (cure)", txHash: hash, design: b.ref.design, lane: t.lane, block, status: "success" });
    } catch (err) {
      this.log(`cure top-up on ${b.ref.label} failed: ${(err as Error).message.split("\n")[0]}`);
    }
  }

  private async naiveSummary(report: RunReport, lastBlock: number): Promise<LastRun["naive"]> {
    const naive = this.designs.find((d) => d.label === "naive");
    if (!naive || report.shock.block === null) return null;
    const b = this.books.get(naive.design);
    const events = await fetchAuctionEvents(this.ctx, naive.address, report.shock.block, lastBlock);
    const sum = summarizeAuctions(events, {
      shockBlock: report.shock.block,
      shockAt: report.shock.confirmedAt ?? report.shock.submittedAt,
      legacyFeeBps: b?.params.feeBps ?? 100,
      seenAt: () => null,
    });
    const { perAccount, ...uw } = sum.underwater;
    return {
      auctions: sum.auctions,
      underwater: { maxBlocks: uw.maxBlocks, p50Blocks: uw.p50Blocks, p95Blocks: uw.p95Blocks, accounts: perAccount.length },
      vsLegacy: sum.vsLegacy,
      unresolved: sum.unresolved,
    };
  }

  // ---------------------------------------------------------------------------
  // Cost
  // ---------------------------------------------------------------------------

  private async measure(cycle: CycleRecord): Promise<CycleCost> {
    const { client } = this.ctx;
    const monad = this.ctx.info.network === "monad-testnet";
    await Promise.all(
      cycle.ledger.map(async (t) => {
        const [rcpt, tx] = await Promise.all([
          client.getTransactionReceipt({ hash: t.hash }).catch(() => null),
          t.gasLimit === undefined ? client.getTransaction({ hash: t.hash }).catch(() => null) : Promise.resolve(null),
        ]);
        if (rcpt) {
          t.gasUsed = rcpt.gasUsed;
          t.gasPrice = rcpt.effectiveGasPrice;
        }
        if (tx) t.gasLimit = tx.gas;
      }),
    );
    const refPrice = monad ? await client.getGasPrice() : this.config.refGasPriceWei;
    const zero = BigInt(0);
    const sum = (rows: LedgerTx[], f: (t: LedgerTx) => bigint) => rows.reduce((s, t) => s + f(t), zero);
    const byPhase: CycleCost["byPhase"] = {};
    for (const phase of new Set(cycle.ledger.map((t) => t.phase))) {
      const rows = cycle.ledger.filter((t) => t.phase === phase);
      byPhase[phase] = { txs: rows.length, gasUsed: sum(rows, (t) => t.gasUsed ?? zero).toString(), gasLimit: sum(rows, (t) => t.gasLimit ?? zero).toString() };
    }
    const mon = (wei: bigint) => Number(formatEther(wei)).toFixed(4);
    const byRole: CycleCost["byRole"] = {};
    for (const role of new Set(cycle.ledger.map((t) => t.role))) {
      const rows = cycle.ledger.filter((t) => t.role === role);
      const limit = sum(rows, (t) => t.gasLimit ?? zero);
      byRole[role] = { txs: rows.length, gasLimit: limit.toString(), monadEstimateMon: mon(limit * refPrice) };
    }
    // Busiest lane keeper key (the gas guard's per-key threshold).
    const perKeeper = new Map<string, bigint>();
    for (const t of cycle.ledger) {
      if (t.role !== "keeper" || !t.from) continue;
      const k = t.from.toLowerCase();
      perKeeper.set(k, (perKeeper.get(k) ?? zero) + (t.gasLimit ?? zero));
    }
    if (perKeeper.size) {
      const max = [...perKeeper.values()].reduce((m, v) => (v > m ? v : m), zero);
      byRole.keeperMax = { txs: 0, gasLimit: max.toString(), monadEstimateMon: mon(max * refPrice) };
    }
    const gasLimit = sum(cycle.ledger, (t) => t.gasLimit ?? zero);
    return {
      cycle: cycle.n,
      complete: cycle.seedMeasured,
      txs: cycle.ledger.length,
      gasUsed: sum(cycle.ledger, (t) => t.gasUsed ?? zero).toString(),
      gasLimit: gasLimit.toString(),
      paidWei: sum(cycle.ledger, (t) => (monad ? (t.gasLimit ?? zero) : (t.gasUsed ?? zero)) * (t.gasPrice ?? zero)).toString(),
      monadEstimateWei: (gasLimit * refPrice).toString(),
      monadEstimateMon: mon(gasLimit * refPrice),
      gasPriceGwei: Number(refPrice) / 1e9,
      byPhase,
      byRole,
      timings: cycle.timings,
    };
  }

  // ---------------------------------------------------------------------------
  // View (GET /arena)
  // ---------------------------------------------------------------------------

  private pushFeed(t: Omit<FeedTx, "at">): void {
    this.feed.push({ ...t, at: Date.now() });
    if (this.feed.length > 60) this.feed.splice(0, this.feed.length - 60);
  }

  private accountView(b: DesignBook, t: Tracked) {
    let discount = t.discountBps;
    if (t.state === "auction" && t.startBlock !== null && this.head !== null) {
      discount = Math.min(b.params.maxBps, Math.max(0, (this.head - t.startBlock) * b.params.stepBps));
    }
    const s = (v: bigint | null) => (v === null ? null : v.toString());
    return {
      account: t.account,
      lane: t.lane,
      state: t.state,
      profile: t.profile,
      discountBps: discount,
      startBlock: t.startBlock,
      resolvedBlock: t.resolvedBlock,
      equity: s(t.equity),
      notional: s(t.notional),
      residual: s(t.residual),
      badDebt: s(t.badDebt),
      fixedPenalty: s(t.fixedPenalty),
      txHash: t.txHash,
    };
  }

  /** Head block for the view outside runs (inside runs the event poller keeps it fresh). */
  private async refreshHead(): Promise<void> {
    if (this.current || Date.now() - this.headAt < 2_000) return;
    this.headLoading ??= this.ctx.client
      .getBlockNumber()
      .then((n) => {
        this.head = Number(n);
        this.headAt = Date.now();
      })
      .catch(() => undefined)
      .finally(() => {
        this.headLoading = null;
      });
    return this.headLoading;
  }

  async view() {
    void this.refreshBalances().catch(() => undefined);
    await this.refreshHead();
    this.rollDay();
    const refusal = this.refusal(null);
    const t = this.thresholds();
    const b = this.balances;
    const monadExplorer = this.ctx.info.chainId === 10143 ? "https://testnet.monadexplorer.com" : null;
    const designs = [...this.books.values()].map((bk) => {
      const accounts = [...bk.accounts.values()];
      const counts: Record<AccountState, number> = { healthy: 0, underwater: 0, auction: 0, backstop: 0, external: 0, cured: 0, expired: 0 };
      for (const a of accounts) counts[a.state]++;
      return {
        design: bk.ref.design,
        label: bk.ref.label,
        contract: bk.ref.address,
        params: bk.params,
        counts,
        others: { ...bk.others, accountsInLanes: bk.laneCounts.reduce((s, n) => s + n, 0) - accounts.length },
        lanes: Array.from({ length: LANE_COUNT }, (_, lane) => ({
          lane,
          registered: bk.laneCounts[lane] ?? 0,
          accounts: accounts.filter((a) => a.lane === lane).map((a) => this.accountView(bk, a)),
        })),
      };
    });
    return {
      state: this.state,
      stateSince: this.stateSince,
      now: Date.now(),
      chainId: this.ctx.info.chainId,
      network: this.ctx.info.network,
      explorer: monadExplorer,
      canCrash: refusal === null,
      reason: refusal ? { code: refusal.code, message: refusal.message } : null,
      cooldownRemainingS: Math.ceil(this.cooldownRemainingMs() / 1000),
      cooldownS: this.config.cooldownMs / 1000,
      lastError: this.lastError,
      cycles: this.persisted.cycles,
      shockBps: this.config.bps,
      head: this.head,
      current: this.current
        ? { runId: this.current.runId, startedAt: this.current.startedAt, shockBlock: this.current.shockBlock, cycle: this.cycle?.n ?? null }
        : null,
      last: this.last,
      book: { seed: this.bookSeed, perLane: this.config.perLane, cure: this.config.cure, designs },
      feed: this.feed.slice(-30),
      budget: {
        daily: { used: this.persisted.dayCount, max: this.config.dailyMax, day: this.persisted.day },
        refuelling: this.refuelling(),
        thresholds: { operatorMon: formatEther(t.operator), keeperMon: formatEther(t.keeper) },
        balances: b
          ? {
              at: b.at,
              operator: { address: this.ctx.roles.operator.address, mon: formatEther(b.operator) },
              keepers: b.keepers.map((k) => ({ lane: k.lane, address: k.address, mon: formatEther(k.balance) })),
            }
          : null,
        lastCycleCost: this.persisted.lastCost,
      },
      limits: {
        cooldownS: this.config.cooldownMs / 1000,
        perIpWindowS: this.config.ipWindowMs / 1000,
        dailyMax: this.config.dailyMax,
      },
    };
  }

  get live(): boolean {
    return LIVE.includes(this.state);
  }
}

/** Admin-only routes in arena mode (everything that writes chain state on demand). */
export function isAdminRoute(method: string | undefined, path: string): boolean {
  if (method !== "POST") return false;
  return path === "/crash" || path === "/recover" || path === "/price-loop" || path === "/demo-takers" || path === "/faucet";
}
