# Fair-liquidation plan (sprint Oct 6 → submit Oct 12)

**Positioning:** Paraclr is the fair-liquidation clearinghouse for Monad. Every
block, underwater accounts in each of the 8 lanes go to a per-block Dutch auction
backed by per-lane backstop LPs; traders get their leftover equity back. We publish
the measured storage-conflict map (Conflict X-ray) of every crash, side by side with
a deliberately naive shared-state design, and a live solvency proof.

This file is the interface contract between parallel agents. It extends
`docs/ONCHAIN_PLAN.md` (still valid). Change it only via the coordinator. If you must
deviate, append to **Deviations** at the bottom and say so in your report.

## Honesty rules (all copy, UI, docs)
- Say "auction-priced liquidations: the discount is set by the block clock, not by
  gas bidding" / "MEV-resistant pricing". **Never** claim "no MEV" or "no gas wars".
- X-ray shows storage read/write dependencies between transactions — the condition
  under which Monad's optimistic execution re-executes. It does **not** show Monad's
  internal re-execution counts. Always label the method (live trace vs local replay).
- anvil numbers are labelled "local anvil — not Monad". No invented numbers.
- Backstop yield is shown as "earned since deploy", never annualized APY.

## Mechanism

Constants (owner-configurable, sane defaults): `AUCTION_STEP_BPS = 25` per block (5 bps on
the live testnet deployment, set through the timelock on 2026-10-08),
`AUCTION_MAX_DISCOUNT_BPS = 500`, start discount 0, per-lane backstop
`minDiscountBps` default 150 (≈6 blocks ≈ 2.4 s on Monad). Maintenance margin stays
2.5% (250 bps).

1. **Start.** An account with equity < maintenance margin can be put into auction:
   `startAuctions(lane, accounts)` (anyone; reverts on out-of-lane accounts like
   `liquidateBatch` does; skips healthy / already-in-auction). The account is frozen:
   no withdraw, no open. Deposits allowed.
