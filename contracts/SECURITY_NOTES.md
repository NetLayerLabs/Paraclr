# Security notes: production set (`src/prod/ParaclrClearinghouseProd.sol`)

**Status: UNAUDITED.** This is the internal security record for the guarded mainnet beta: what was checked, what
Slither reported, what the adversarial review found and how each finding was fixed, and the risk that remains. It is
not an audit. The demo contracts (`src/*.sol`) hold no real value and are not covered.

**Snapshot: 2026-10-07, v5** (after the adversarial review and the v2, v3 and v4 re-reviews in [`REVIEW.md`](REVIEW.md)).

- sha256 `1643014507eaf16afd06d25a50d2f9bdac8a0556ede00f960cc9fcbda702a5ed`.
- Runtime 51,876 B and initcode 53,238 B. Monad allows 128 KB runtime and 256 KB initcode.
- solc 0.8.24, optimizer 200 runs, `evm_version = cancun`, no via-IR.
- OpenZeppelin 5.6.1 and the Pyth SDK 4.3.1 interfaces, vendored as plain files (`lib/*/VENDORED.md`).

## 1. Adversarial review (REVIEW.md) → fixes → regression tests

The reviewer's PoCs in `test/review/` originally asserted that each problem **exists**. Each file has been flipped: it
now asserts that the problem **is gone**, and its header says so. Two exceptions keep the original assertion as an
accepted, bounded residual: R2-06 (accepted by decision) and R2-09 (a gas measurement). The reviewer's `R4-05` file
holds a sound regression (`R4-05a`) and an accepted-residual bound (`R4-05b`, I4-2).

To confirm the regressions are meaningful, I re-introduced each vulnerability into the fixed contract: 12 mutations
for the v1 findings, 10 for the v2 findings and 14 for the v3 findings. Every mutation is caught by its regression
test. The four R3-01 mutations (no receivable refusal, no gain-cap refusal, the v3 reset that wipes the receivable, no
sweep) are **also caught by the new invariants alone** at 32 runs: the first two by `invariant_LpValueConserved`, the
last two by `invariant_PoolReceivableBookkeeping`.

For the v4 findings I ran 8 mutations (the v4 exit NAV; no last-LP guard; no commit-time, no fill-time and neither cap
check; dead only by age; a reference that needs a usable price; no newest-marker fallback). All are caught by their
regressions. The invariants alone catch the safety ones: the v4 exit NAV by the new fair-value ghost
(`invariant_LpValueConserved`, 32 runs), the missing last-LP guard by the empty-pool ghost
(`invariant_PoolReceivableBookkeeping`, 256 runs; at 32 runs only the coverage test catches it), and the missing cap
checks by `invariant_CapsNeverExceeded` (32 runs). The dead-feed mutation is a liveness property; the deterministic
coverage test catches it (the zombie swap is rejected).

### 1a. v4 re-review findings → v5 fixes

