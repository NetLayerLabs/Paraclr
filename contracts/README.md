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
| `src/prod/ParaclrClearinghouseProd.sol` | **Production (guarded mainnet beta, unaudited).** Real AUSD, verified Pyth prices, delayed orders, fees, funding, caps, fair-liquidation auctions, pause and timelock admin. See [*Production*](#production-monad-mainnet-guarded-beta) |
| `script/DeployProd.s.sol` | Production deploy: verifies AUSD and Pyth on chain, deploys a TimelockController and the clearinghouse, applies the beta caps, hands ownership to the timelock |
| `SECURITY_NOTES.md` | Slither triage, internal review findings and residual risks of the production set |
| `REVIEW.md` | Internal adversarial review of the production set. Its PoCs in `test/review/` are flipped into regressions (each asserts the exploit fails) |

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

---

## Production (Monad mainnet guarded beta)

> **Unaudited beta · capped · use only what you can afford to lose.** Launch only if every item of the launch gate in
> [`docs/PRODUCTION_PLAN.md`](../docs/PRODUCTION_PLAN.md) passes. Review record and residual risks:
> [`SECURITY_NOTES.md`](SECURITY_NOTES.md).

The production set is a separate contract, `src/prod/ParaclrClearinghouseProd.sol`. The demo contracts above are
unchanged and remain the hackathon evidence. The production contract keeps the demo's lane design and its
fair-liquidation mechanism. It adds:

- real AUSD as collateral;
- Pyth prices verified on chain;
- delayed orders;
- trading fees and funding;
- caps;
- a guardian who can only pause;
- a TimelockController as owner.

It has no demo functions: no `seedAccounts`, `sharedState`, `liquidateBatch`, MockOracle or faucet.

### Verified facts (2026-10-07)

| Fact | Value | Source / how verified |
| --- | --- | --- |
| Chain | Monad mainnet, chain id 143 | `cast chain-id --rpc-url https://rpc.monad.xyz` |
| Max contract size | **128 KB** runtime, 256 KB initcode | [docs.monad.xyz/developer-essentials/differences](https://docs.monad.xyz/developer-essentials/differences): "The maximum contract code size limit is 128 KB (up from 24 KB in Ethereum)" |
| EVM | Fusaka opcodes; TSTORE/TLOAD, MCOPY and PUSH0 live | Monad docs; also checked with `eth_call` of initcode that exercises each opcode on mainnet |
| Gas billing | charged on the **gas limit**, not gas used; block limit 150M, tx limit 30M; base fee 100 gwei | [docs.monad.xyz/developer-essentials/gas-pricing](https://docs.monad.xyz/developer-essentials/gas-pricing); `cast block latest` |
| AUSD | `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`, symbol "AUSD", **6 decimals**, `version()` 2.1.0 | [docs.agora.finance/developer/contract-deployments](https://docs.agora.finance/developer/contract-deployments); `cast call … decimals()` |
| AUSD behaviour | EIP-1967 proxy (impl `0xc1e3c7d4…12da`, `AgoraDollar`, verified on Sourcify). Upgradeable **instantly** by an EOA-owned ProxyAdmin. Roles (EOAs) can **freeze** any account (a frozen sender **or** recipient reverts), **pause** transfers and **burn** from any address. **No** fee-on-transfer and **no** rebasing in the current code. Has EIP-2612 permit and EIP-3009. All pause and upgrade flags currently false | Sourcify source + `cast call`/`cast storage` (EIP-1967 slots), [docs.agora.finance/developer/rbac](https://docs.agora.finance/developer/rbac) |
| Pyth (used) | `0x2880aB155794e7179c9eE2e38200202908C17B43`, ERC1967 proxy, impl `0xd35e56c0…4b71`, `version()` **1.4.6**. Has `parsePriceFeedUpdatesUnique` (selector `0xaccca7f9`). Update fee **0** (`singleUpdateFeeInWei` = 0, `getUpdateFee` = 0) | [Monad protocol registry `pyth.jsonc`](https://raw.githubusercontent.com/monad-crypto/protocols/main/mainnet/pyth.jsonc) (linked from [docs.monad.xyz/tooling-and-infra/oracles](https://docs.monad.xyz/tooling-and-infra/oracles)); bytecode selector scan; `cast call` |
| Pyth semantics | `parsePriceFeedUpdatesUnique` accepts an update only if `min ≤ publishTime ≤ max` **and** `prevPublishTime < min`. It does not store anything. Excess `msg.value` is **not** refunded | Pyth.sol at 1.4.6 (pyth-crosschain); **replayed a real mainnet payload with `eth_call`**: it accepts only `min == publishTime` (1791330282) and rejects `min = publishTime ± 1` |
| Pyth (alternative) | `0xB754BA51E3861Ac0Cb67f73CD046dE790A36508d` ("upgraded", `version()` 1.4.5-alpha.1) also parses today's payloads. It is listed on [docs.pyth.network/price-feeds/core/upgrade/contracts](https://docs.pyth.network/price-feeds/core/upgrade/contracts); switching is a timelocked `setPyth` | same `eth_call` replay |
| Hermes | Since 2026-08-26, `/v2/updates/*` requires an API key (`Authorization: Bearer $PYTH_API_KEY`). `/v2/price_feeds` stays open. Pyth recommends `https://pyth.dourolabs.app/hermes` | HTTP 401 from hermes.pyth.network; [docs.pyth.network/price-feeds/core/upgrade/preparing](https://docs.pyth.network/price-feeds/core/upgrade/preparing) |
| Feed ids | MON/USD `0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1`, SOL/USD `0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d`, BTC/USD `0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43` (all expo −8). They are pushed on chain every few seconds (seen 0–30 s old) | Hermes `/v2/price_feeds?query=…`; `getPriceUnsafe` on mainnet |
| Safe | Deployed on 143: SafeL2 1.4.1 `0x29fc…C762`, ProxyFactory `0x4e1D…ec67`, MultiSend `0x3886…B526`; code hashes match safe-deployments. The Safe UI supports Monad (tx service `api.safe.global/tx-service/monad`) | [safe-deployments](https://github.com/safe-global/safe-deployments) network lists; [safe-config chains/143](https://safe-config.safe.global/api/v1/chains/143/); `cast codesize` |

### Design (v5, after the adversarial review and the v2, v3 and v4 re-reviews)

The contract was revised four times after internal adversarial reviews ([`REVIEW.md`](REVIEW.md)). Every finding, its fix
and its regression test are listed in [`SECURITY_NOTES.md`](SECURITY_NOTES.md) §1.

- **Lanes:** `lane = uint160(account) % 8`.
  - Every per-trade accumulator and cap is lane-local or account-local: insurance, bad debt, OI, ledgers, AUSD held,
    the last-used price, the pool, the auction list, keeper rewards and execution fees owed.
  - Order ids are `uint160(account) << 96 | nonce`, so there is no global counter.
  - The reentrancy lock, the per-call price cache and the Pyth-fee meter use transient storage.
  - `test/prod/ProdParallel.t.sol` proves with `vm.record` that lane-3 and lane-5 transactions do not conflict on
    storage: commits, executions, auction batches, and an order against the other lane's pool take. A negative control
    shows that two transactions in the same lane do conflict.
- **Prices (Pyth), per-lane monotonic:**
  - Every state-changing call uses, per market, the **newest** of three sources: the caller-supplied update (≤
    `maxPriceAge` = 30 s), the Pyth-stored price (≤ `maxStoredPriceAge` = 15 s), and **the newest price this lane has
    already used** (`lanePrice`, also ≤ 15 s). It then records that price for the lane. Within a lane, prices never
    move backwards.
  - Each price is expo-normalised to 1e18 and rejected if `price ≤ 0`, if the exponent is outside [−30, 12], or if
    `conf / price > maxConfBps`.
  - **Only the markets a call touches** are parsed and validated: the account's, the batch accounts', or the pool's.
    Partial update blobs are fine. An unusable market is cached as unusable and only reverts where it is needed;
    batches skip such accounts (`AccountSkipped`).
  - Order fills use Pyth's **unique first update at or after `execAfter`**. That price is historical and does not
    advance the lane's price.
  - **Dead feeds:** `replaceMarketFeed(market, newFeed, maxDeviationBps)` (timelock) repoints a market even with open
    interest. The new feed's stored price must be within `maxDeviationBps` of the market's newest price in every lane
    with OI: ≤ 10% while the old feed is live, ≤ 50% once it is provably dead on chain (no stored price, older than
    `DEAD_FEED_AGE` = 1 h, or unusable: a "zombie" with a non-positive price or too-wide confidence). A lane that never
    recorded a price is checked against the old feed's stored price (confidence ignored), else the market's newest
    price in any lane. The procedure is in SECURITY_NOTES §4.
- **Delayed orders:**
  - `commitOrder` escrows the margin (a reservation) and the native MON execution fee. It records `reduceOnly` and the
    id of the position the order applies to.
  - `executeOrder` (anyone) must run in [`execAfter`, `deadline`]. The account's **other legs** are priced from the
    executor's update **through the per-lane monotonic path** (never older than the lane price), so no separate Pyth
    push is needed.
  - If the position changed since commit (taken, closed, inherited), the fill fails (`PositionChanged`). A reduce can
    never increase.
  - Fill-level failures mark the order **Failed**: escrow is released and the executor is still paid. Oracle problems,
    out-of-gas and panics revert the whole call instead.
  - `cancelOrder` (anyone) works only after the deadline and refunds the fee to the account.
  - **An account in auction may commit reduce-only orders.** One fills only if it leaves the account at or above
    maintenance, at both the fill price and the current price, and that ends the auction. The current price must be
    strictly newer than `execAfter` and at most `maxStoredPriceAge` old, whatever the blob order (else `StalePrice`
    and the order stays pending).
- **Fees:** the trading fee is `tradingFeeBps` × notional, rounded up, and goes to the lane: bad debt first, then the
  pool's receivable, then insurance. **On increases it is paid out of the order's margin**, so "deposit 50, trade at
  10x with all 50" fills; leverage is checked on the gross margin. **An increase that adds margin may not leave margin
  above notional** (≥ 1x).
- **Funding:** the global-skew rate is set by a rate-limited `updateFunding` and settled on touch. Backstop pools pay
  and receive funding too.
- **Caps:**
  - `maxLeverage`.
  - `maxDepositPerAccount` and `maxTvlPerLane` bind every deposit, except **`topUpAllowance(account)`**. That
    exemption exists only while an account holding positions has equity **below its initial margin**, and only up to
    the amount that restores **100%** of initial margin (never above, so exempt money cannot fund new margin).
    `depositWithPrice(amount, priceUpdate)` computes it at fresh prices when Pyth storage is stale. Holders may
    deposit while paused.
  - **No new margin above the account cap:** while collateral is above `maxDepositPerAccount`, a margin-adding
    increase is refused at commit and again at fill (`CollateralAboveCap`), so exempt top-ups only ever offset the
    account's own losses.
  - `maxTvlPerLane`: trader collateral plus pool cash.
  - **OI cap per lane, market and side** = `min(maxLaneOi, lane insurance × oiCapMultiplierBps)`. Pool cash does not
    count.
  - `minPositionNotional`; the first deposit must be ≥ 1 AUSD.
- **Liquidation:** the fair-liquidation Dutch auction.
  - The pool and external takers are **both paid at most the trader's remaining equity**, `min(P, max(E, 0))`.
  - Accounts whose equity is **already negative** at `startAuctions` are not auctioned. They are **closed out at
    once** (`AuctionExpired`), so their loss is booked immediately.
  - **Cure** (`cancelAuction`) needs equity ≥ maintenance and never works in the start block.
  - Expiry is the 1% legacy close-out.
- **Backstop pools:**
  - Shares belong to an **epoch**. When a flat pool's cash goes negative it first nets its receivable
    (`BackstopReceivableNetted`). Only if cash + receivable ≤ 0 is the rest written off and every share retired
    (`BackstopPoolReset`); the next deposit starts fresh at 1:1.
  - **Deposits are refused while the pool has a receivable outstanding** (`BackstopReceivableOutstanding`) **or while
    its unrealised gain exceeds lane insurance** (`BackstopGainCapBinding`), so a deposit is always priced at the full
    NAV. `backstopDepositStatus(lane)` tells the app in advance.
  - When the last LP leaves, the receivable is forgiven and any orphaned cash goes to the lane (`BackstopSwept`).
  - **LP exits are two-step:** `backstopRequestWithdraw`, then wait `backstopWithdrawDelay` (1 h), then
    `backstopWithdraw` **once** within a 1 h window, at the NAV of that moment. Any withdrawal consumes the request.
  - **Exits count unrealised gains (and the receivable) as 0 until realised**: an exit is paid its share of
    `cash + min(unrealised, 0)`, so nothing that moves with lane insurance can lift it. `backstopNav` reports this
    exit NAV. Deposits are priced at the full NAV.
  - **The last shares cannot leave while the pool holds any position** (`BackstopPositionsOpen`); the lane operator
    unwinds the remainder first, so the sweep always runs.
- **Lane isolation (solvency):**
  - AUSD is accounted per lane (`held`). A lane's losses flow insurance → the lane's pool cash (`BackstopLossAbsorbed`)
    → bad debt.
  - Inflows (trader losses, fees, funding, `fundLane`) repay bad debt → the pool's receivable (`BackstopRepaid`,
    `backstopReceivable`) → insurance. What the pool pays out is a loan to the lane.
  - Bad debt is borne inside the lane by a **pro-rata haircut on every payout** from that lane (`held / (held +
    badDebt)`), which also retires the matching debt (`LaneHaircut`).
  - A lane never pays out more than it holds (`LaneInsolvent`). Fresh deposits and pool deposits into a lane with bad
    debt are refused (`LaneInDeficit`); `fundLane` repays debt first.
- **Admin:** owner = OpenZeppelin `TimelockController` (multisig proposer, executor and canceller, self-administered).
  - The guardian can only call `pause()`. Pause blocks fresh deposits, pool deposits, and committing or executing
    increase orders. Everything else keeps working; withdrawals are deliberately unpausable (SECURITY_NOTES §4).
  - `backstopReduce` operators are **per lane**. `renounceOwnership` is disabled.

### External API (`ParaclrClearinghouseProd`)

Units: AUSD 6 dp, prices 1e18, sizes 1e18, funding index 1e18 = 100% of entry notional, bps.
`marketId = keccak256(bytes("MON/AUSD"))`. Every `bytes[] priceUpdate` is **optional** Pyth update data for (some of)
the markets the call touches: an empty array means Pyth storage or the lane price. Pass `IPyth.getUpdateFee(priceUpdate)`
as `msg.value`; any excess is refunded.

```solidity
constructor(address initialOwner, IERC20 ausd, IPyth pyth);           // ausd must report 6 decimals

// collateral
function deposit(uint256 amount);  // caps (and >= 1 AUSD first, not into a deficit lane) apply to amount − topUpAllowance;
                                   // accounts without positions cannot deposit while paused
function depositWithPrice(uint256 amount, bytes[] priceUpdate) payable; // same, with topUpAllowance at the update's
                                   // prices (lane-monotonic); the update is ignored for accounts without positions
function withdraw(uint256 amount, bytes[] priceUpdate) payable;        // debits <= freeCollateral; pays previewWithdraw (lane haircut)
function previewWithdraw(address account, uint256 amount) view returns (uint256 paid);
function topUpAllowance(address account) view returns (uint256);       // deposit allowed outside the caps now (to 100% IM)
function fundLane(uint8 lane, uint256 amount);                         // anyone; repays lane bad debt first
function claimKeeperRewards() returns (uint256 paid);                  // AUSD expiry rewards, per-lane haircut
function claimExecutionFees() returns (uint256);                       // native MON credited

// orders
function commitOrder(bytes32 market, int256 sizeDelta, uint256 marginDelta, uint256 acceptablePrice) payable returns (uint256 orderId);
         // marginDelta > 0 refused while collateral > maxDepositPerAccount (CollateralAboveCap; re-checked at fill)
function executeOrder(uint256 orderId, bytes[] priceUpdate) payable;   // unique fill update + (optional) latest for other legs
function cancelOrder(uint256 orderId);                                 // after the deadline
function getOrder(uint256) view returns (Order);  // (account, commitTime, status, reduceOnly, market, sizeDelta, marginDelta,
                                                  //  acceptablePrice, executionFee, execAfter, deadline, positionId)
function pendingOrderOf(address account, bytes32 market) view returns (uint256);
// status: 0 None, 1 Pending, 2 Executed, 3 Failed (fill impossible, executor paid), 4 Cancelled (fee refunded)

// funding
function updateFunding(bytes32 market) returns (int256 ratePerSec);
function fundingState(bytes32 market) view returns (int256 index, int256 ratePerSec, uint256 lastUpdate, int256 indexNow, uint256 nextUpdate);

// auctions (batches revert AccountNotInLane on an out-of-lane account; unpriceable accounts are skipped)
function startAuctions(uint8 lane, address[] accounts, bytes[] priceUpdate) payable returns (uint256 started); // E < 0: closed out at once
function take(address account, bytes[] priceUpdate) payable returns (uint256 payment);      // min(P, max(E, 0))
function backstopTakeBatch(uint8 lane, address[] accounts, bytes[] priceUpdate) payable returns (uint256 taken); // pool paid min(P, max(E, 0))
function cancelAuction(address account, bytes[] priceUpdate) payable returns (bool);  // equity >= MM, not in the start block
function expireBatch(uint8 lane, address[] accounts, bytes[] priceUpdate) payable returns (uint256 expired);
function auctionOf(address) view returns (bool active, uint64 startBlock, uint16 discountBps);
function auctionStats(uint8 lane) view returns (uint256 active, uint256 started, uint256 taken, uint256 cancelled, uint256 expired);
function getAuctionAccounts(uint8 lane, uint256 offset, uint256 limit) view returns (address[]);
function getLiquidatableAccounts(uint8 lane, uint256 offset, uint256 limit) view returns (address[]); // skips unpriceable

// backstop pools
function backstopDeposit(uint8 lane, uint256 amount, bytes[] priceUpdate) payable returns (uint256 shares);
         // refused while a receivable is outstanding or the pool's gain exceeds lane insurance
function backstopDepositStatus(uint8 lane) view returns (bool open, uint256 receivable, int256 unrealizedUncapped, uint256 insurance);
function backstopRequestWithdraw(uint8 lane, uint256 shares);          // step 1 (0 cancels); works while paused
function backstopWithdraw(uint8 lane, uint256 shares, bytes[] priceUpdate) payable returns (uint256 paid); // step 2;
         // at the exit NAV; the last shares revert BackstopPositionsOpen while the pool holds a position
function backstopWithdrawRequest(uint8 lane, address lp) view returns (uint256 shares, uint256 readyAt, uint256 expiresAt);
function backstopReduce(uint8 lane, bytes32 market, uint256 size, bytes[] priceUpdate) payable returns (int256 realizedPnl); // owner or THIS lane's operator
function backstopNav(uint8 lane) view returns (int256 equity, int256 cash, int256 unrealized, uint256 shareSupply);
         // EXIT NAV: equity = cash + min(unrealised, 0); unrealized = equity - cash (<= 0)
function backstopSharesOf(uint8 lane, address lp) view returns (uint256);   // current epoch only
function backstopEpoch(uint8 lane) view returns (uint256);
function backstopReceivable(uint8 lane) view returns (uint256);         // pool cash lent to the lane, repaid before insurance;
                                                                        // forgiven when the last LP leaves
function backstopPositions(uint8 lane) view returns (bytes32[] markets, int256[] signedSizes, uint256[] entryPrices);
function backstopStats(uint8 lane) view returns (uint256 taken, uint256 discountEarned, uint256 notionalAbsorbed);
function backstopMinDiscountBps(uint8 lane) view returns (uint256);

// accounts, risk, caps
function laneOf(address) pure returns (uint8);
function accountHealth(address) view returns (int256 equity, uint256 maintenanceMargin, uint256 initialMargin, uint256 notional);
function isLiquidatable(address) view returns (bool);
function freeCollateral(address) view returns (uint256);
function getAccount(address) view returns (int256 collateral, uint8 lane, bool registered, bytes32[] openMarkets, uint256 reservedMargin, uint256 orderNonce);
function getPosition(address, bytes32) view returns (Position);     // (isLong, id, size, entryPrice, entryNotional, margin, fundingIndex)
function unrealizedPnl(address, bytes32) view returns (int256 pnl, int256 funding);
function laneTvl(uint8 lane) view returns (uint256);
function laneOiCap(uint8 lane, bytes32 market) view returns (uint256);   // insurance-based
function laneOpenInterest(uint8 lane, bytes32 market) view returns (uint256 longNotional, uint256 shortNotional);
function openInterest(bytes32 market) view returns (uint256 longNotional, uint256 shortNotional);
function getLane(uint8 lane) view returns (uint256 insuranceFund, uint256 badDebt, uint256 totalLiquidations, uint256 lastSettledAt, uint256 accountCount);
function getLaneAccounts(uint8 lane, uint256 offset, uint256 limit) view returns (address[]);
function keeperRewards(address) view returns (uint256);
function executionFeesOwed(address) view returns (uint256);

// markets and prices
function getMarkets() view returns (bytes32[] ids, string[] symbols, bytes32[] feeds);
function getMarket(bytes32) view returns (bool listed, string symbol, bytes32 feedId, uint256 skewScale, uint256 maxLaneOi, uint256 maxFundingBpsPerDay);
function isMarketListed(bytes32) view returns (bool);
function markPrice(bytes32) view returns (uint256);                    // Pyth-stored only, <= 15 s, validated
function markPriceInLane(uint8 lane, bytes32) view returns (uint256);  // what that lane would use with priceUpdate = []
function lanePrice(uint8 lane, bytes32) view returns (uint256 price, uint256 publishTime); // the lane's monotonic marker
function latestPrice(bytes32) view returns (uint256 price, uint256 conf, uint256 publishTime); // raw, unchecked (display)

// solvency
function solvency() view returns (uint256 ausdHeld, uint256 liabilities, int256 surplus, bool solvent); // token vs Σ lanes' held
function laneSolvency(uint8 lane) view returns (uint256 held, int256 claims, int256 surplus, uint256 insurance, uint256 badDebt, uint256 haircutBps);
function nativeSolvency() view returns (uint256 held, uint256 liabilities, bool solvent);
function laneLedger(uint8 lane) view returns (int256 collateral, uint256 insurance, int256 backstopCash, uint256 keeperRewardsOwed, uint256 badDebt, uint256 nativeEscrow, uint256 nativeOwed);

// parameters (public getters): pyth, ausd, guardian, paused, owner, maxLeverage, tradingFeeBps, minPositionNotional,
// maxDepositPerAccount, maxTvlPerLane, oiCapMultiplierBps, maxPriceAge, maxStoredPriceAge, maxConfBps, minExecDelay,
// maxExecDelay, minExecutionFee, fundingUpdateInterval, backstopWithdrawDelay, auctionStepBps, auctionMaxDiscountBps,
// isBackstopOperator(address, uint8 lane); constants incl. TOP_UP_TARGET_BPS (10000), MAX_FEED_SWAP_DEVIATION_BPS (1000),
// MAX_DEAD_FEED_SWAP_DEVIATION_BPS (5000), DEAD_FEED_AGE (1 h), MAX_AUCTION_DISCOUNT_BPS, BACKSTOP_WITHDRAW_WINDOW (1 h)

// roles
function pause();                                                      // guardian or owner
function unpause();                                                    // owner (timelock)
// owner (timelock) only: setGuardian, setPyth, listMarket, setMarketConfig (feed change needs OI == 0),
// replaceMarketFeed(market, newFeed, maxDeviationBps) (dead-feed recovery with OI; deviation <= 10%, <= 50% if the
// old feed's stored price is missing or older than 1 h),
// setRiskParams, setCaps (oi multiplier <= 10x), setOracleParams(maxPriceAge, maxStoredPriceAge, maxConfBps) (ages <= 60 s,
// conf <= 5%), setOrderParams, setFundingParams, setBackstopParams(withdrawDelay) (1 min .. 7 days),
// setAuctionParams (max discount <= 5%), setBackstopMinDiscount, setBackstopOperator(operator, lane, allowed),
// transferOwnership. `selfFill` is internal plumbing (self-call only).
```

**Events:**

- Orders: `OrderCommitted`, `OrderExecuted`, `OrderFailed`, `OrderCancelled` (each with `orderId`, `account` and
  `market` indexed), `ExecutionFeeCredited`.
- Positions and funding: `PositionUpdated`, `FundingSettled`, `BackstopFundingSettled`, `FundingUpdated`.
- Collateral: `Deposit`, `Withdraw` (amount = **paid**), `LaneHaircut(lane, account, debited, paid)`, `AccountRegistered`,
  `LaneFunded`, `KeeperRewardsClaimed`, `ExecutionFeesClaimed`, `BadDebtRealized`, `BackstopLossAbsorbed(lane, amount)`,
  `BackstopRepaid(lane, amount)`.
- Auctions and pools:
  - `AuctionStarted`, `AuctionTaken`, `AuctionCancelled`, `AuctionExpired`. In `AuctionTaken`, `payment` is
    `min(P, max(E, 0))` for both kinds of taker, and `badDebt` is the negative equity written off.
  - `AccountSkipped(lane, account)`.
  - `BackstopDeposit`, `BackstopWithdrawRequested(lane, lp, shares, readyAt)`, `BackstopWithdraw` (amount = paid),
    `BackstopReduced`, `BackstopPoolReset(lane, epoch, retiredShares, deficit)`,
    `BackstopReceivableNetted(lane, amount)`, `BackstopSwept(lane, cash, receivableForgiven)`.
- Admin: `Paused`, `Unpaused`, `GuardianUpdated`, `PythUpdated`, `MarketListed`, `MarketConfigUpdated`,
  `MarketFeedReplaced(market, oldFeed, newFeed, newPrice)`,
  `RiskParamsUpdated`, `CapsUpdated`, `OracleParamsUpdated(maxPriceAge, maxStoredPriceAge, maxConfBps)`,
  `OrderParamsUpdated`, `FundingParamsUpdated`, `BackstopParamsUpdated`, `AuctionParamsUpdated`,
  `BackstopMinDiscountUpdated`, `BackstopOperatorSet(operator, lane, allowed)`, `OwnershipTransferred`.

### Global storage slots and their only writers

| Slot(s) | Written by |
| --- | --- |
| `_owner` (Ownable) | the timelock (`transferOwnership`) |
| `pyth`, `guardian`, all params, `_markets` / `_marketIds`, `isBackstopOperator[addr][lane]` | the timelock |
| `paused` | guardian or timelock (`pause`), timelock (`unpause`) |
| `_funding[market]` (one slot) | `updateFunding` (anyone, at most once per interval) and `listMarket`. **Trades only read it** |

Everything else is keyed by lane or account, including `_lanePrice[lane][market]` (the monotonic price) and
`LaneLedger.held`. Value transfers also write shared EVM balances: AUSD `balanceOf(clearinghouse)` and the
clearinghouse's native balance. The keeper hot paths (`executeOrder` and auction batches) move no value while Pyth's
update fee is 0.

### Defaults (constructor), bounds and setters

| Parameter | Default | Bounds | Setter (timelock) |
| --- | --- | --- | --- |
| `maxLeverage` / `tradingFeeBps` / `minPositionNotional` | 10 / 5 / 10 AUSD | 1..20 / ≤ 100 / any | `setRiskParams` |
| `maxDepositPerAccount` / `maxTvlPerLane` | 50 / 500 AUSD | any | `setCaps` |
| `oiCapMultiplierBps` (× lane insurance) | 50,000 (5×) | ≤ 100,000 | `setCaps` |
| `maxPriceAge` (supplied) / `maxStoredPriceAge` (stored and lane) | 30 s / 15 s | 5..60 s each | `setOracleParams` |
| `maxConfBps` | 200 (2%) | 1..500 | `setOracleParams` |
| `minExecDelay` / `maxExecDelay` / `minExecutionFee` | 3 s / 60 s / 0.1 MON | min 1..60; max ≥ min + 5, ≤ 1 h | `setOrderParams` |
| `fundingUpdateInterval` | 60 s | 10 s .. 1 day | `setFundingParams` |
| `backstopWithdrawDelay` | 1 h (single-use, 1 h window) | 1 min .. 7 days | `setBackstopParams` |
| auction step / max discount | 25 / 500 bps | 0 < step ≤ max ≤ 500 | `setAuctionParams` |
| pool min discount | 75 bps per lane | ≤ 10,000 | `setBackstopMinDiscount` |
| Constants | MM 250 bps (cure at MM); top-up target 100% of IM; feed-swap deviation ≤ 10% (≤ 50% for a dead feed, older than 1 h); expiry penalty 100 bps (half to the caller); pool margin 10%; first deposit ≥ 1 AUSD; pool deposit ≥ 1 AUSD; 8 lanes, ≤ 8 markets | — | — |

### For keepers and the app

- **Prices.**
  - Keep Pyth storage fresh: push `updatePriceFeeds` (≤ 15 s apart), because stored and lane prices expire after 15 s.
  - `priceUpdate` may carry any subset of feeds. Include those the call touches; an all-feeds Hermes blob also works.
  - The browser can always send `[]` (Hermes needs an API key). If it reverts with `StalePrice`, storage is stale:
    retry after the next push.
- **Orders.** Send `[latest blob for the account's feeds, the update whose publish_time is the first one ≥ execAfter
  for the order's feed]`. Other legs are priced from that blob through the lane path, so no Pyth push is needed. An
  order fails (`PositionChanged`) if its position was taken or replaced. Reduce-only orders work while the account
  is in auction; their latest message must be strictly newer than `execAfter` (execute ≥ 1 s after it) and ≤ 15 s old.
- **Batches** skip unpriceable accounts (`AccountSkipped`), and close out negative-equity accounts at once
  (`AuctionExpired`, counted in `auctionStats.expired`). A cure needs equity ≥ MM and at least one block after the
  start. Chunk batches at about 200 accounts (R2-09).
- **LP exits** are two calls, with `backstopWithdrawDelay` (1 h) between them: request, then withdraw **once** within
  1 h, at the exit NAV (`backstopNav`). Exiting while the pool has an unrealised gain or `backstopReceivable(lane) > 0`
  forfeits the LP's share of it. The last LP's exit reverts `BackstopPositionsOpen` until the lane's operator has
  unwound every pool position (`backstopReduce(lane, market, type(uint256).max, update)`).
- **Pool deposits:** check `backstopDepositStatus(lane).open` first (bad debt, receivable outstanding, or gain above
  insurance: refused). **Ops:** alert when it stays `false` (deposit-closure DoS, SECURITY_NOTES §4.6).
- **Orders:** an account whose collateral is above the cap gets `CollateralAboveCap` on margin-adding increases; the
  app should offer "withdraw down to the cap" instead.
- **Pyth fees:** an in-auction reduce parses the update three times; read `getUpdateFee` per call.
- **Deposits:** show `topUpAllowance(account)` as "add margin beyond the cap"; anything above it is capped. Holders
  should deposit with `depositWithPrice(amount, latest update for their feeds)` so the exemption does not depend on
  Pyth storage being ≤ 15 s old.
- **Withdrawals** pay `previewWithdraw` (lane haircut). Monitor `laneSolvency(lane).surplus < 0` (lane bad debt) and
  `solvency().surplus < 0` (token-level loss, e.g. an issuer burn).
- **Operators:** `KEEPER_ADDRESSES[i]` may reduce lane *i*'s pool only.

### Deploying (`script/DeployProd.s.sol`)

The keeper's deploy flow passes the `keeper/.env.mainnet` values. Variables added in v2: `MAX_STORED_PRICE_AGE_SECONDS`
(15), `BACKSTOP_WITHDRAW_DELAY_SECONDS` (3600) and `OWNER_IS_EOA` (false). Defaults changed: `MIN_EXEC_DELAY_SECONDS`
is now 3 and `MAX_PRICE_AGE_SECONDS` is now 30. Before deploying anything, the script checks on chain:

- the chain id;
- AUSD has code, 6 decimals, symbol "AUSD", non-zero supply, and transfers are not paused;
- Pyth has code, and every feed exists, is positive, has a sane exponent and confidence, and was pushed in the last
  hour;
- the owner has code (a Safe) unless `OWNER_IS_EOA=true`;
- the guardian, multisig, deployer and keepers are all distinct.

v3 `params` keys: `topUpTargetBps` and `backstopWithdrawWindowSeconds` (3600). `cureBufferBps` is gone. In v4
`topUpTargetBps` is 10000 (read from the contract); no new variables.

It then deploys `TimelockController(minDelay, [multisig], [multisig], address(0))` and the clearinghouse, lists MON, SOL
and BTC, applies caps and parameters, sets the guardian, makes keeper *i* the operator of **lane *i* only**, optionally
seeds lane insurance, hands ownership to the timelock, and asserts the deployer holds no power.

On a real broadcast it writes `deployments/143.json`, or `DEPLOYMENTS_OUT`, which must be under `../deployments` or
`./cache`:

```json
{ "chainId": 143, "production": true, "contract": "ParaclrClearinghouseProd", "clearinghouse": "0x…", "ausd": "0x…",
  "pyth": "0x…", "oracle": "0x…(= pyth)", "timelock": "0x…", "owner": "0x…", "guardian": "0x…",
  "backstopOperators": ["0x…(lane 0)", "0x…(lane 1)"], "deployBlock": 0, "deployedAt": 0,
  "markets": { "MON/AUSD": "0x…" }, "pythFeeds": { "MON/AUSD": "0x…" },
  "params": { "maxLeverage": 10, "maxDepositPerAccountAusd": 50, "maxTvlPerLaneAusd": 500, "maxOiPerLaneMarketAusd": 5000,
              "oiCapMultiplierBps": 50000, "minPositionSizeAusd": 10, "tradingFeeBps": 5, "maintenanceMarginBps": 250,
              "liquidationFeeBps": 100, "maxConfBps": 200, "executionFeeWei": "100000000000000000",
              "minExecDelaySeconds": 3, "maxExecDelaySeconds": 60, "maxPriceAgeSeconds": 30,
              "maxStoredPriceAgeSeconds": 15, "backstopWithdrawDelaySeconds": 3600,
              "backstopWithdrawWindowSeconds": 3600, "topUpTargetBps": 10000,
              "timelockMinDelaySeconds": 86400, "fundingIntervalSeconds": 60, "maxFundingBpsPerDay": 100,
              "skewScaleAusd": 10000, "auctionStepBps": 25, "auctionMaxDiscountBps": 500,
              "backstopMinDiscountBps": 75, "laneInsuranceSeedAusd": 0 } }
```

`executionFeeWei` is a string. `maxOiPerLaneMarketAusd` is the absolute per-market cap; the live cap is also bounded
by lane insurance × multiplier. With `LANE_INSURANCE_SEED_AUSD = 0`, every OI cap is 0 until lanes are funded.

**The contract is 51,876 B (initcode 53,238 B, above Ethereum's 49,152 but within Monad's 256 KB).** Every local or
forked EVM needs `anvil --code-size-limit 131072` (which also raises the initcode limit) and
`forge script … --code-size-limit 131072`; tests read `code_size_limit` from `foundry.toml`. `forge build --sizes`
still flags EIP-170, as expected.

**Rehearsed** as a read-only simulation on a Monad-mainnet fork (no broadcast). Every on-chain check passed. Estimate:
**18.08M gas, about 3.65 MON at 202 gwei** (v5; v4 17.95M, v3 17.5M). Monad bills the gas limit, so budget about 4.5 MON.

### Tests

```bash
forge test --match-path "test/prod/*"                 # unit + fuzz (incl. the deploy script)
forge test --match-path "test/review/*"               # the adversarial review's PoCs, flipped into regressions
forge test --match-path "test/prod/invariant/*" -vv   # 16 invariants, 256 runs x 100 calls (+ 2 handler coverage tests)
PROD_INV_COVERAGE=cache/prod-inv-coverage.txt forge test --match-test invariant_SolvencyIdentity
MONAD_FORK_RPC=https://rpc.monad.xyz forge test --match-contract ProdForkTest -vv  # real AUSD + real Pyth, read-only fork
forge test --match-contract ProdGasTest --gas-report
```

### Gas (v5)

From `forge test --match-contract ProdGasTest --gas-report`, using MockPyth (Pyth's own verification is excluded). The
figures include the 21k intrinsic cost and cold access. These are local Foundry figures, not Monad measurements.

| Call | Gas |
| --- | ---: |
| `deposit` | 138k – 173k |
| `depositWithPrice` (successful calls in the R3-04 tests) | 138k – 173k |
| `commitOrder` | 208k – 244k |
| `executeOrder` (mock Pyth) | 159k – 376k |
| `executeOrder` with **real Pyth** (mainnet fork, 20-feed signed blob) | **854k** |
| `cancelOrder` | 52k |
| `withdraw` (no update / update) | 147k / 155k |
| `updateFunding` | 80k |
| `startAuctions` ×1 / ×7 | 193k / 725k (≈ 58k per extra account) |
| `backstopTakeBatch` ×1 / ×7 | 340k / 718k (≈ 74k per extra account) |
| `take` (external) | 334k |
| `expireBatch` ×7 | 588k |
| `backstopDeposit` / `backstopRequestWithdraw` / `backstopWithdraw` / `backstopReduce` | 135k / 55k / 66k–121k / 87k |
| `claimExecutionFees` | 54k |
