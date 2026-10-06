# Paraclr Contracts

This is the on-chain layer for Paraclr: a cross-margin perpetuals clearinghouse for **Monad's parallel EVM** with **fair, auction-priced liquidations**. Underwater accounts go to a per-block Dutch auction backed by a per-lane backstop pool, and traders get their leftover equity back. **Agora AUSD** is the only collateral and quote asset. Prices come from **Chainlink Data Streams**, with a mock oracle available for the demo.

Built with Foundry. Solidity `0.8.24`, `evm_version = cancun`.

## Layout

| File | Purpose |
| --- | --- |
| `src/ParaclrClearinghouse.sol` | Clearinghouse: deposits and withdrawals, positions up to 20x, 2.5% maintenance margin, lane-sharded state, liquidation auctions, per-lane backstop pools, per-lane solvency ledgers. The `sharedState` constructor flag selects the storage keying (see *Naive baseline*) |
| `src/ParaclrClearinghouseDemo.sol` | **Demo/benchmark only.** The clearinghouse plus owner-only `seedAccounts`, which creates synthetic accounts for the flash-crash benchmark. The deploy script deploys it with `sharedState = false` |
| `src/NaiveClearinghouseDemo.sol` | **Demo/benchmark only.** `ParaclrClearinghouseDemo` with `sharedState = true`: the same code with every per-lane aggregate in one shared storage key. It is the Conflict X-ray baseline |
| `src/MockAUSD.sol` | 6-decimal AUSD stand-in for testnet. Public faucet `mint(to, amount)` is capped at 10,000 AUSD per call |
| `src/interfaces/IPriceOracle.sol` | `getPrice(bytes32) -> (price1e18, updatedAt)` |
| `src/oracles/MockOracle.sol` | Prices set by the owner or an allowlisted updater. Includes `shockPrice(id, 8000)` / `shockPrices(ids, 8000)` for the "-20% flash crash" |
| `src/oracles/ChainlinkStreamsOracle.sol` | Data Streams adapter. Signed v3 reports are verified through the `verifier` (VerifierProxy) |
| `script/Deploy.s.sol` | Deploys MockAUSD, MockOracle, ParaclrClearinghouseDemo and NaiveClearinghouseDemo (same oracle and AUSD). Lists MON/SOL/BTC on both, allowlists the price pusher, funds every lane's insurance and seeds every lane's backstop pool on both, then writes `../deployments/<chainId>.json` |

## Why lanes? (the parallel-execution design)

Monad runs transactions in parallel and optimistically. If one transaction reads a storage slot that an earlier transaction in the block wrote, it gets re-executed. A typical clearinghouse has global slots that every trade and liquidation writes: the insurance fund, open interest, a backstop vault and a reentrancy lock. Those slots force everything into one sequential queue.

Paraclr splits all mutable risk state into **8 lanes**, with `lane = uint160(account) % 8`:

- **Account, position and auction state** is keyed by account, so it is already disjoint per account.
- **Every per-lane aggregate** exists once per lane: insurance fund and bad debt (`_lanes`), open interest per market (`_laneOI`), the solvency ledger (`_ledgers`), keeper rewards owed (`_keeperLaneRewards[keeper][lane]`), the backstop pool (`_pools`), the auction list and the auction counters. Global figures such as `openInterest(market)` and `solvency()` are sums computed at read time.
- **Reentrancy guard:** uses EIP-1153 transient storage, so it causes no conflicts across transactions.
- **Every batch entry point** (`startAuctions`, `backstopTakeBatch`, `expireBatch`, `liquidateBatch`) reverts if an account is outside `lane`. External `take` only accepts a taker from the account's own lane. Eight keepers each sending batches for lanes 0 to 7 therefore touch **disjoint storage**. The batches don't conflict under Monad's optimistic parallel execution, because none reads a slot another writes, so none has to be re-executed. Contracts can't choose which threads run them; the design only removes the shared state that would force them into a queue.

The tests check this claim directly. They record storage accesses with `vm.record` / `vm.accesses` and assert that the lane-3 and lane-5 transactions have no write/write or read/write overlap:

- `test_ParallelSafety_LaneBatchesTouchDisjointStorage`: legacy `liquidateBatch`.
- `test_ParallelSafety_AuctionPathTouchesDisjointStorage`: `startAuctions` and `backstopTakeBatch`, with every lane-3 tx checked against every lane-5 tx.
- `test_ParallelSafety_NaiveSharedStateConflicts` / `..._NaiveLegacyBatchesConflict` assert the opposite on `NaiveClearinghouseDemo`. The same transactions do overlap there. Two `startAuctions` share 8 written slots and two `backstopTakeBatch` share 27, counted as distinct slots that both transactions write.

## Fair liquidation (the mechanism)

Parameters are owner-configurable. Defaults: `auctionStepBps = 25` per block, `auctionMaxDiscountBps = 500`, start discount 0, and a per-lane pool `minDiscountBps = 75` (3 blocks). Maintenance margin is 2.5%.

The 75 bps pool threshold is deliberately **below the 1% legacy penalty**. At the default, a pool take of an account with `E ≥ 1%` of notional leaves the trader strictly more than the legacy `liquidateBatch` would. Below 1% equity, both paths leave the trader 0. `test_DefaultPoolTake_LeavesTraderMoreThanLegacy` checks this, plus a 1024-run fuzz over 2x–20x leverage and every equity level from 1% to 2.5%. The keeper's bench had shown the earlier 150 bps default taking more than the legacy fee: +27% at −20% and +50% at −5%. Tune per lane with `setBackstopMinDiscount`, or set `BACKSTOP_MIN_DISCOUNT_BPS` at deploy.

1. **Start.** `startAuctions(lane, accounts)` can be called by anyone. Every account with equity below maintenance margin enters an auction at `startBlock = block.number`. Healthy accounts and accounts already in auction are skipped, and an out-of-lane account reverts the batch. The account is then **frozen**: `withdraw`, `openPosition` and `closePosition` revert with `AccountInAuction`, `freeCollateral` returns 0 and the account can't act as a taker. Deposits are still allowed.
2. **Discount clock.** `discountBps = min(auctionMaxDiscountBps, auctionStepBps × (block.number − startBlock))`.
3. **Take at discount `d`.** The account must still be under maintenance at take time. A healthy account can only be cured, never taken. The taker inherits every leg at the current mark, so the taker's entry price is the mark. The trader's leg is closed at mark against the lane, which realizes its PnL. The taker opens the identical leg at mark. The discount is `P = d × notional`, where notional is at mark. The trader's equity `E` (collateral + PnL at mark) pays first. The trader keeps **`max(0, E − P)`** as free collateral, positions gone and account unfrozen, with either kind of taker. **The trader never loses more than `E`.** Negative equity is always written off against the lane, as in every other resolution path. The two kinds of taker differ only in who covers `P` when `E < P`:
   - **Lane backstop pool:** `backstopTakeBatch(lane, accounts)` can be called by anyone. The pool takes an account only if `d ≥ minDiscountBps` **and** the pool's equity stays at least `BACKSTOP_MARGIN_BPS` (10%) of its netted exposure after inheriting. Otherwise the account is skipped and the auction keeps running. The pool is paid the full `P`. If `E < P`, the lane pays `P − E`: insurance first, and anything insurance can't cover is recorded as lane bad debt. That subsidy only ever goes to the lane's LP pool.
   - **External taker:** `take(account)`. The taker must be a registered account **in the same lane** that is not itself in auction, holds no position in the inherited markets, and stays at or above initial margin afterwards. The inherited legs keep the trader's leverage, with margin = ⌈notional / leverage⌉. The taker is paid **`min(P, max(E, 0))`**, only out of the trader's own equity. The lane never pays an arbitrary address. If `E < 0`, the external taker gets 0 and the lane covers only the negative equity. This closes the self-liquidation exploit: one party controlling a bankrupt account and a same-lane taker would otherwise pull `P − E` out of the lane fund.
4. **Cure.** `cancelAuction(account)` can be called by anyone. It returns true and ends the auction once the account is healthy again, after a top-up or a price recovery.
5. **Expiry fallback.** Once the discount reaches the max with nobody taking (for example, the pool is empty or at its margin limit), `expireBatch(lane, accounts)` closes the account through the legacy liquidation path. Every leg is closed at mark against the lane. A 1% penalty is charged, capped at the remaining equity: half goes to the caller as keeper rewards and half to the lane. Negative equity is written off against the lane. Cured accounts are skipped.