| ID | Finding | Fix (v5) | Regression test(s) |
| --- | --- | --- | --- |
| R4-01 (Low) | The exit NAV cap followed lane insurance, which a hedged pair can lift for one block (loser closes first), so a ripe LP exited at a NAV the lane could not pay and the stayers carried the excess as a receivable | **Exits are priced at `cash + min(unrealised, 0)`**: an unrealised gain is paid to LPs only once realised (the reviewer's preferred option). Insurance no longer enters any exit price. `backstopNav` reports this exit NAV (`unrealized = equity − cash ≤ 0`); the uncapped figure is in `backstopDepositStatus`. Deposits are still priced at the full NAV and gated, so entry is never cheaper than exit | `R4-01_ExitNavInsuranceInflation.t.sol`: `test_R4_01_HedgedPairExitNetsNothing` (the gamed exit equals the plain exit, exactly half the cash; the realised gain then accrues to the LP who stayed). Updated: `test_R2_04a` (an exit pays half the cash, the stayer gets the realised gain), `test_R2_04b` and `test_R3_01d` (deposits priced at the full NAV, `backstopNav` is the exit NAV, old LPs not diluted). Invariant: the fair-value ghost |
| R4-02 (Low) | A dust pool position let the last LP out without the sweep; the receivable was later repaid into a share-less pool and the next 1:1 depositor took it | **`backstopWithdraw` refuses a withdrawal that would leave zero shares while the pool holds any position** (`BackstopPositionsOpen(lane)`). The lane operator (or the timelock) unwinds the remainder first; the last exit then always runs the sweep | `R4-02_DustPositionSkipsSweep.t.sol`: `test_R4_02_LastLpCannotLeaveDust_SweepAlwaysRuns` (refused; partial exits fine; after the unwind the last exit sweeps and forgives; the next 1 AUSD depositor gets ≤ 1 back). Invariant: the empty-pool ghost (checked at the exit itself) and `supply == 0 ⇒ flat, no cash, no receivable` |
| R4-03 (Low) | R3-03 residual: exempt top-ups made in a dip became free collateral after the recovery; 22 ±1% round trips at 10x took one account to 396.98 AUSD (cap 50) | **A margin-adding increase is refused while the account's collateral is above `maxDepositPerAccount`** (`CollateralAboveCap(collateral, cap)`), at commit and again at fill (a top-up between commit and fill fails the order). Exempt money can then only offset the account's own losses | `R4-03_OscillationRatchet.t.sol`: `test_R4_03_OscillationCannotPassTheCaps` (the PoC's 22 rounds: every margin-adding commit refused, margin unchanged, exempt inflow 4.95 = one dip, once; collateral 54.70 = cap + that dip), `test_R4_03b_RecheckedAtFill`. Invariant: no margin-adding commit or fill above the cap |
| R4-04 (Low) | A zombie feed (publishing, never usable) counted as live, so the 50% bound never applied | **`_feedIsDead` also returns true when the newest stored price fails `_check`** (non-positive, bad exponent, confidence above `maxConfBps`). Pushing such a message cannot refute it. **Found while flipping:** a lane with OI but no recorded price (single-leg accounts never record one; fills are historical) used the old feed's stored price only if usable, so a zombie still reverted `NoReferencePrice`. The reference now ignores confidence (the price only has to catch a wrong-asset feed) and falls back to the market's newest marker in any lane | `R4-04_ZombieFeed.t.sol`: `test_R4_04_WideConfidenceZombieFeedIsDead_Recovered`, `test_R4_04b_NonPositivePriceZombieFeedIsDead_Recovered`, `test_R4_04c_UsableFeedStaysLive`, `test_R4_04d_ZombieWithoutAnyMarker_UsesStoredPriceIgnoringConf`, `test_R4_04e_NonPositiveZombieWithoutLaneMarker_UsesNewestMarker`. Invariant: a third of dead-feed swaps face a zombie |
| I4-5 (Info) | `invariant_LpValueConserved` checked exits against the contract's own NAV | **Fair-value ghost:** every exit is checked against an independent bound, its share of the pool's ledger cash (unrealised gains, the receivable and insurance never count). The reviewer's "cash + realisable gain + receivable" was not used: the realisable gain depends on insurance, the very quantity R4-01 manipulates | `invariant_LpValueConserved` |
| I4-1, I4-2, I4-3, I4-4 | Info | Documented in §4 (deposit-closure DoS with an ops alert; the current-price window; the triple Pyth fee; the sweep's cash branch is now unreachable) | — |

### 1b. v3 re-review findings → v4 fixes

v5 refines two of these rows (see §1a): exits no longer count gains up to insurance (R4-01), and a feed is also dead
when its stored price is unusable (R4-04).

| ID | Finding | Fix (v4) | Regression test(s) |
| --- | --- | --- | --- |
| R3-01 (Medium) | The R2-08 pool receivable was outside share accounting: (a) a new LP bought it at zero, (b) the first depositor into an emptied pool took its repayment, (c) an operator unwind reset the pool and wiped a receivable larger than the deficit, (d) a hedged pair could depress the insurance-linked NAV cap for a deposit | 1. **`backstopDeposit` is refused while a receivable is outstanding** (`BackstopReceivableOutstanding`) **and while the pool's uncapped unrealised PnL exceeds lane insurance** (`BackstopGainCapBinding`). A deposit is therefore only ever priced at a complete, uncapped NAV. New view `backstopDepositStatus(lane)`.<br>2. **(d), my call:** the same gain-cap refusal. The attack needs a deposit priced while the cap is depressed; after the refusal every deposit sees the uncapped NAV, and a later cap movement can only lower NAV below that, never raise it above, so a cap that rises after the deposit transfers nothing to the new LP. Exits stay at the capped NAV, which is conservative for the LPs who stay.<br>3. **A flat pool with cash < 0 nets its receivable first** (`BackstopReceivableNetted`): the receivable shrinks and the lane absorbs that part of the deficit (always as bad debt: insurance is 0 whenever a receivable exists). **It is reset only if cash + receivable ≤ 0.** Operator unwinds no longer wipe the receivable.<br>4. **When the last LP leaves (supply 0), orphaned cash goes to the lane** (bad debt, then insurance) **and the receivable is forgiven** (`BackstopSwept`), so nothing is left for a next 1:1 depositor.<br>5. `backstopDeposit` checks `LaneInDeficit` after settling the pool | `R3-01_ReceivableNav.t.sol`: `test_R3_01a_DepositRefusedWhileReceivableOutstanding` (old LP gets back exactly 400, the newcomer ≤ its deposit), `test_R3_01b_LastLpOutForgivesReceivable_NothingForNextDepositor` (1 AUSD in, ≤ 1 out), `test_R3_01c_OperatorUnwindNetsReceivable_NoReset` (no reset; the old LP collects the repayment), `test_R3_01d_DepositRefusedWhileNavCapBinds`, `test_R3_01e_DeficitBeyondReceivable_NetsThenResets`. Updated: `test_R2_04b_NewLpDepositNotDiluted` (refused while the cap binds, then priced at the full NAV). Invariants: `invariant_PoolReceivableBookkeeping`, `invariant_LpValueConserved` |
| R3-02 (Medium) | Dead-feed recovery closed for good after a > 10% move from the frozen price | **`replaceMarketFeed` accepts `maxDeviationBps` up to 50% (`MAX_DEAD_FEED_SWAP_DEVIATION_BPS`) when the old feed is provably dead on chain**: Pyth has no stored price for it, or the stored one is older than `DEAD_FEED_AGE` (1 h) when the timelock executes. A live old feed keeps the 10% bound. Anyone can refute a false "dead" during the 24 h delay by pushing the old feed | `R3-02_FeedSwapBound.t.sol`: `test_R3_02_DeadFeedRecoversAfterThirteenPercentMove` (the account withdraws and closes on the new feed), `test_R3_02b_LiveFeedKeepsTenPercentBound` (incl. the exact 1 h boundary and a refuting push), `test_R3_02c_MissingOldFeedCountsAsDead`. Updated: `test_R2_02_…` (dead feed: 5,001 bps rejected). Invariant: the handler replaces feeds through the real TimelockController |
| R3-03 (Medium) | The 110% top-up target still compounded past both caps at ~1x | **`TOP_UP_TARGET_BPS = 10_000`**: an exempt top-up restores equity to exactly the initial margin, never above, so exempt money can never fund new margin | `R3-03_TopUpRatchetResidual.t.sol`: `test_R3_03_RatchetCannotPassEitherCap` (the PoC's 28 rounds: equity == IM after every exempt top-up, every margin-booking order fails, collateral 49.97 ≤ 50, exempt inflow 0.000028 = the losses it offsets, lane within its cap). Updated: `test_R2_01b_ExemptionOnlyRestoresToInitialMargin` |
| R3-04 (Low) | The rescue top-up silently needed Pyth storage ≤ 15 s old | **`depositWithPrice(amount, priceUpdate)`** (payable, excess refunded) resolves the account's markets from the update through the monotonic lane path before computing `topUpAllowance`. `deposit(amount)` is unchanged | `R3-04_TopUpNeedsFreshStorage.t.sol`: `test_R3_04_DepositWithPriceTopsUpOnStaleStorage`, `test_R3_04b_DepositWithPriceBoundedByAllowance`, `test_R3_04c_NoPositions_UpdateIgnored_CapsApply`. Invariant: a third of holder deposits use it, with the exemption re-derived after the call |
| R3-05 (Low) | Blob order collapsed the in-auction reduce's current-price check onto the stale fill price | **`_orderCurrentPrice`:** the order market is left out of the other-legs set and parsed on its own with publishTime ≥ minT = max(`execAfter` + 1, now − `maxStoredPriceAge`). The resolved price (newest of supplied, stored and lane) must also be ≥ minT, else `StalePrice` (the order stays pending). The fill message can no longer be the "current" price, by blob order or by pushing it into storage | `R3-05_ReduceInAuctionCurrentPrice.t.sol`: `test_R3_05_BlobOrderNoLongerDecidesTheCurrentPriceCheck`, `test_R3_05c_FillMessageInStorageIsNotACurrentPrice`, `test_R3_05d_CurrentPriceMustBeWithinMaxStoredPriceAge`, `test_R3_05e_HonestCureAtRealCurrentPrice`; sound: `test_R3_05b_BankruptFullCloseInAuctionFails` |
| I3-4 (Info) | Invariant gaps (receivable, LP value, empty pools, feed replacement) | **Closed.** Three new invariants and five new handler paths; path coverage in §3 | — |
| I3-1, I3-2, I3-3, I3-5 | Info | Documented in §4 (live-feed swaps, alternating exit requests, close-out at a dip, the unreachable close-out reward branch). No code change | — |

### 1c. v2 re-review findings → v3 fixes

v4 refines three of these rows (see §1b): R2-01's target is now 100% (R3-03), R2-02's bound is 50% for a dead feed
(R3-02), and R2-08's receivable is now inside share accounting (R3-01).

| ID | Finding | Fix (v3) | Regression test(s) |
| --- | --- | --- | --- |
| R2-01 (Medium) | The R-04 top-up exemption let a holder ratchet past both beta caps with dust orders | 1. **An increase that adds margin may not leave margin above notional** (`MarginAboveNotional`), so dust orders cannot book collateral as margin.<br>2. **The cap exemption (`topUpAllowance`) only exists while equity is below initial margin**, and only up to the amount that restores **110%** of initial margin (`TOP_UP_TARGET_BPS`). The rest of any deposit obeys both caps and `LaneInDeficit`. The coordinator asked for "below ~110%"; the trigger is "below 100%" so that 1× all-in positions (equity = IM) cannot ratchet geometrically | `R2-01_TopUpCapBypass.t.sol`: `test_R2_01_DustOrdersCannotRatchetPastEitherCap` (20 dust rounds: the account stays ≤ 50 and the lane ≤ 500), `test_R2_01b_ExemptionOnlyRestoresToInitialMargin` (renamed in v4, now asserting 100%). Invariant: the handler checks every deposit's capped part and margin ≤ notional |
| R2-02 (Medium) | A dead feed with open interest froze funds forever | **`replaceMarketFeed(market, newFeed, maxDeviationBps)`**, timelock only, works even with OI. The new feed's Pyth-stored price must be valid and ≤ 15 s old, and within `maxDeviationBps` (≤ 10%, `MAX_FEED_SWAP_DEVIATION_BPS`) of the market's newest price in **every lane with OI**: the lane's last-used price, or the old feed's last stored price if a lane never recorded one. The market's lane price markers are reset. `setMarketConfig` still refuses a feed change with OI. Procedure in §4 | `R2-02_DeadFeedDeadlock.t.sol`: `test_R2_02_DeadFeed_RecoveredByTimelockedFeedSwap` (the account closes both legs and withdraws) |
| R2-05 (Medium) | The cure buffer created a "zombie auction" band | **Cure at maintenance**; the ≥ 1-block rule stays, and prices are monotonic per lane. **Reduce-only orders may be committed and executed while in auction.** The fill must leave the account at or above maintenance at both the fill price and the order market's current price, and then ends the auction | `R2-05_CureBandTrap.t.sol`: `test_R2_05_RecoveredAccountIsCured_NotTakenAtMaxDiscount`, `test_R2_05b_ReduceOnlyOrderInAuction_DeRisksAndEndsAuction`. Unit: `test_CureAtMaintenance_NotInStartBlock` |
| R2-08 (Medium) | The waterfall was one-way: LPs paid for the order of realisation | Pool cash consumed by the waterfall is tracked per lane (`Lane.poolAbsorbed`, `backstopReceivable(lane)`) and **repaid from lane inflows before insurance**: bad debt → pool → insurance (`BackstopRepaid`). A retired pool epoch forfeits its receivable | `R2-08_WaterfallAsymmetry.t.sol`: `test_R2_08_ZeroNetLaneResult_LpsWhole` (NAV unchanged, insurance keeps only fees) |
| R2-04 (Low) | Pool NAV counted gains the lane could only pay from the pool itself; a standing request was a 24 h exit option | **Unrealised pool gains count in NAV only up to lane insurance.** **Withdrawal requests are single-use** (any withdrawal consumes them) with a **1 h** window (`BACKSTOP_WITHDRAW_WINDOW`) | `R2-04_PoolNavFirstExit.t.sol`: `test_R2_04a_FirstLpExitsAtFairNav_SecondLpWhole`, `test_R2_04b_NewLpDepositNotDiluted`, `test_R2_04c_RequestIsSingleUse_ShortWindow` |
| R2-03 (Low) | Multi-leg executions needed a separate global Pyth push; the executor could still steer | Other legs are priced from the **executor's `priceUpdate` through the per-lane monotonic path** (newest of supplied, stored and lane price; never older than the lane price). No push is needed | `R2-03_MultiLegLiveness.t.sol`: `test_R2_03a_MultiLegCloseFillsWithKeeperDataShape_NoPushNeeded`, `test_R2_03b_ExecutorCannotSelectOlderOtherLegPrices`. Updated: `R10…` (`test_R10_ExecutorCannotChooseOutcomeViaOlderOtherLegPrices`), `test_Fill_OtherLegsPricedFromUpdate_MonotonicPerLane` |
| R2-07 (Low) | The haircut was first-come on realisation; a bankrupt account sat in auction while `laneSolvency` was silent | **Accounts with E < 0 when `startAuctions` sees them are closed out at once** through the expiry path (insurance → pool → bad debt; `AuctionExpired`), not auctioned. Residual: an unrealised *winner's* gain stays invisible until it closes (§4) | `R2-07_HiddenInsolvencyFirstCome.t.sol`: `test_R2_07_NegativeEquityClosedOutAtStart_NoAuctionWindow`; residual bound: `test_R2_07b_ResidualUnrealisedWinner_Documented`. Invariant: no auction ever starts with negative equity |
| R2-06 (Low) | R-01 residual: a dip print newer than the lane price | **Accepted** (§4). The loss is bounded by the dip size, and with cure at maintenance the victim can no longer be trapped | `R2-06_R01Residual.t.sol` (kept as a bound, header "ACCEPTED") |
| R2-09 (Info) | Batch gas per account | Documented (§4): about 58k gas per account for `startAuctions` and 74k for `backstopTakeBatch`, so about 400–500 accounts per 30M-gas transaction. The keeper chunks batches | `R2-09_BatchGas.t.sol` (measurement) |
| I2-8 (Info) | One insolvent lane blocked `claimKeeperRewards` for every lane | A lane that cannot pay its share is skipped; its rewards stay claimable | — |
| I2-1 … I2-7 | Info | The vacuous R99 fuzz is superseded by `R2-10c`. Ties, operators per lane, OI capacity needing insurance, and `[]` calls needing fresh storage are documented in §4 | — |

Earlier regressions whose premise changed in v3 were updated, never weakened. Each now asserts the v3 rule:

- `test_R04a` asserts the `topUpAllowance` bound.
- `test_R09` gaps the account to negative equity after the start, because v3 closes it at the start otherwise.
- `test_R02a` puts its second victim at 0 < E < MM.
- `test_R10` asserts that older prices cannot steer; by the R2-03 decision, a newer real price may.

### 1d. v1 review findings → v2 fixes

v3 refines three of these rows (see §1c): the R-01 cure buffer became cure at maintenance (R2-05), the R-04 top-up
exemption became `topUpAllowance` (R2-01), and R-10's "ignore the executor's update" became "use it through the
monotonic lane path" (R2-03).

| ID | Finding | Fix (v2) | Regression test(s) |
| --- | --- | --- | --- |
| R-01 (High) | Prices could move backwards between calls. A caller picked the stale stored push with `[]`. This let bots liquidate healthy accounts, let traders stall auctions by curing them, allowed over-withdrawal, and let LPs exit before a loss | 1. **Per-lane monotonic prices:** `_lanePrice[lane][market]` records the newest price used. Every state-changing call uses the newest of (supplied update, Pyth-stored, the lane price), so nothing older than a price already used in that lane is ever used again.<br>2. **Stored and lane prices are usable for 15 s** (`maxStoredPriceAge`). Supplied updates are usable for 30 s (`maxPriceAge`). Both are bounded to ≤ 60 s.<br>3. **Cure needs equity ≥ 110% of maintenance** (`CURE_BUFFER_BPS`) and is never possible in the auction's start block.<br>4. **LP withdrawals are two-step** (`backstopRequestWithdraw` → `backstopWithdrawDelay`, default 1 h → `backstopWithdraw` at the then-current monotonic NAV, within a 1-day window) | `R01_PriceRegression.t.sol`: `test_R01a_TraderCannotCureWithOlderStoredPrice_PoolTakes`, `test_R01b_HealthyAccountNotLiquidatableWithOlderStoredPrice`, `test_R01c_CannotWithdrawPastInitialMarginWithOlderStoredPrice`, `test_R01d_LpCannotExitAtStaleNav`, `test_R01e_SmallStaleGap_HealthyVictimKeepsEquity`. Unit tests: `ProdReviewFixes.t.sol` `test_LanePrice_*`, `test_CureNeedsBuffer`, `test_BackstopWithdraw_RequestWindowAndCancel`. Invariant: lane prices never regress |
| R-02 | One invalid feed reverted every call carrying a full update, and one unpriceable account reverted its whole batch | A call **parses and validates only the markets it touches**: the batch accounts', the account's, or the pool's. Partial blobs are accepted. An unusable price is cached as unusable and only reverts where that market is actually needed. Batches **skip** unpriceable accounts and emit `AccountSkipped`. `getLiquidatableAccounts` leaves them out. Order executions price other legs from storage or the lane price, never from the blob | `R02_CrossFeedCoupling.t.sol`: `test_R02a_WideConfOnUnheldFeed_DoesNotBlockLiquidations`, `test_R02b_WideConfOnUnheldFeed_MultiLegOrderExecutes`, `test_R02c_UnpriceableAccountIsSkipped_BatchContinues` |
| R-03 | A backstop pool was permanently bricked after an insolvency write-off | When a pool is flat with cash ≤ 0, the deficit is written off against the lane and **all shares are retired by bumping the pool's epoch** (`BackstopPoolReset`). Old LPs' shares are worth exactly 0, which is what the write-off means; `backstopSharesOf` reports current-epoch shares only. The next deposit starts at 1:1 | `R03_PoolBrick.t.sol`: `test_R03_PoolRecoversAfterWriteOff` |
| R-04 | Deposit caps blocked margin top-ups and cures | A deposit by an account holding positions (including one in auction) is a **margin top-up**. It is exempt from the lane TVL cap and from the fixed per-account cap, and is bounded by `maxDepositPerAccount + Σ position margins` instead, so a 1-AUSD position cannot unlock unlimited deposits. It is allowed while paused. Fresh deposits stay capped | `R04_DepositCapBlocksCure.t.sol`: `test_R04a_AccountAtDepositCapCanTopUpAndCure`, `test_R04b_ThirdPartyCannotBlockTopUpsByFillingLaneTvl` |
| R-05 | Lane bad debt was paid with other lanes' AUSD, and `solvency()` stayed true | **Real lane isolation.** AUSD is accounted per lane (`LaneLedger.held`). Losses stay inside the lane: insurance, then the lane's backstop pool cash (`BackstopLossAbsorbed`), then bad debt. Bad debt is borne by the lane's claimants through a **pro-rata haircut on every payout** from the lane (`held / (held + badDebt)`, floored; it also retires the matching debt). A lane never pays more than it holds (`LaneInsolvent`). Fresh deposits and pool deposits into a lane with bad debt are refused (`LaneInDeficit`); `fundLane` repays debt. New views: `laneSolvency(lane)` (surplus = insurance − bad debt, plus `haircutBps`) and `previewWithdraw` | `R05_CrossLaneBadDebt.t.sol`: `test_R05_LaneBadDebtStaysInLane_OtherLaneWithdrawsInFull`. Unit: `test_Waterfall_InsuranceThenPoolThenBadDebt_HaircutRetiresDebt`. Invariant: `invariant_PerLaneIdentity` |
| R-09 | The pool's discount on bankrupt accounts was paid by insurance, and a JIT LP could capture it | The **pool, like an external taker, is paid at most the trader's remaining equity**, `min(P, max(E, 0))`. Insurance only ever absorbs negative equity, exactly as on expiry. LP exits are also delayed | `R08_R09_PoolDiscountExtraction.t.sol`: `test_R09_JitLpNetsNothingOnBankruptAuction_InsuranceNotDrained`. Invariant: the pool is never paid more than the taken accounts' positive equity |
| R-06 | An all-in increase order always failed | On increases the **trading fee is paid out of the order's margin**: the position keeps `margin − fee`, and leverage is checked on the gross margin | `R06_AllInMarginFails.t.sol`: `test_R06_AllInMarginOrderFills` |
| R-07 | The OI cap could be bypassed with a transient pool deposit | `laneOiCap = min(maxLaneOi, lane insurance × oiCapMultiplierBps)`. **Pool cash does not count**, because it can leave; insurance cannot | `R07_OiCapBypass.t.sol`: `test_R07_PoolDepositDoesNotInflateOiCap`. Unit: `test_OiCap_ScalesWithInsuranceOnly_PoolDepositsDoNotCount` |
| R-08 | An empty pool could take auctions when the max discount was ≥ 10% | `auctionMaxDiscountBps ≤ 500` (5%, well below the 10% pool margin), and a pool with no shares never takes | `R08_R09_PoolDiscountExtraction.t.sol`: `test_R08_MaxDiscountCapped_EmptyPoolNeverTakes` |
| R-10 | The executor chose the multi-leg outcome through its price data | Other legs are priced **deterministically**: the newest of Pyth-stored and the lane price, monotonic. The executor's `priceUpdate` is used only for the order's own unique fill price, so every data shape gives the same outcome | `R10_R11_OrderEdges.t.sol`: `test_R10_ExecutorCannotChooseOutcomeViaOtherLegPrices`. Unit: `test_Fill_OtherLegsUseStoredOrLanePrices_NotSupplied` |
| R-11 | A stale reduce order could increase an inherited position | Each order records `reduceOnly` and the **id of the position** it applies to. Each new position gets a fresh per-account id. If the position changed before the fill (taken, closed, inherited, re-opened), the fill fails with `PositionChanged`. A reduce can never increase anything | `R10_R11_OrderEdges.t.sol`: `test_R11_StaleReduceOrderFailsOnInheritedPosition`, `test_R11b_StaleReduceDoesNotTouchInheritedSameSidePosition` |
| I-1 | No circuit breaker for outflows | **Withdrawals stay unpausable, by decision.** See §4 for the rationale | — |
| I-2 | Loose governance bounds | `auctionMaxDiscountBps ≤ 5%`; `maxPriceAge` and `maxStoredPriceAge` ≤ 60 s; `maxConfBps ≤ 5%`; `oiCapMultiplierBps ≤ 10×`; `backstopWithdrawDelay` between 1 min and 7 days. `setMarketConfig` cannot change a feed while the market has open interest (`MarketHasOpenInterest`). `setPyth` also probes `getUpdateFee` | `ProdAdmin.t.sol` `test_ParamBounds`, `ProdReviewFixes.t.sol` `test_SetMarketConfig_FeedFrozenWhileOpenInterest` |
| I-4 | `minExecDelay` of 2 s was thin | Default raised to **3 s** | `test_Commit_EscrowsMarginAndFee` |
| I-7 | Deploy script issues | **Backstop operators are per lane** (`isBackstopOperator(operator, lane)`; keeper *i* operates lane *i* only). The owner must have code unless `OWNER_IS_EOA=true`. Keepers must be distinct from each other, from the guardian and from the multisig | `DeployProd.t.sol`, `ProdAuction.t.sol` (cross-lane reduce reverts) |
| I-8 | Read-only reentrancy | The price cache is invalidated before every outbound native push (refund, cancel push, claim) | — |
| I-9 | Double Pyth fee | `executeOrder` parses the update **once** (the unique fill); other legs need no parse | — |
| I-10 | Dust registrations | The first deposit must be ≥ 1 AUSD (`DepositTooSmall`) | `test_FirstDepositMinimum` |
| I-13 | Keeper scanning reverted on a bad feed | `getLiquidatableAccounts` skips unpriceable accounts | `test_R02c_…` |
| I-5, I-6, I-11, I-12 | Execution fee size; locked funds; funding manipulation; frozen AUSD | Accepted and documented (§4) | — |

## 2. Slither (v5)

- **Tool:** Slither 0.11.6 in an isolated venv. It ran on a clean build into a scratch output directory
  (`forge build --build-info --out <scratch>`, then `slither --ignore-compile --foundry-out-directory <scratch>`).
  Without `--ignore-compile`, crytic-compile runs `forge clean` on the shared `out/`.
- **Scope:** `src/prod/` only.
- **Excluded detectors:** `pyth-unchecked-confidence` and `pyth-unchecked-publishtime`. They crash Slither 0.11.6 on
  `try pyth.getPriceUnsafe(…) returns (…) {}`. Their checks are done explicitly in `_check` (positive price, exponent,
  confidence) and `_candidate` (age), and are covered in `ProdOracle.t.sol`.
- **v5 compared with v4:** 158 results (v4: 156), **no new detector categories**, and no change to any High or
  Medium count except one `uninitialized-local`. The two new entries:
  - `uninitialized-local`: `newest` in `_oldFeedReference`, a zero-initialised accumulator by design;
  - `timestamp` on `_poolEquity`: the flagged comparison is `unrealized < 0`, not a timestamp (false positive).
- **v4 compared with v3:** 156 results (v3: 146), **no new detector categories**. The new entries are the same
  categories at new code:
  - `reentrancy-eth` on `depositWithPrice` and `_executionPrices` (Pyth parse, then state writes). Both run under the
    transient lock (`depositWithPrice` and `executeOrder` are `nonReentrant`);
  - `reentrancy-benign` on `_orderCurrentPrice` and `depositWithPrice`;
  - `incorrect-equality` on `pool.totalShares == 0` (the sweep trigger);
  - `calls-loop` (Pyth `getPriceUnsafe`) and `timestamp` on the new price and feed-age helpers.
  - `cyclomatic-complexity` dropped by one (`replaceMarketFeed` was split into helpers).
- **v3 compared with v2:** no new detector categories either (`reentrancy-eth` on `startAuctions`,
  `divide-before-multiply` in `_closeOut`, `incorrect-equality` on internal status codes, zero-initialised
  accumulators).

| Impact | Detector (count) | Verdict |
| --- | --- | --- |
| High | `reentrancy-eth` (13) | **False positive.** Every state-changing external function except `selfFill` holds the EIP-1153 transient lock (`_enter`/`_exit`), which Slither does not recognise. `selfFill` reverts unless `msg.sender == address(this)`. The external calls are: Pyth (the configured oracle); the refund of excess `msg.value`, which is the last effect and runs after the price cache is invalidated; and the 100k-gas fee push in `cancelOrder`, after all accounting. Tests: `test_Reentrancy_ThroughPyth_Blocked`, `test_Reentrancy_ThroughToken_Blocked`, `test_NativeRefundReentrancyBlocked` |
| High | `arbitrary-send-eth` (2) | **False positive.** The recipient is the configured Pyth contract (timelock-only setter). The amount is exactly `getUpdateFee(update)`, metered against `msg.value` |
| High | `weak-prng` (2) | **False positive.** `_floorDiv` uses `%` for rounding toward −∞, and `laneOf` uses `% 8` for lane sharding. Neither is randomness |
| Medium | `incorrect-equality` (13) | Exact comparisons of values the contract computes itself: zero checks (incl. share supply), size equality, market ids, internal status codes. No balance or timestamp equality |
| Medium | `uninitialized-local` (12) | Zero-initialised accumulators and scratch structs, by design |
| Medium | `divide-before-multiply` (2) | `_inherit` floors the notional, then rounds the taker's margin **up** (conservative). `_closeOut` takes the keeper's half of the floored penalty |
| Medium | `unused-return` (2) | `setPyth` probes (`getPriceUnsafe`, `getUpdateFee`) used only as existence checks |
| Low / info | `calls-loop` (23), `timestamp` (60), `reentrancy-benign` (15), `missing-zero-check` (1), `low-level-calls`, `assembly`, `costly-loop`, `cyclomatic-complexity`, `cache-array-length` | Pyth reads are bounded by 8 markets. Timestamps are used on purpose for staleness and order windows. Setting the guardian to zero disables it (the owner can still pause) |

## 3. Tests and invariants

- **Totals (v5):** `forge test` **272 passed, 1 skipped** (the opt-in fork test, which passes with `MONAD_FORK_RPC`):
  99 demo tests, 104 production tests including the invariant suite, and 69 review regressions.
- **Unit and fuzz tests:** `test/prod/`, `test/review/` and `ProdReviewFixes.t.sol`. The review folder holds 69
  tests: the v1, v2, v3 and v4 PoCs flipped into regressions, the accepted R2-06 bound, the R2-09 measurement, the
  reviewer's R4-05 tests, and the sound-property tests R99, R2-10 and R3-05b. They cover:
  - order timing (unique update, too early or late, replay, cancel windows), the position-id binding, and reduce-only
    orders in auction with a current price strictly newer than the fill;
  - fills: math, rounding, fee out of margin, margin ≤ notional, slippage, leverage, minimum size, OI cap, IM across
    legs, flip;
  - oracle edge cases: stale, confidence, exponent fuzz, non-positive price, newest-wins, partial or malformed updates,
    future skew, monotonic lane prices, other legs from the update, and dead-feed replacement (live 10%, dead 50%,
    zombie feeds dead, references for lanes without a marker);
  - funding: sign, accrual, clamp, settlement, pools;
  - caps: fresh deposits vs the bounded top-up allowance (to 100% of IM), `depositWithPrice`, no new margin above
    the account cap (commit and fill), lane TVL, leverage, minimum size, insurance-only OI;
  - the exact pause semantics and timelock-only admin;
  - reentrancy, fee-on-transfer, over-debit, frozen token, gas starvation;
  - the two-way loss waterfall, the haircut, pool epochs, exits that count no unrealised gain, single-use delayed LP
    withdrawals, the pool receivable (deposit refusals, netting before reset, sweep on the last exit, no last exit
    from an open pool), negative-equity close-out at start, and cure at maintenance;
  - the deploy script;
  - lane storage disjointness (`vm.record`) with a negative control.
- **Invariants:** `test/prod/invariant/ProdInvariant.t.sol`, **16 invariants** at 256 runs × 100 calls:
  - AUSD and native solvency identities;
  - **the per-lane identity** (`held == collateral + insurance + pool cash + keeper rewards − bad debt`, Σ held == the
    token balance, insurance and bad debt never both positive);
  - ledgers equal recomputed state; reserved margin and pending-order index; OI equals positions plus pool bookings;
    LP shares sum to supply; auction-list consistency;
  - no account loses more than its equity, and external takers are never subsidised;
  - **lane prices never move backwards** (markers restart only when a feed is replaced, and must then be reset); **the
    pool is never paid more than the taken accounts' positive equity; no LP withdrawal before its delay; no auction
    ever starts with negative equity** (checked from the `AuctionStarted` event);
  - caps hold: every deposit's capped part obeys both caps (for `depositWithPrice` the exemption is re-derived after
    the call), only `topUpAllowance` is exempt, an order adding margin never leaves margin above notional, and **no
    margin-adding increase is committed or filled while the account is above the cap** (v5, R4-03);
  - pause blocks exactly the specified operations, only the timelock changes parameters (feed ids excepted, see
    below), no panics;
  - **new in v4 (I3-4):**
    - `invariant_PoolReceivableBookkeeping`: per lane, `backstopReceivable` equals Σ `BackstopLossAbsorbed` −
      `BackstopRepaid` − `BackstopReceivableNetted` − forgiven (`BackstopSwept`), exactly, from the events of every
      call; insurance and a receivable are never both positive; and **an empty pool (no shares) holds no cash, no
      receivable and no positions**;
    - `invariant_LpValueConserved`: around every pool deposit, NAV grows by exactly the deposit, the old LPs' value
      per share does not fall and the new LP's shares are worth at most what it paid; around every withdrawal the
      exiting LP gets at most its NAV share (before the haircut) and the stayers' value per share does not fall; and
      **no deposit ever succeeds with a receivable outstanding or the NAV cap binding**;
    - `invariant_MarketFeedsFollowGovernance`: every market's feed is the one the timelock last set.
  - **new in v5:**
    - **fair-value ghost (I4-5)** in `invariant_LpValueConserved`: every exit is paid at most its share of the pool's
      ledger cash, an independent bound in which unrealised gains, the receivable and insurance never count, so no
      manipulation of them (R4-01) can lift an exit;
    - **empty-pool ghost (R4-02)** in `invariant_PoolReceivableBookkeeping`: at the moment an exit empties a pool, the
      pool holds no position, no cash and no receivable (checked then, before a later unwind could hide it);
    - handler paths: a third of the drains first unwind to a **dust** remainder (the last exit must be refused until the
      operator closes it), a third of the dead-feed swaps face a **zombie** old feed (fresh, 5% confidence), and
      `bigWinner` takes profits above the cap out before re-opening.
  - New handler paths: `replaceFeed` (scheduled and executed through the **real TimelockController** after its 24 h
    delay, with the old feed live or dead), `drainPool` (operator unwind of every pool position, then every LP out:
    resets and sweeps), `bigWinner` (a large winner drains insurance and pool cash: the receivable),
    `poolStress` (scripted pool take, then a gap against the pool, a binding NAV cap or netting), and
    `depositWithPrice` for holders. Pool liquidity is now held by the handler's LPs so pools can actually empty.
    Foundry's `recordLogs` also returns logs of reverted call frames, so the event ghost skips what a failed
    `selfFill` emitted (found while building this; it would otherwise mis-count fee repayments).
  - Two deterministic coverage tests: the crash sequence, and `test_HandlerCoverage_PoolsFeedsReceivable` (three feed
    swaps incl. a zombie, then each pool-stress mode from the same snapshot in every lane; asserts every R3-01 and v5
    pool path is hit, incl. dust drains and refused last exits).
  - **Path coverage (v5)** summed over every invariant run (4,112 runs, logged with `PROD_INV_COVERAGE`):
    - **feed replacement through the timelock:** 10,832 attempts, 9,017 executed (4,731 with a dead old feed, 1,871 of
      them a zombie), 1,815 rejected by the deviation check;
    - **pool receivable:** 7,003 absorptions, 5,198 repayments, 638 nettings, 1,847 resets, 1,490 sweeps (every one
      forgiving a receivable; orphaned-cash sweeps: 0, now unreachable since the last exit needs a flat pool, I4-4);
    - **refused pool deposits:** 651 with a receivable outstanding, 1,040 with the gain above insurance;
    - **LP checks:** 10,456 deposit and 19,679 withdrawal conservation checks; 19,679 fair-value checks; 15,684 pools
      emptied by a drain; 158 dust drains with 163 refused last exits (`BackstopPositionsOpen`);
    - **cap rule (R4-03):** 1,918 margin-adding commits refused above the cap;
    - `depositWithPrice`: 4,656 (1,214 with an exempt top-up); margin top-ups through `deposit`: 2,074;
    - 32,256 commits; 2,219 fills; 1,296 failed fills; 2,593 cancels;
    - 1,402 auctions started and 19,205 negative-equity close-outs at start; 4,952 pool takes; 396 external takes;
      435 cures; 786 expiries; 8,952 pool reduces;
    - 10,832 pause toggles; 10,896 rejected admin attacks.
- **Real chain:** `ProdForkTest` (opt-in, `MONAD_FORK_RPC`) runs commit, execute and withdraw against the real AUSD and
  the real Pyth `0x2880…`, using a signed update captured from the chain. `executeOrder` costs 854k gas with real
  verification (v5: 854,784).

## 4. Residual risks and trust assumptions (read before launch)

### 4.0 Accepted for the capped beta at v5 (sha256 `1643014507eaf16afd06d25a50d2f9bdac8a0556ede00f960cc9fcbda702a5ed`)

The v5 verification (REVIEW.md, "v5 verification") passed the adversarial-review item of the launch gate:
no Critical, High or Medium open. The following are **accepted in writing** for the capped beta, so the
reviewed and rehearsed hash stays unchanged, and are scheduled for the first post-launch upgrade:

- **R5-02a (Low): `take` can book inherited margin while collateral is above `maxDepositPerAccount`.**
  Requires a supply of same-lane auctions (in practice the attacker's own accounts liquidated on purpose,
  paying the auction discount each time) and is bounded by lane open-interest capacity and the beta caps
  (50 AUSD per account, 500 AUSD per lane). Planned fix: apply the `CollateralAboveCap` check in `take`.
- **R5-02b (Info, UX):** an account above the cap from profits must withdraw down to the cap before
  opening new positions. The app explains this.
- **R5-02c (Info):** a fresh, wide-confidence print of a live feed pushed right before a timelocked swap can
  make the feed look dead and unlock the 50% bound. Only governance (multisig behind a 24 h timelock) can
  swap feeds. Planned fix: require the feed to be unusable for at least `DEAD_FEED_AGE`.
- **I5-1 / I5-2 (Info):** the last LP's exit depends on the keeper unwinding the pool (`poolexit.ts`); a
  griefer can delay a feed-swap recovery for lanes without a recorded price until governance re-proposes.


1. **Not audited.** The launch gate in `docs/PRODUCTION_PLAN.md` applies. Keep the caps tiny.
2. **Agora AUSD is centrally controlled.** It is upgradeable instantly by an EOA-owned ProxyAdmin with no timelock.
   EOA role holders can freeze any account (including this contract), pause transfers, and burn from any address.
   - A burn from the clearinghouse makes `solvency().surplus < 0`.
   - A freeze blocks deposits, withdrawals and claims; trading continues internally.
3. **Pyth governs the price, and stored prices expire after 15 s.**
   - Hermes needs an API key. `[]` calls (the frontend's `withdraw`, pool operations, cure) need a Pyth-stored or
     lane price no older than 15 s. Monad's own on-chain pushes were measured 60–143 s apart.
   - **The keeper's on-demand Pyth pusher (`updatePriceFeeds`) is a GLOBAL write**: Pyth's storage slot for each feed is
     shared by every lane, so every push conflicts with every other transaction that reads that feed's stored price,
     in all lanes, under parallel execution. It is the one deliberate global writer in the price path, a "star" like
     `updateFunding`, and should run at a bounded cadence.
   - **Multi-leg order executions and auction batches do not need it in v3**: they take prices from the supplied
     update through the lane path. It is only needed for the `[]` paths, and as the app's fallback through the proxy.
   - **Margin top-ups no longer need it in v4** (R3-04): `depositWithPrice` resolves the account's markets from the
     trader's own update. Plain `deposit` and the `topUpAllowance` view still read storage / lane prices only.
4. **Residual price selection (R-01, R2-06; accepted).**
   - Within a lane, prices only move forward. But the first caller after a quiet period can still choose any real Pyth
     message newer than the lane's and the stored price: supplied updates up to 30 s old, stored up to 15 s.
   - A same-lane bot that sees a short dip can start an auction, and take in the same block at 0 bps, on an account
     that is healthy at the live price. The victim loses the dip-to-live difference: in the PoC, 6.33 AUSD on 1,900
     notional for a 0.34% dip.
   - With v3's cure at maintenance, the victim is no longer trapped in a running auction.
   - The same window lets an executor pick among **newer** prices for an order's other legs (R2-03). It can never pick
     older ones.
   - **In-auction reduces (R3-05 residual).** The "current" price must be strictly newer than `execAfter` and ≤ 15 s
     old, whatever the blob order. Within that window the executor (possibly the trader) still chooses which real
     price to supply. A keeper that executes in the same second as `execAfter` gets `StalePrice` and retries.
   - **Close-out at a dip (I3-3).** Close-out at start is permissionless at a caller-chosen newer price, so a dip print
     with equity < 0 means an immediate close-out without an auction or a cure. Bounded by the same window; the lane,
     not the caller, receives the difference.
5. **First-come on realisation (R2-07 residual).**
   - Accounts with negative equity are now closed out as soon as `startAuctions` sees them, so their loss is booked at
     once.
   - But a lane's deficit created by an **unrealised winner** (a profitable position the lane cannot fully pay) is
     only visible when the winner closes. Withdrawals before that are paid in full, and later ones are haircut.
   - The haircut is computed on realised claims. Holders can top up into a deficit lane within their
     `topUpAllowance`, and those top-ups are exposed to the haircut. Bounded by the winner's gain beyond lane
     insurance plus pool cash (`test_R2_07b`).
6. **LPs are the second loss layer** after insurance. What the pool pays is a **loan to the lane**, repaid from later
   lane inflows before insurance (`backstopReceivable`). Since v4 (R3-01) and v5 (R4-01, R4-02):
   - **Pool deposits are refused while the lane has bad debt, while a receivable is outstanding, or while the pool's
     unrealised gain exceeds lane insurance** (`backstopDepositStatus(lane).open`). Deposits are priced at the full
     NAV (cash + uncapped unrealised PnL).
   - **Deposit-closure DoS (I4-1).** Any of the three states can be held open for a while on purpose: a hedged pair
     whose winner has closed and whose loser stays open keeps the lane in deficit or owing the pool, at the cost of
     fees and a live losing position. Natural lane inflows (fees, trader losses) and `fundLane` clear all three (bad
     debt first, then the receivable, which goes to the LPs, then insurance). It does not matter for safety:
     liquidations keep working through the existing pool capacity and expiry. **Ops alert:** page when
     `backstopDepositStatus(lane).open == false` lasts (e.g. > 1 h), and decide whether to `fundLane`.
   - **Exits are priced at `cash + min(unrealised, 0)`** (v5): the receivable and unrealised gains count 0 until
     realised; losses count in full. Insurance never enters an exit price, so the R4-01 hedged-pair lift (and the v4
     variant that depressed it) is gone. **An LP who exits while the pool has an unrealised gain or a receivable
     forfeits its share of it** to the LPs who stay; **the last LP out forgives the receivable** (`BackstopSwept`).
     Exits stay open unless that NAV is ≤ 0.
   - **The last shares cannot leave while the pool holds any position** (`BackstopPositionsOpen`, v5). The lane's
     operator (keeper *i* for lane *i*) or the timelock must unwind the remainder (even dust) with `backstopReduce`
     first; for a lane without an operator that takes the 24 h timelock.
   - A flat pool whose cash goes negative nets its receivable first; only cash + receivable ≤ 0 resets it (all shares
     retired, `BackstopPoolReset`).
   - **Standing exit option (I3-2):** an LP can keep a ripe request for part of its position by alternating requests
     across two or more addresses. Minor.
   - LPs exit once per request, after a 1 h delay, within a 1 h window.
7. **Dead feed (R2-02, R3-02) — procedure.** If Pyth stops publishing a listed feed (deprecation or re-issue):
   1. Find the replacement feed id on Pyth and push its price on chain, so its stored price is ≤ 15 s old when the
      transaction executes.
   2. The multisig schedules `replaceMarketFeed(market, newFeed, maxDeviationBps)` on the timelock (24 h). The bound
      may be up to **5,000 (50%) if the old feed is provably dead** when the call executes (Pyth has no stored price
      for it, the stored one is older than `DEAD_FEED_AGE` = 1 h, or it is unusable: non-positive, bad exponent or
      confidence above `maxConfBps`, a "zombie", v5), and up to 1,000 (10%) otherwise. Choose the
      smallest bound that covers the move since the old feed's last price.
   3. When the timelock executes, the call checks the new price against every lane with open interest (its last-used
      price; for a lane that never recorded one, the old feed's stored price with its confidence ignored, else the
      market's newest price in any lane), resets the market's lane prices, and repoints the market.
   4. Positions settle at the new feed's prices from then on.

   - If the old feed comes back during the delay (anyone pushes it), it is live again and a bound above 10% reverts
     `InvalidParam`; re-propose. Beyond 50% no swap is possible and the market's accounts stay frozen until the price
     comes back within range; there is no admin settlement path, by design.
   - **Live-feed swaps (I3-1).** The function does not require the old feed to be dead. Used on a live feed with a
     basis to the new one, the swap is public 24 h ahead, and traders can position for the (≤ 10%) mark jump; lanes
     without OI skip the deviation check. Use it for dead feeds only, or pause increases across the swap.
8. **AUSD is treated as USD.** There is no depeg handling; a Pyth AUSD/USD feed exists for alerting.
9. **Counterparty:** each lane's insurance fund. Correlated markets are not netted.
   - OI capacity needs insurance (5× by default). Insurance can never be withdrawn (I-6 and I2-5), so seed it
     deliberately.
   - Lanes with no keeper operator (index ≥ the number of `KEEPER_ADDRESSES`) can only have their pools reduced through
     the 24 h timelock (I2-4).
10. **Keeper liveness.** Orders expire after `maxExecDelay` (60 s) and are refunded; a user who runs their own executor
    during an outage holds a free option bounded by that window. The auction lasts about 8 s at Monad block times.
    - **Batch gas (R2-09):** about 58k gas per account for `startAuctions` and 74k for `backstopTakeBatch` (Foundry
      pricing; Monad charges more for cold state). That is about 400–500 accounts per 30M-gas transaction. The keeper
      chunks batches at about 200.
11. **Withdrawals cannot be paused, by decision (I-1).** The guardian's `pause()` blocks new risk: fresh deposits, pool
    deposits, and committing or executing increase orders. It does not block withdrawals, margin top-ups, reduce or
    close orders, liquidations or pool exits. Rationale:
    - Users' funds must never be held hostage by a hot key or a compromised guardian.
    - Liquidations must keep running in a crash.
    - Every outflow is already bounded by health checks at monotonic verified prices and by the per-lane isolation
      (a lane can only pay out what it holds).
    - The cost: an oracle compromise or a pricing bug could drain a lane before the timelock (24 h) can act. This is
      bounded by the beta caps (which v3 makes binding again, R2-01) and by lane isolation.
12. **Locked funds (I-6).** Lane insurance, including seeded funds, and stray AUSD donations can never leave the
    contract. There is no sweep or migration path. Seed insurance with that in mind.
13. **Fees and gas.** Monad bills the gas **limit**. `executeOrder` with real Pyth verification measured about 854k gas
    for a 20-feed blob. When the account has other legs, the update is parsed twice (fresh and unique). **A reduce in
    auction parses it three times** (other legs, current price, unique fill: I4-3), so it pays **three Pyth fees if
    Pyth's update fee ever returns** (it is 0 on Monad today); the executor must send that as `msg.value` (excess is
    refunded). The keeper should read `getUpdateFee` per call rather than assume 0. `minExecutionFee` (0.1 MON) is cheap; commit spam costs little (I-5).
    Retune it via the timelock.
14. **Unpausing takes 24 h** (timelock).
15. **Contract size: 51,876 B runtime, 53,238 B initcode.** This exceeds Ethereum's initcode limit but is within
    Monad's (256 KB). Local and forked EVMs need `--code-size-limit 131072`, which also raises the initcode limit.
16. **Same-second price ties (I2-2).** A supplied or stored price wins a tie against the lane price, so a caller can
    switch between the 2–3 prices Pyth publishes within one second. Negligible.
17. **Dead code (I3-5, I4-4).** The `acct.collateral > 0` penalty branch of `_closeOut` cannot run from `_startOne`,
    which only closes out accounts with negative equity (no keeper reward is due then). The orphaned-cash branch of
    `_poolSweepIfEmpty` is unreachable since v5 (the last exit needs a flat pool and is paid all of its cash). Both are
    left in place as defensive code; harmless.
18. **Review status.** The v4 re-review found no Critical, High or Medium (the review item of the launch gate passes);
    v5 fixes its four Lows and has been mutation-tested and invariant-tested here, with only the v5 delta left for the
    reviewer. The mechanism count has grown with every round; an external audit is needed before the caps rise.
19. **No new margin above the account cap (R4-03, v5).** While an account's collateral is above
    `maxDepositPerAccount` (through rescue top-ups or realised profits), it cannot commit or fill a margin-adding
    increase (`CollateralAboveCap`); reduces, closes and margin-free increases still work. Withdrawing down to the cap
    re-enables new margin. Rescue top-ups therefore can exceed the cap by the account's own drawdown only.
20. **Current-price window (I4-2).** For an in-auction reduce, the executor still picks which real Pyth print newer than
    `execAfter` (and ≤ 15 s old) counts as current (`R4-05b`). Accepted, same class as R2-06.