2. **Discount clock.** `discountBps = min(MAX, STEP × (block.number − startBlock))`.
3. **Take.** At the current discount `d`, a taker inherits the account's positions at
   the current mark (taker's entry = mark) and receives payment `P = d × notional`.
   Trader equity `E` (collateral + PnL at mark): trader keeps `max(0, E − P)` as free
   collateral (positions gone, account unfrozen). If `E < P`, the shortfall is paid by
   the lane insurance fund; anything beyond it is lane bad debt. Trader never loses
   more than `E`. Takers:
   - **Lane backstop pool:** `backstopTakeBatch(lane, accounts)` (anyone may call; the
     pool takes only when `discount ≥ pool.minDiscountBps`).
   - **External taker:** `take(account)` by a registered account **in the same lane**
     (keeps all writes lane-local) that stays above initial margin after inheriting.
4. **Cure.** `cancelAuction(account)` (anyone) if the account is healthy again
   (top-up or price recovery).
5. **Expiry fallback.** If an auction reaches MAX and nobody takes (e.g. empty pool),
   `expireBatch(lane, accounts)` closes at mark against the lane (the old liquidation
   path: insurance, then lane bad debt).

**Backstop pools** (one per lane, storage lane-local): LPs deposit AUSD for shares;
NAV = cash + unrealized PnL of inherited positions at mark. Pool exposure is
aggregated per market (signed size, avg entry). An operator/keeper role can
`backstopReduce(lane, market, size)` to close inherited exposure at mark. Withdrawals
are blocked if they'd leave the pool below margin for its exposure.

**Solvency:** per-lane ledgers maintained in lane-local storage; `solvency()` sums
them. Identity (agent finalises exact terms and documents them):
`AUSD.balanceOf(clearinghouse) == Σ lanes (collateral + insurance + backstop cash +
keeper rewards owed − bad debt)`, exposed with a `solvent` flag. Must be covered by
Foundry **invariant** tests.

**Naive baseline for X-ray:** the same clearinghouse code with a constructor flag
`sharedState = true` that maps every per-lane aggregate (insurance, bad debt, open
interest, backstop pool, solvency ledger, auction counters) to one shared key.
Identical logic; only storage keying differs → fair comparison. Deployed alongside
as `NaiveClearinghouseDemo`.

## Contract API additions (contracts agent)

```solidity
// auctions
function startAuctions(uint8 lane, address[] calldata accounts) returns (uint256 started);
function take(address account) returns (uint256 payment);
function backstopTakeBatch(uint8 lane, address[] calldata accounts) returns (uint256 taken);
function cancelAuction(address account) returns (bool);
function expireBatch(uint8 lane, address[] calldata accounts) returns (uint256 expired);
function auctionOf(address account) view returns (bool active, uint64 startBlock, uint16 discountBps);
function getAuctionAccounts(uint8 lane, uint256 offset, uint256 limit) view returns (address[] memory);
// backstop
function backstopDeposit(uint8 lane, uint256 amount) returns (uint256 shares);
function backstopWithdraw(uint8 lane, uint256 shares) returns (uint256 amount);
function backstopNav(uint8 lane) view returns (int256 equity, uint256 cash, int256 unrealizedPnl, uint256 shareSupply);
function backstopSharesOf(uint8 lane, address lp) view returns (uint256);
function backstopPositions(uint8 lane) view returns (bytes32[] memory markets, int256[] memory signedSizes, uint256[] memory entryPrices);
function backstopStats(uint8 lane) view returns (uint256 taken, uint256 discountEarned, uint256 notionalAbsorbed);
function backstopReduce(uint8 lane, bytes32 market, uint256 size) returns (int256 realizedPnl); // operator/keeper role
function setBackstopMinDiscount(uint8 lane, uint16 bps);                                         // owner
// solvency
function solvency() view returns (uint256 ausdHeld, uint256 liabilities, int256 surplus, bool solvent);
function laneLedger(uint8 lane) view returns (uint256 collateral, uint256 insurance, uint256 backstopCash, uint256 keeperRewards, uint256 badDebt);

event AuctionStarted(uint8 indexed lane, address indexed account, uint256 startBlock, int256 equity, uint256 notional);
event AuctionTaken(uint8 indexed lane, address indexed account, address indexed taker, bool backstop, uint16 discountBps, uint256 blocksElapsed, uint256 notional, uint256 traderResidual, uint256 payment, uint256 badDebt);
event AuctionCancelled(uint8 indexed lane, address indexed account);
event AuctionExpired(uint8 indexed lane, address indexed account, int256 equity, uint256 badDebt);
event BackstopDeposit(uint8 indexed lane, address indexed lp, uint256 amount, uint256 shares);
event BackstopWithdraw(uint8 indexed lane, address indexed lp, uint256 shares, uint256 amount);
event BackstopReduced(uint8 indexed lane, bytes32 indexed market, uint256 size, uint256 price, int256 realizedPnl);
```
`liquidateBatch` may remain for backwards compatibility but the keeper and UI use the
auction path. The deploy script deploys **both** `ParaclrClearinghouseDemo` and
`NaiveClearinghouseDemo` (same oracle + AUSD), seeds each lane's backstop pool from
the operator, and writes `deployments/<chainId>.json` with an added
`"naive": "0x…"` key (keep all existing keys).

## Keeper additions (keeper agent)

- **Sweeper** (`SWEEPER=1` default on): every new block, for every lane concurrently
  from that lane's keeper key: start auctions for newly liquidatable accounts; call
  `backstopTakeBatch` for auctions at/above the pool's min discount; `expireBatch` at
  MAX. Also `cancelAuction` for cured accounts.
- **Time underwater:** per account, `underwaterFromBlock` (first block it was
  liquidatable — for a crash run, the shock block) → `resolvedBlock` (taken /
  cured / expired). Report max, p50, p95 in blocks and keeper-measured ms.
- **Crash run v2:** shock → sweeper drives every auction to resolution → `RunReport`
  gains (all amounts raw 6dp strings):
  ```ts
  auctions: { started: number; takenByBackstop: number; takenExternal: number; cured: number; expired: number;
              avgDiscountBps: number; traderResidualReturned: string; backstopPaid: string; badDebt: string;
              legacyCounterfactual: { traderLoss: string } }  // what the old fixed-penalty path would have taken
  underwater: { maxBlocks: number; p50Blocks: number; p95Blocks: number; maxMs: number;
                perAccount: Array<{ account: `0x${string}`; lane: number; fromBlock: number; toBlock: number; outcome: "backstop"|"external"|"cured"|"expired" }> }
  xrayId?: string
  ```
- **Conflict X-ray:** after a crash, run the identical crash on `NaiveClearinghouseDemo`
  (seeded with the identical book), then for both designs collect every tx of the
  resolution phase and compute read/write slot sets via `debug_traceTransaction`
  (`prestateTracer`, with and without `diffMode`). If the RPC lacks debug APIs (check
  Monad), replay on an anvil fork of the chain at the parent block and label
  `method: "anvil-fork-replay"`. Edge i→j (i before j in block order) when j read or
  wrote a slot i wrote. Exclude tx-sender nonce/balance and coinbase fee credits
  (list exclusions in the report). Write `bench/xray/<chainId>-<runId>.json`,
  serve `GET /runs/:id/xray`.
  ```ts
  interface XrayReport {
    runId: string; chainId: number; network: "anvil" | "monad-testnet";
    method: "debug_traceTransaction" | "anvil-fork-replay"; forkedFrom?: { chainId: number; block: number };
    designs: Array<{
      design: "paraclr-lanes" | "naive-shared"; contract: `0x${string}`; blocks: number[];
      txs: Array<{ hash: `0x${string}`; lane: number | null; block: number; index: number; kind: string; reads: number; writes: number }>;
      edges: Array<{ from: `0x${string}`; to: `0x${string}`; slots: string[] }>;
      summary: { txs: number; edges: number; longestChain: number; independentTxs: number };
    }>;
    exclusions: string[];
  }
  ```
- **Bench:** `npm run bench -- --accounts 500` runs crash v2 + X-ray and writes both
  JSONs. New endpoints: `GET /solvency` (proxy of `solvency()` + per-lane ledgers),
  `GET /backstop` (per-lane NAV, stats, positions).

## Frontend additions (frontend agent)
- Clearing (Live): auction lifecycle per lane (in-auction cells with a ticking
  discount, taken-by-backstop vs external, cured, expired), time-underwater metrics,
  equity returned to traders vs legacy counterfactual; the **Conflict X-ray** panel
  (two conflict graphs side by side, method label, summary numbers).
- **Solvency badge** in the app header (reads `solvency()` every block) + detail panel.
- **Backstop** tab: per-lane pools (NAV, earned since deploy, absorbed, inherited
  exposure), deposit/withdraw.
- Trade: banner when the user's account is in auction ("discount X% · you keep ≈Y
  AUSD · add collateral to cure"), and "take" UX for external takers in the same lane
  (nice-to-have).
- Sim mode keeps working (auctions may be simplified there; label "Simulated").

## Landing + docs (content agent)
Reposition the landing page, README, spec, SUBMISSION and X drafts around fair
liquidations + Conflict X-ray + solvency proof (lanes are the engine, not the
headline — another entry already shards perps storage). Read X-ray JSON from
`bench/xray/` at build time like bench results; "pending" slots until data exists.

## Deviations
(append here)

### Contracts agent (fair-liquidation contracts landed)
Signature-level (ABI types or names differ from the block above; viem decodes `int256` and `uint256` both as `bigint`, and multi-output reads return positional arrays, so TS callers are unaffected unless they rely on the declared types):
- `laneLedger(uint8)` returns `(int256 collateral, uint256 insurance, int256 backstopCash, uint256 keeperRewardsOwed, uint256 badDebt)`. `collateral` and `backstopCash` are **signed**, because cross-margin collateral and pool cash can be transiently negative and a `uint` would break the exact identity. The 4th output is named `keeperRewardsOwed` because the name `keeperRewards` clashes with the `keeperRewards(address)` view.
- `backstopNav(uint8)` returns `(int256 equity, int256 cash, int256 unrealized, uint256 shareSupply)`, with `cash` signed for the same reason. The 3rd output is named `unrealized` because `unrealizedPnl(address,bytes32)` already exists.
- Constructors: `ParaclrClearinghouse(owner, ausd, oracle, bool sharedState)` and `ParaclrClearinghouseDemo(owner, ausd, oracle, bool sharedState)`. `NaiveClearinghouseDemo(owner, ausd, oracle)` is `ParaclrClearinghouseDemo` with `true`.

Semantics the plan left open (now fixed and documented in contracts/README):
- `AuctionTaken.badDebt` is the lane-funded shortfall `max(0, P − E)`. Insurance pays first; whatever it can't cover is added to the lane's `badDebt`. `AuctionExpired.badDebt` is the negative equity written off, as in `Liquidated`. `AuctionTaken.taker` is `msg.sender`: for a backstop take it is the address that called `backstopTakeBatch`, and the pool inherits.
- Frozen accounts also cannot `closePosition` and cannot be external takers. `freeCollateral` returns 0 while an account is in auction.
- `take`, `backstopTakeBatch` and `expireBatch` act only on accounts that are still under maintenance. A healthy account can only be cured (`cancelAuction`). `take` reverts with `NotLiquidatable`; the batch functions skip such accounts.
- The pool takes only if, after inheriting, its equity is at least `BACKSTOP_MARGIN_BPS` = 10% of its netted exposure. The withdraw guard uses the same "margin for its exposure". Otherwise the account is skipped and the auction runs on toward expiry.
- Expiry is the legacy path including the 1% penalty: half goes to the `expireBatch` caller as keeper rewards, half to the lane.
- The pool and external takers have the lane insurance fund as counterparty, like traders. `backstopReduce` closes at mark against the lane fund and caps `size` at the exposure. It requires the owner or a `setBackstopOperator` key.
- `getLiquidatableAccounts` excludes accounts already in auction, and `liquidateBatch` skips them.
- In naive mode, lane-scoped aggregate views return the shared totals for every lane, and `getAuctionAccounts(lane, …)` pages the shared list filtered to `lane`. The lane account registry, account and position state, and events are keyed exactly as in Paraclr.

Additions: `auctionStats(lane)`, `backstopMinDiscountBps(lane)`, `auctionStepBps()`, `auctionMaxDiscountBps()`, `setAuctionParams(step,max)`, `setBackstopOperator(addr,bool)`, `isBackstopOperator(addr)`, `sharedState()`, `BACKSTOP_MARGIN_BPS()`, events `AuctionParamsUpdated` / `BackstopMinDiscountUpdated` / `BackstopOperatorSet`, and new custom errors.

Deploy: the forge script writes `"naive"` into `deployments/<chainId>.json`, and `scripts/lib/deploy.ts` keeps it (`KEY_ORDER`). Deploy cost is now 51 txs, 15.1M gas used and 20.05M gas limit, about 2.05 MON at 102 gwei billed on the limit. The `< 2 MON` / "~7M gas" warning in `scripts/lib/deploy.ts` should become about 3 MON / ~20M gas (that file belongs to the scripts owner).

### Contracts agent: follow-up (self-liquidation exploit closed)
- **External `take()` payment is now `min(P, max(E, 0))`**, paid only out of the trader's own equity. The plan's line "If E < P, the shortfall is paid by the lane insurance fund" now applies **only to `backstopTakeBatch`**, whose proceeds go to the lane's LP pool. For an external taker with `E < 0` the payment is 0 and the lane covers only the negative equity, the same write-off every other path does; it does not revert. The trader still keeps `max(0, E − P)` with either taker.
- Event fields are unchanged; the values reflect the cap. `AuctionTaken.payment` is `P` for the pool and `min(P, max(E, 0))` for an external taker. `AuctionTaken.badDebt` is what the lane funded: `max(0, P − E)` for the pool and `max(0, −E)` for an external taker. (This updates the `AuctionTaken.badDebt` bullet in the contracts entry above.)
- The ABI is unchanged; there was no regeneration and no TypeScript impact. Runtime size grew by 51 B (1,384 B headroom left). Keeper and UI copy that says "external taker earns d × notional" should say "earns up to d × notional, capped at the trader's equity".

### Keeper agent (sweeper, crash v2, X-ray, endpoints)
All additive; nothing in the plan's shapes was removed or renamed. Details are in `keeper/README.md`.
- **RunReport:**
  - `mode: "auctions" | "legacy"`;
  - `batches[].kind` (`startAuctions | backstopTakeBatch | expireBatch | cancelAuction | liquidateBatch`);
  - `auctions.traderEquityAtStart`: Σ max(0, equity at AuctionStarted) over taken + expired accounts. Auction trader loss = `traderEquityAtStart − traderResidualReturned`, directly comparable with `legacyCounterfactual.traderLoss`;
  - `xrayError` when the X-ray fails (the crash still counts).
- **RunReport semantics:**
  - In auction mode, `batches` is every sweeper tx on the lane-sharded design during the run. `liquidations` and `totals.liquidated` are taken + expired accounts. `totals.sameBlock` is normally `false` (start and take are ≥ 6 blocks apart).
  - `auctions.badDebt` = Σ event `badDebt` = **lane-funded shortfall** (insurance pays first). Recorded lane bad debt is reported separately by the bench (`bench.laneFunds`). UI copy should say "lane-funded shortfall", not "bad debt", unless it uses the recorded figure.
  - `traderResidualReturned` also includes the collateral left on expired accounts. `underwater.maxMs` = keeper saw the shock receipt → keeper saw the resolving receipt.
- **XrayReport:**
  - Edges are drawn only between txs in the **same block** (`edgeScope: "same-block"`): optimistic re-execution only happens within a block.
  - Additive fields: `generatedAt`, `edgeScope`, `slotLabels` (from `forge inspect` storage layouts), `notes`.
  - `reads` counts slots accessed but not modified; `writes` counts slots modified (diffMode; a same-value SSTORE is not a write).
  - Exclusions are listed verbatim in each report: sender balance/nonce, coinbase balance, transient storage, and non-resolution txs.
- **Endpoints:**
  - `GET /solvency` and `GET /backstop` take `?design=paraclr|naive`; `/backstop` also takes `&lp=0x…`. Both responses carry `sharedState`, and `/backstop` totals count the naive shared pool once.
  - `GET /runs/:id/xray` answers 202 `{status:"pending"}` while the X-ray is computed.
  - New: `GET /sweeper`; `POST /price-loop {paused}` (the bench freezes the mark while seeding both designs so the books are identical); `POST /crash` accepts `mode` and `xray`.
  - `/health` gains `addresses.naive`, `features` and `sweeper`.
- **Sweeper:** the naive design is swept only while a crash run is capturing (`SWEEP_NAIVE=crash`), because outside runs it exists only for the X-ray.
- **Private stacks:** any local RPC port other than 8545 gets its own `DEPLOYMENTS_OUT`, keeper port 8787 + (port − 8545) and `XRAY_DIR` under `contracts/cache/dev-chain/<port>/`. The deploy runs from a shadow foundry root, so `deployments/31337.json` is only ever written by the :8545 stack.
- **Resolved finding:** with the old 150 bps pool threshold, auctions took more equity than the legacy 1% penalty. Now `BACKSTOP_MIN_DISCOUNT_BPS=75` is passed by the deploy wrapper (verified on all lanes of both designs after deploy), and keeper-run demo external takers bid 25–70 bps. On local anvil, auctions took **less** than legacy in every config, and **no account lost more** per account:
  - run A (−20%): 4,642.19 vs 7,082.64 AUSD (−34%);
  - run C (−5%): 2,937.70 vs 4,526.41 AUSD (−35%).
- **Demo external takers (keeper):**
  - `RunReport.auctions.externalTakers = { demo, accounts, reservationBps }`. `demo: true` means the external takes were made by keeper-run bots; UI and docs must label them so.
  - Endpoints: `GET /demo-takers`, `POST /demo-takers {enabled?, seed?, perLane?, minBps?, maxBps?}`. `/health.demoTakers`.
  - `batches[].kind` adds `take` and `closePosition` (taker txs; `keeper` = taker address).
  - The takers are registered lane accounts, so `accountsScanned` includes them (+24).
- **X-ray `summary` adds `crossLaneEdges` / `sameLaneEdges`.** With takers, several txs of one lane share a block and that lane's aggregates (same-lane edges are expected). The lane design's claim is **0 cross-lane edges**: run A shows 0 of 34 edges cross-lane on paraclr, vs 277 of 311 on naive. `closePosition`, `openPosition`, `deposit` and `withdraw` nodes get `lane = laneOf(sender)`.

### Contracts agent: default backstop min discount lowered to 75 bps
- The per-lane pool `minDiscountBps` default is now **75 bps** (3 blocks at 25 bps/block; 15 blocks at the live testnet deployment's 5 bps), replacing the plan's 150 bps (≈6 blocks). That puts it below the 100 bps legacy liquidation fee. The keeper's bench had shown that at 150 the auction took more from traders than the legacy 1% penalty: +27% at −20% and +50% at −5%.
- `setBackstopMinDiscount(lane, bps)` remains available for per-lane tuning. The deploy script gained an optional `BACKSTOP_MIN_DISCOUNT_BPS` env var for both clearinghouses; when unset, the contract default applies. The default is an internal constant, so the **ABI is unchanged**. The keeper should read the threshold per lane with `backstopMinDiscountBps(lane)` rather than hard-coding 150.
- Tested: `test_DefaultPoolTake_LeavesTraderMoreThanLegacy` and a 1024-run fuzz over 2x–20x leverage and E from 1% to 2.5% of notional. A pool take at the default threshold leaves the trader exactly `E − 0.75%·N`, which is strictly more than the legacy `E − 1%·N`. The pool does not take at block +2 and does take at +3.
- Existing deployments (anvil :8545) still use 150 until they are redeployed (keeper agent) or re-tuned per lane with `setBackstopMinDiscount`.