`liquidateBatch` (the old fixed-penalty path) remains for backwards compatibility. It skips accounts that are in auction.

**Counterparty model (hackathon scope).** Each lane's insurance fund is the counterparty for every position in that lane: traders, external takers and the lane backstop pool. Losses flow in, profits are paid out, and shortfalls are recorded as lane bad debt that is repaid first by any later inflow.

### Backstop pools (one per lane, lane-local storage)

- LPs `backstopDeposit(lane, amount)` for shares at the current NAV. The first deposit is 1:1, and deposits revert while the pool's equity is ≤ 0 and shares are outstanding. `backstopWithdraw(lane, shares)` pays out `shares × equity / supply`. It reverts if the payout exceeds pool cash, or if it would leave equity below 10% of the pool's exposure notional (`BackstopMarginBreached`).
- **NAV** = cash + unrealized PnL of the inherited exposure at mark. Exposure is aggregated **per market** as a signed size and a size-weighted average entry. Inheriting the same side averages the entry. Inheriting the opposite side realizes PnL on the netted part into pool cash, against the lane fund, and flips at the mark if larger.
- `backstopReduce(lane, market, size)` is restricted to the owner or an allowlisted `setBackstopOperator` key. It closes up to `size` of the exposure at mark against the lane fund and realizes PnL into cash. If a flat pool is left with negative cash, that deficit is written off against the lane.
- `backstopStats` gives lifetime totals: auctions taken, discount payments received (show this as "earned since deploy", never as an APY) and notional absorbed.

## Solvency identity

The per-lane ledgers live in lane-local storage. `solvency()` sums them. The identity is exact and holds after every transaction:

```
AUSD.balanceOf(clearinghouse) == Σ_lanes ( ledger.collateral       // Σ trader collateral (signed)
                                          + lane.insuranceFund
                                          + pool.cash              // backstop pool cash (signed)
                                          + ledger.keeperRewards   // keeper rewards owed
                                          − lane.badDebt )
```

- `solvency()` returns `(ausdHeld, liabilities, surplus, solvent)`. `liabilities` is the ledger total above, `surplus = ausdHeld − liabilities`, and `solvent = surplus ≥ 0`. The surplus is 0 unless someone transfers AUSD to the contract directly, which shows up as a positive surplus. `laneLedger(lane)` returns one lane's five terms.
- Why it holds: trading, auctions, pool takes and reductions, and liquidations only move value **between** these entries. Every change to trader collateral goes through one function, `_adjustCollateral`, which updates the account and its lane ledger together. AUSD only enters or leaves through `deposit`/`withdraw`, `fundLane`, `backstopDeposit`/`backstopWithdraw`, `claimKeeperRewards` and demo `seedAccounts`. Each of these moves the matching ledger entry by exactly the transferred amount.
- Tested by the Foundry invariant tests in `test/invariant/SolvencyInvariant.t.sol`, run against **both** variants with 256 runs × 100 calls each. The handler takes random sequences of deposit, withdraw, open, close, price moves (±35% steps), block progress, startAuctions, backstop takes, external takes, cancels, expiries, legacy liquidations, backstop deposit, withdraw and reduce, lane funding and reward claims. Every run starts from a two-sided 16-account book. The invariants checked are:
  - the identity holds exactly with surplus 0;
  - the ledgers equal the same sums recomputed from account, keeper and pool state;
  - LP shares sum to the share supply;
  - the auction list is consistent and auctioned accounts are frozen;
  - no take ever left a trader with anything other than `max(0, E − P)`;
  - every external take paid exactly `min(P, max(E, 0))`, and the lane funded nothing beyond the negative equity;
  - no call panicked.

## Naive baseline (for the Conflict X-ray)

`NaiveClearinghouseDemo` runs the **same bytecode logic** with `sharedState = true`. Every per-lane aggregate is accessed through one set of storage getters (`_laneStore`, `_ledgerStore`, `_oiStore`, `_poolStore`, `_auctionListStore`, `_countersStore`, plus `_keeperLaneRewards[keeper][_k(lane)]`). These getters map a lane to its storage key `_k(lane)`: the lane itself, or `0` for every lane when the state is shared. That one function is the only difference.

The shared variant behaves the way a textbook clearinghouse with global accumulators does. There is one insurance/bad-debt pair, one open-interest book, one backstop pool, one solvency ledger, and one auction list with one set of counters. Lane-scoped views (`getLane`, `laneLedger`, `backstopNav`, `backstopPositions`, `backstopStats`, `laneOpenInterest`, `auctionStats`, `backstopMinDiscountBps`) return the shared totals for every lane. `getAuctionAccounts(lane, …)` pages the shared list filtered to `lane`. Account and position state, events (which carry the account's real lane) and the lane account registry are the same as in Paraclr. Every lane-batch rule still applies.

## Units

- AUSD amounts (collateral, margin, notional, PnL, insurance, pool cash, payments): **6 decimals**
- Prices: **1e18**, in AUSD per unit of the base asset
- Position `size` and pool `signedSizes`: **1e18** base units
- Discounts: **bps**
- `marketId = keccak256(bytes("MON/AUSD"))`. In viem: `keccak256(toHex("MON/AUSD"))`

## Public API (ParaclrClearinghouse)

```solidity
constructor(address owner, IERC20 ausd, IPriceOracle oracle, bool sharedState); // Demo: same 4 args; Naive: 3 (shared)

// Collateral
function deposit(uint256 amount) external;                 // requires AUSD.approve; allowed while in auction
function withdraw(uint256 amount) external;                // <= freeCollateral(msg.sender); frozen in auction
function fundLane(uint8 lane, uint256 amount) external;    // repays lane bad debt first
function claimKeeperRewards() external returns (uint256);  // all lanes

// Trading (notional = margin * leverage; leverage 1..20; one position per market; frozen in auction)
function openPosition(bytes32 marketId, bool isLong, uint256 margin, uint256 leverage) external returns (uint256 size);
function closePosition(bytes32 marketId) external returns (int256 realizedPnl);

// Auctions (batch entry points revert with AccountNotInLane on any out-of-lane account)
function startAuctions(uint8 lane, address[] calldata accounts) external returns (uint256 started);
function take(address account) external returns (uint256 payment);                 // same-lane external taker
function backstopTakeBatch(uint8 lane, address[] calldata accounts) external returns (uint256 taken);
function cancelAuction(address account) external returns (bool);                   // false if not curable
function expireBatch(uint8 lane, address[] calldata accounts) external returns (uint256 expired);
function auctionOf(address account) external view returns (bool active, uint64 startBlock, uint16 discountBps);
function getAuctionAccounts(uint8 lane, uint256 offset, uint256 limit) external view returns (address[] memory);
function auctionStats(uint8 lane) external view returns (uint256 active, uint256 started, uint256 taken, uint256 cancelled, uint256 expired);
function auctionStepBps() external view returns (uint16);          // default 25
function auctionMaxDiscountBps() external view returns (uint16);   // default 500

// Backstop pools
function backstopDeposit(uint8 lane, uint256 amount) external returns (uint256 shares);
function backstopWithdraw(uint8 lane, uint256 shares) external returns (uint256 amount);
function backstopNav(uint8 lane) external view returns (int256 equity, int256 cash, int256 unrealized, uint256 shareSupply);
function backstopSharesOf(uint8 lane, address lp) external view returns (uint256);
function backstopPositions(uint8 lane) external view returns (bytes32[] memory markets, int256[] memory signedSizes, uint256[] memory entryPrices);
function backstopStats(uint8 lane) external view returns (uint256 taken, uint256 discountEarned, uint256 notionalAbsorbed);
function backstopMinDiscountBps(uint8 lane) external view returns (uint256);   // default 75
function backstopReduce(uint8 lane, bytes32 market, uint256 size) external returns (int256 realizedPnl); // owner or backstop operator; size capped at the exposure
function isBackstopOperator(address) external view returns (bool);
function BACKSTOP_MARGIN_BPS() external view returns (uint256); // 1000 = pool equity >= 10% of exposure

// Solvency
function solvency() external view returns (uint256 ausdHeld, uint256 liabilities, int256 surplus, bool solvent);
function laneLedger(uint8 lane) external view returns (int256 collateral, uint256 insurance, int256 backstopCash, uint256 keeperRewardsOwed, uint256 badDebt);

// Legacy liquidation (skips accounts in auction)
function liquidateBatch(uint8 lane, address[] calldata accounts) external returns (uint256 liquidated);

// Views
function laneOf(address) external pure returns (uint8);
function accountHealth(address) external view returns (int256 equity, uint256 maintenanceMargin, uint256 initialMargin, uint256 notional);
function isLiquidatable(address) external view returns (bool);
function freeCollateral(address) external view returns (uint256);                  // 0 while in auction
function unrealizedPnl(address, bytes32 marketId) external view returns (int256);
function getAccount(address) external view returns (int256 collateral, uint8 lane, bool registered, bytes32[] memory openMarkets);
function getPosition(address, bytes32 marketId) external view returns (Position memory); // (isLong, leverage, size, entryPrice, entryNotional, margin)
function getLane(uint8 lane) external view returns (uint256 insuranceFund, uint256 badDebt, uint256 totalLiquidations, uint256 lastSettledAt, uint256 accountCount);
function laneAccountCount(uint8 lane) external view returns (uint256);
function getLaneAccounts(uint8 lane, uint256 offset, uint256 limit) external view returns (address[] memory);
function getLiquidatableAccounts(uint8 lane, uint256 offset, uint256 limit) external view returns (address[] memory); // under maintenance AND not already in auction
function openInterest(bytes32 marketId) external view returns (uint256 longNotional, uint256 shortNotional);
function laneOpenInterest(uint8 lane, bytes32 marketId) external view returns (uint256 longNotional, uint256 shortNotional);
function keeperRewards(address) external view returns (uint256);                   // summed over lanes
function getMarkets() external view returns (bytes32[] memory ids, string[] memory symbols);
function isMarketListed(bytes32) external view returns (bool);
function markPrice(bytes32 marketId) external view returns (uint256); // reverts if missing or stale
function sharedState() external view returns (bool);                  // true only on NaiveClearinghouseDemo

// Admin (owner)
function listMarket(string calldata symbol) external returns (bytes32 marketId);
function setOracle(IPriceOracle) external;
function setMaxPriceAge(uint256) external;
function setAuctionParams(uint16 stepBps, uint16 maxDiscountBps) external;  // 0 < step <= max <= 5000
function setBackstopMinDiscount(uint8 lane, uint16 bps) external;           // <= 10000; default 75 per lane
function setBackstopOperator(address operator, bool allowed) external;
```

`getLane(lane).totalLiquidations` counts legacy liquidations, auction takes and expiries.

### Events

```solidity
// fair liquidation
event AuctionStarted(uint8 indexed lane, address indexed account, uint256 startBlock, int256 equity, uint256 notional);
event AuctionTaken(uint8 indexed lane, address indexed account, address indexed taker, bool backstop, uint16 discountBps, uint256 blocksElapsed, uint256 notional, uint256 traderResidual, uint256 payment, uint256 badDebt);
event AuctionCancelled(uint8 indexed lane, address indexed account);
event AuctionExpired(uint8 indexed lane, address indexed account, int256 equity, uint256 badDebt);
event BackstopDeposit(uint8 indexed lane, address indexed lp, uint256 amount, uint256 shares);
event BackstopWithdraw(uint8 indexed lane, address indexed lp, uint256 shares, uint256 amount);
event BackstopReduced(uint8 indexed lane, bytes32 indexed market, uint256 size, uint256 price, int256 realizedPnl);
event AuctionParamsUpdated(uint16 stepBps, uint16 maxDiscountBps);
event BackstopMinDiscountUpdated(uint8 indexed lane, uint16 bps);
event BackstopOperatorSet(address indexed operator, bool allowed);
// core (unchanged)
event MarketListed(bytes32 indexed marketId, string symbol);
event OracleUpdated(address indexed oracle);
event MaxPriceAgeUpdated(uint256 maxPriceAge);
event AccountRegistered(address indexed account, uint8 indexed lane);
event Deposit(address indexed account, uint8 indexed lane, uint256 amount);
event Withdraw(address indexed account, uint8 indexed lane, uint256 amount);
event PositionOpened(address indexed account, uint8 indexed lane, bytes32 indexed marketId, bool isLong, uint256 size, uint256 entryPrice, uint256 notional, uint256 margin, uint256 leverage);
event PositionClosed(address indexed account, uint8 indexed lane, bytes32 indexed marketId, bool isLong, uint256 size, uint256 exitPrice, int256 realizedPnl);
event Liquidated(uint8 indexed lane, address indexed account, address indexed keeper, int256 equity, uint256 notionalClosed, uint256 penalty, uint256 badDebt);
event LaneSettled(uint8 indexed lane, address indexed keeper, uint256 liquidated, uint256 skipped, uint256 insuranceFund, uint256 badDebt);
event BadDebtRealized(uint8 indexed lane, address indexed account, uint256 amount);
event LaneFunded(uint8 indexed lane, address indexed funder, uint256 amount, uint256 debtRepaid);
event KeeperRewardsClaimed(address indexed keeper, uint256 amount);
```

How to read the auction events:

- `AuctionTaken.taker`: for an external take, the account that inherited the legs. For a backstop take (`backstop == true`), the address that called `backstopTakeBatch`; the lane pool is what inherited.
- `AuctionTaken.payment`: what the taker received. That is `P` for the pool and `min(P, max(E, 0))` for an external taker.
- `AuctionTaken.badDebt`: what the lane funded. That is `max(0, P − E)` for the pool and `max(0, −E)` (the negative equity only) for an external taker. Insurance pays first, and whatever insurance can't cover shows up in `getLane(lane).badDebt`. The same take also emits `BadDebtRealized` for the negative part of `E`.
- `AuctionExpired.badDebt`: the negative equity written off, the same meaning as in `Liquidated`.
- Each leg a take transfers also emits `PositionClosed` for the trader. An external take additionally emits `PositionOpened` for the taker.

New errors: `AccountInAuction(address)`, `NotInAuction(address)`, `NotLiquidatable(address)`, `NotRegistered(address)`, `SelfTake()`, `InvalidBps()`, `InsufficientShares(uint256,uint256)`, `BackstopInsolvent(uint8)`, `BackstopMarginBreached(int256,uint256)`, `InsufficientBackstopCash(uint256,int256)`.

### Oracles

```solidity
// MockOracle: price writes are allowed for the owner OR an allowlisted updater, so the keeper's
// price pusher and its crash operator use separate keys (separate nonce streams)
function setUpdater(address updater, bool allowed) external;          // owner only
function isUpdater(address) external view returns (bool);
function setPrice(bytes32 marketId, uint256 price) external;          // owner or updater
function setPrices(bytes32[] calldata, uint256[] calldata) external;  // owner or updater
function shockPrice(bytes32 marketId, uint256 bps) external;          // owner or updater; 8000 = -20%
function shockPrices(bytes32[] calldata marketIds, uint256 bps) external; // all markets, one tx
event PriceUpdated(bytes32 indexed marketId, uint256 price, uint256 updatedAt);
event UpdaterSet(address indexed updater, bool allowed);
// errors: Unauthorized(), LengthMismatch(), PriceTooLarge(uint256) (price must fit uint192)

// ChainlinkStreamsOracle
function submitReport(bytes calldata signedReport) external returns (bytes32 marketId, uint256 price);
function submitReports(bytes[] calldata signedReports) external;
function mapFeed(bytes32 feedId, bytes32 marketId) external;          // owner
function setVerifier(address verifier, address feeToken) external;   // owner
event ReportVerified(bytes32 indexed feedId, bytes32 indexed marketId, uint256 price, uint256 observedAt);

// MockAUSD
function mint(address to, uint256 amount) external;      // public faucet, <= 10,000e6 per call
function ownerMint(address to, uint256 amount) external; // owner only, no cap
```

### Demo-only: `ParaclrClearinghouseDemo` / `NaiveClearinghouseDemo`

```solidity
struct SeedPosition { bytes32 marketId; bool isLong; uint256 margin; uint256 leverage; }
struct SeedParams   { address account; uint256 collateral; SeedPosition[] positions; }

// owner only; requires AUSD.approve(clearinghouse, Σcollateral) from the owner
function seedAccounts(SeedParams[] calldata seeds) external returns (uint256 totalCollateral);
event AccountsSeeded(address indexed funder, uint256 accounts, uint256 positions, uint256 totalCollateral);
```

`seedAccounts` lets the benchmark put about 500 accounts on chain without funding 500 EOAs. Both demo contracts have it, so the X-ray can seed an identical book on each. For each entry it:

1. Registers the address in its natural lane (`uint160(account) % 8`), like a first `deposit` would. It emits `AccountRegistered` and `Deposit`.
2. Credits the collateral through the same ledger path as `deposit`.
3. Opens each position at the current oracle mark through the same internal path as `openPosition`. The validation, initial-margin check and `PositionOpened` events are the same.

The total collateral is pulled from the owner in one `transferFrom`, so the solvency identity still holds (tested). The owner can't take funds with this function; it can only give positions away, which is why it stays out of anything real.

## Gas (fair-liquidation paths)

The figures come from `forge test --match-contract ParaclrGasTest --gas-report`. The gas report runs each call as its own transaction, so it includes the 21k intrinsic cost and cold storage access. That matches the tx `gasUsed` measured on a local anvil (`startAuctions` ×1: 142,594). The book is 16 accounts in one lane, each with 100 AUSD collateral and a 10x long MON, after a -20% crash, with pools seeded at 50k.

| Call | Gas | Per extra account |
| --- | ---: | ---: |
| `startAuctions` ×1 / ×16 | 142,542 / 1,148,789 | ~67k |
| `backstopTakeBatch` ×1 / ×16 | 278,087 / 1,400,883 | ~75k |
| `take` (external, 1 leg) | 278,661 | – |
| `cancelAuction` | 58,060 | – |
| `expireBatch` ×16 | 1,047,116 | – |
| `liquidateBatch` ×16 (legacy, for comparison) | 916,624 | – |
| `backstopDeposit` (pool holding exposure) | 74,524 – 110,168 | – |
| `backstopWithdraw` (pool holding exposure) | 94,799 | – |
| `backstopReduce` (partial) | 59,410 | – |
| `solvency()` (eth_call) | 97,553 | – |

These are local anvil/Foundry figures, not Monad measurements. Monad bills the gas **limit**, so keepers should size limits from `estimateGas` plus a margin.

Contract sizes: `ParaclrClearinghouseDemo` and `NaiveClearinghouseDemo` are each 23,192 B of runtime code, under the 24,576 B EIP-170 limit, so stock anvil deploys them without flags. Run `forge build --sizes` to check.

## Commands

```bash
forge build
forge test            # 99 tests: unit + 4×1024-run fuzz + 14 invariants (256 runs × 100 calls, both variants), ~17 s
forge test --match-test ParallelSafety -vv   # lane disjointness + the naive overlap counts
forge test --match-path "test/invariant/*" -vv
forge test --match-contract ParaclrGasTest --gas-report
npm run abi           # (repo root) rebuild + regenerate src/lib/chain/abi/*.ts (incl. NaiveClearinghouseDemo). Never hand-edit those files
```

## Deploying

| | |
| --- | --- |
| RPC | `https://testnet-rpc.monad.xyz` (alias `monad_testnet` in `foundry.toml`) |
| Chain ID | `10143` |
| Explorer | https://testnet.monadexplorer.com |

Use the npm wrappers from the repo root. They take the deployer key from a gitignored env file, pass it to forge only through the child-process environment, and write `deployments/<chainId>.json`:

```bash
npm run dev:chain      # local: anvil (31337) + deploy + keeper, zero config
npm run deploy:anvil   # local: deploy only, to an anvil already running on :8545
npm run deploy:monad   # Monad testnet: OPERATOR_PRIVATE_KEY + PRICE_PUSHER_PRIVATE_KEY from keeper/.env
```

The full Monad testnet runbook (keys, funding, deploy, keeper, bench) is in [`keeper/README.md`](../keeper/README.md).

The script deploys `MockAUSD`, `MockOracle`, `ParaclrClearinghouseDemo` (`sharedState = false`) and `NaiveClearinghouseDemo` (`sharedState = true`). Both clearinghouses use the same oracle and AUSD. It then:

- lists MON, SOL and BTC against AUSD on both clearinghouses (the app's markets) at 0.04 / 180 / 110,000 AUSD;
- allowlists the price-pusher address (`ORACLE_UPDATERS`) on the oracle;
- allowlists optional `BACKSTOP_OPERATORS` for `backstopReduce` on both clearinghouses (the owner, which is the operator key, is always allowed);
- sets `maxPriceAge` to 1 day on both;
- funds each lane's insurance with 100k AUSD (`LANE_SEED`) on both;
- seeds each lane's backstop pool from the operator with 50k AUSD (`BACKSTOP_SEED`, `0` skips) on both. On the naive contract the 8 deposits land in its one shared pool.
- optionally sets every lane's pool threshold on both clearinghouses (`BACKSTOP_MIN_DISCOUNT_BPS`). If unset, the contract default of 75 bps applies.

On a real broadcast it writes `../deployments/<chainId>.json` (`fs_permissions` in `foundry.toml`). The shape is the one from `docs/ONCHAIN_PLAN.md`, plus `naive`:

```json
{ "chainId": 31337, "clearinghouse": "0x…", "naive": "0x…", "ausd": "0x…", "oracle": "0x…", "deployBlock": 2,
  "markets": { "MON/AUSD": "0x…", "SOL/AUSD": "0x…", "BTC/AUSD": "0x…" } }
```

You can also run it raw: `PRIVATE_KEY=… ORACLE_UPDATERS=0xPusher forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast --slow`. Export the key from a gitignored env file rather than typing it on the command line, and never paste it anywhere.

Measured deploy cost on a private anvil: 51 txs, 15.1M gas used. Forge sets each gas limit at about 1.3x usage, for 20.05M in total. Monad bills the limit, so that is about **2.05 MON at 102 gwei**; budget 3 MON.

To use live Chainlink Data Streams, deploy `ChainlinkStreamsOracle(owner, verifierProxy, feeToken)`, call `mapFeed(feedId, marketId)` for each market, and then call `clearinghouse.setOracle(streamsOracle)`.

## Not done / known limitations

- The lane insurance fund is the only counterparty. `backstopReduce` closes pool exposure at mark against that fund; there is no external hedging venue. There are no funding payments or trading fees.
- The backstop pool's margin rule (10% of exposure) is a constant. A pool that is underwater with shares outstanding refuses new deposits until its exposure is reduced and its equity is positive again.
- **Self-liquidation exploit: closed.** External takers are capped at `min(P, max(E, 0))`, so one party controlling a bankrupt account and a same-lane taker nets ≤ 0 from the lane. This is covered by `test_SelfLiquidationAttack_NetsNothingFromLane`, a 1024-run fuzz with an opposite hedge, and the `invariant_ExternalTakerNeverPaidByLane` invariant. All three fail if the cap is removed.

  Two things remain:
  - **Negative equity after a price gap.** That write-off is the same for every resolution path; the fuzz checks that a self-take gets no more than expiry would.
  - **The `E < P` shortfall still goes to the lane's backstop pool.** An LP who owns most of a lane's pool receives a pro-rata share of it. The operator's 50k seed per lane dilutes this.
- The Chainlink adapter does not pay verification fees. FeeManager approval is not wired up; `feeToken` is only forwarded. It is tested against a mock VerifierProxy only.
- Each market allows one position per account. There is no increasing, partial closing or flipping. Close the position and reopen instead. An external taker can't inherit a market it already holds.
- `ParaclrClearinghouseDemo.seedAccounts` and `NaiveClearinghouseDemo` are benchmark conveniences. A production deployment would use `ParaclrClearinghouse` with `sharedState = false`.
- Not yet deployed to Monad testnet: so far it has only been run on local anvil (`bench/results/31337-*.json`). The Monad deploy is one command once funded keys exist; see `keeper/README.md`.
