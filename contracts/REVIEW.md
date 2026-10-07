# Adversarial review: `ParaclrClearinghouseProd` (pre-mainnet)

**Status:** internal adversarial review, not an audit. Reviewer did not write the code.
**Current status:** v5 verified (scoped). **v5 passes the review item of the launch gate.** See
[v5 verification](#v5-verification) directly below. The v4, v3 and v2 re-reviews and the original v1 review follow it
unchanged.

---

## v5 verification

**Scope:** scoped verification of the R4 fixes and the v5 diff only; this is not a full round.
**Revision:** sha256 `1643014507eaf16afd06d25a50d2f9bdac8a0556ede00f960cc9fcbda702a5ed`. The hash was the same at the
start and the end of the verification.
**Tests:** `test/review/*` passes **75/75**, including the new `R5-01` (regressions, keep them) and `R5-02` (findings)
files.

### Did each R4 fix close its finding?

| R4 | Verdict | Evidence |
| --- | --- | --- |
| R4-01 | **Fixed** | The exit NAV is `cash + min(unrealised, 0)`. The R4-01 loser-first insurance lift no longer moves the exit NAV, and the LP is paid exactly half the cash (`test_R5_01a`) |
| R4-02 | **Fixed** | The last share can't leave while the pool holds even dust (`BackstopPositionsOpen`). Once the pool is flat, the exit sweeps, and supply, cash and receivable all end at 0 (`test_R5_01b`) |
| R4-03 | **Fixed for the order path** | Margin-adding commits and fills revert `CollateralAboveCap`. A Low residual remains through `take` (**R5-02a**) |
| R4-04 | **Fixed** | A wide-confidence zombie feed now counts as dead, and a 50% swap recovers the market (`test_R5_01c`). The reference ignores confidence and falls back to the newest marker |

**Rewritten tests:** `test_R2_04a`, `test_R2_04b` and `test_R3_01d` were **not weakened**.

- R2-04a is stricter than before: exits value gains at 0, and the LP who stays gets the realised gain.
- R2-04b and R3-01d still assert the refusal while the cap binds, entry at the full NAV, and no dilution of old LPs.

### New in the v5 diff

| ID | Severity | Finding | PoC |
| --- | --- | --- | --- |
| R5-02a | Low | R4-03 residual. `take` (`_inherit`) books new margin while collateral is above the cap, funded by exempt top-ups. Later dips are topped up exempt on the larger IM. **PoC:** 1.81 AUSD of margin inherited at a collateral of 54.70 (cap 50). Needs a supply of same-lane auctions (costly Sybils) and is bounded by OI capacity. **Fix:** apply the `CollateralAboveCap` check in `take` too | `R5-02_TakeBypassesCollateralCap.t.sol` `test_R5_02a` |
| R5-02b | Info (UX) | A trader whose collateral is above the cap *from profits* can't open any new position until it withdraws down to the cap (`CollateralAboveCap`). **Fix:** tell users in the UI, or only count exempt deposits against the cap | `test_R5_02b` |
| R5-02c | Info | `_feedIsDead` trusts the *newest* stored price's usability. Anyone can push a newer, real, wide-confidence print of a **live** feed right before a timelocked swap executes, which unlocks 50%. This weakens the "refutable during the delay" property. Governance-only, and weaker than `setPyth`. **Fix (optional):** require the feed to have been unusable for ≥ `DEAD_FEED_AGE` | `test_R5_02c` |
| I5-1 | Info | **R4-02 guard and DoS.** The last LP can't fully exit while the pool holds any position. The keeper's new `poolexit.ts` unwinds positions when the last LP's request is ripe. A griefer could still re-fill the pool between that unwind and the exit, but only by having its own account liquidated and taken (costly), and governance can stop takes with `setBackstopMinDiscount`. LPs who aren't last are unaffected. Acceptable | — |
| I5-2 | Info | **R4-04 reference fallback.** For lanes with OI but no marker, the reference is now the old feed's last stored price, even if that price is unusable (zombie). A griefer can push the zombie's most deviant recent print into storage to make the deviation check fail for those lanes, which delays recovery until governance re-proposes. Bounded by the 50% allowance | — |

### Launch-gate verdict for v5

**Pass on the adversarial-review item.**

- No Critical, High or Medium is open.
- The open Lows are R4-01 to R4-04 (fixed, except for the R5-02a residual) and R5-02a itself. **Accept in writing or
  fix:** R5-02a is a one-line `CollateralAboveCap` check in `take`.
- **Still to run on this hash:** Slither, the fork rehearsal, and the beta caps as deployed.
- **Before caps rise:** an external audit.

---

## v4 re-review

**Date:** 2026-10-07.
**Revision:** `src/prod/ParaclrClearinghouseProd.sol` sha256 `3e30e901…09df19`. The hash was the same at the start and
the end of this round. `script/DeployProd.s.sol` is unchanged since v3.
**Baseline:**

- `forge test`: **267 passed, 1 skipped** (the opt-in fork test), invariants included.
- `forge test --match-path 'test/review/*'`: **64 passed**. That is the flipped v1, v2 and v3 regressions plus 7 new
  `R4-xx` tests.

Every `R4-0x` finding test asserts that the problem exists today. `R4-05a` is a regression for a property found sound,
and `R4-05b` documents an accepted residual.

### Verdict on the launch gate (v4)

**Does v4 pass the launch gate? Yes, for the adversarial-review item.**

The gate's condition is: no Critical or High open, and every Medium fixed or explicitly accepted with bounded impact
under the beta caps.

- **Every R3 finding is fixed.**
- **This round found four new Lows (R4-01 to R4-04) and some informational notes. None is Medium.** Each is bounded
  under the beta caps.
  - R4-01 is a risk transfer between LPs, worth up to an LP's share of the pool's gain above insurance.
  - R4-02 is worth up to one receivable (≤ pool cash) and needs a dust pool position.
  - R4-03 is bounded by the lane's OI capacity, and the holder carries real leverage risk on every cycle.
  - R4-04 only matters for a zombie feed combined with a >10% move.
- **Recommended before launch, because they are cheap:**
  - **R4-02:** one guard line.
  - **R4-04:** a usability-based dead-feed test.
  - **R4-03:** a cap check on margin-adding increases.
- **Otherwise, accept them in writing** (SECURITY_NOTES §4).

**Remaining gate items:**

- Slither on the final hash.
- The anvil fork rehearsal against real AUSD and Pyth.
- Beta caps set as deployed.

**After launch:** an external audit before any cap is raised. The mechanism count has grown with every round, and four
rounds of an internal review do not replace one.

### Did each v3 fix close its finding?

I checked the flipped tests and wrote variants beyond them.

| v3 | Verdict | Evidence |
| --- | --- | --- |
| R3-01 (receivable / NAV) | **Fixed on the deposit side.** The exit side has a new Low (**R4-01**), and a dust edge case has another (**R4-02**) | Deposits are refused while a receivable is outstanding, while the gain cap binds, or while the lane has bad debt. When a deposit is allowed, the full and the capped NAV are equal, so the entry/exit asymmetry gives no extraction on entry. The receivable is netted before any reset, and an empty, flat pool is swept and its receivable forgiven |
| R3-02 (dead feed > 10%) | **Fixed for feeds that stop publishing.** New Low for zombie feeds (**R4-04**) | Up to 5,000 bps once the stored price is missing or more than 1 h old. Refutable during the 24 h delay by pushing a fresh old-feed message (by design) |
| R3-03 (top-up ratchet) | **Fixed for the free 10%.** A residual through volatility remains (**R4-03**) | The target is 100% of IM: an exempt top-up alone can no longer fund new margin |
| R3-04 (stale storage) | **Fixed** | `depositWithPrice`. Fees are exact, excess is refunded, escrow is untouched, and the update is ignored without positions (`R4-05a`) |
| R3-05 (blob order) | **Fixed.** A bounded residual remains (`R4-05b`, Info) | "Current" must be published after `execAfter` and within 15 s. The executor still picks *which* newer print counts (the accepted R2-06 class) |

**Updated older tests:**

- `test_R2_01b` now asserts the 100% target and is still bounded.
- `test_R2_02` still recovers end to end, including the 50% dead-feed bound.
- `test_R2_04b` now expects the refusal while the cap binds, and an undiluted entry once it doesn't.

**None of the three was weakened.**

### Is the invariant handler vacuous for the new paths?

**No.** I summed the coverage log over 257 runs:

- **Feed swaps:** 715 `replaceFeed` calls (591 succeeded, 322 of them in dead-feed mode, 124 rejected).
- **Receivable:** 445 absorptions and 321 repayments.
- **Pool settlement:** 43 nettings, 99 resets, 110 sweeps with forgiveness.
- **Refused deposits:** 37 for an outstanding receivable and 60 for the gain cap.
- **Conservation checks:** 690 deposit and 1,230 withdraw conservation checks.
- **Other new paths:** 70 `depositWithPrice` top-ups and 1,135 close-outs at start.

There are two gaps:

- **`pool.sweptCash` is never hit.** That branch is only reachable through a dust position (R4-02), and the handler
  never creates one.
- **`invariant_LpValueConserved` can't catch R4-01.** It compares each exit with the contract's own NAV, so it is blind
  to a NAV that is itself manipulated.

### New findings in v4

| ID | Severity | Title | PoC (`contracts/test/review/`) |
| --- | --- | --- | --- |
| R4-01 | Low | The exit NAV cap follows insurance, which a hedged pair can raise for one block | `R4-01_ExitNavInsuranceInflation.t.sol` |
| R4-02 | Low | A dust pool position skips the sweep, so the next depositor takes the repaid receivable | `R4-02_DustPositionSkipsSweep.t.sol` |
| R4-03 | Low | R3-03 residual: exempt top-ups made in a dip are free collateral after the recovery | `R4-03_OscillationRatchet.t.sol` |
| R4-04 | Low | A zombie feed (publishing, never usable) is classified as live, so the 50% bound never applies | `R4-04_ZombieFeed.t.sol` |
| I4-1 … I4-5 | Info | See below; `R4-05b` documents the current-price window | `R4-05_DepositWithPriceAndCurrentWindow.t.sol` |

#### R4-01 (Low): exit NAV can be lifted for one block

**Where:** exits are priced at `cash + min(unrealised, insurance)` (`_poolEquity`, L2764).

**What:** a hedged pair in the lane closes its *loser* first, which credits insurance and lifts the cap. A ripe LP
request exits at that moment, and then the winner closes, which drains insurance back down.

**PoC:** the pool's gain is 206.7 against insurance of about 147.

| | AUSD |
| --- | --- |
| NAV lift during the window | 59.10 |
| Attacker paid | 1,104.66 |
| Fair half of the capped NAV | 1,075.11 |
| Victim left with | 1,046.19 |
| Receivable the victim holds alone after the unwind | 58.47 |

**Severity:** Low. The excess is not lost but becomes a receivable, so this is a risk and liquidity transfer to the
LPs who stay, not a theft.

**Fix (either):**

- Price exits at `cash + min(unrealised, 0)`. Gains are paid only once realised.
- Cap at `min(insurance now, insurance at request time)`.

#### R4-02 (Low): a dust position skips the sweep

**Where:** `_poolSweepIfEmpty` (L2949) returns early if `markets.length != 0`. `backstopWithdraw`'s margin guard
requires 0 when the exposure floors to 0.

**What:** if the pool holds a dust position, the last LP exits, but the receivable is not forgiven. The lane's repayment
then lands in a share-less pool, and the next depositor mints 1:1. Dust can come from an operator's partial
`backstopReduce`, or permissionlessly from netting against an account sized to leave dust.

**PoC:** a dust position of 1e11 base units. A **27.17** receivable is repaid into the empty pool, and the next
depositor puts in **1 AUSD and withdraws 28.17**. This breaks the v4 invariant `supply == 0 ⇒ no positions, no cash,
no receivable`.

**Fix:** refuse a withdrawal that would leave `totalShares == 0` while `markets.length != 0`. Or close any remaining
position at mark against the lane before sweeping.

#### R4-03 (Low, accept or one check): the ratchet through volatility

**Where:** `topUpAllowance` (L930) together with `_commitChecks` (L1072).

**What:** a top-up only restores IM, but the money isn't marked as exempt. After the price recovers, the same amount is
free collateral and can fund new margin.

**PoC:** at 10x, 22 round trips of ±1% take one account to **396.98 AUSD** (cap 50), with **348.95 deposited outside
the caps**. The bound is still the lane's OI capacity, and the user is at 10x through each dip.

**Fix:** refuse margin-adding increases while `collateral > maxDepositPerAccount`. Or track exempt deposits per
account and exclude them in `_commitChecks`.

#### R4-04 (Low): zombie feeds count as live

**Where:** `_feedIsDead` (L735) looks only at the stored publish time.

**What:** a feed that keeps publishing with a confidence wider than `maxConfBps` freezes positions, as in R2-02, but
counts as live. So `replaceMarketFeed` stays at 10% from the frozen marker.

**PoC:** a 5% confidence, and the new feed is +13%. Requesting 5,000 bps reverts `InvalidParam`, and 1,000 bps reverts
`FeedSwapDeviation`. The account stays frozen.

**Fix:** also classify the feed as dead when its newest stored price fails `_check` (unusable). An intermittent feed
that a third party keeps "live" by pushing during the delay stays refutable by design.

#### v4 informational

- **I4-1 (deposit refusal as DoS).** Any of the three refusal states (bad debt, receivable, cap binding) can be held for
  a while by an attacker. It takes a hedged pair whose winner has closed and whose loser stays open, at the cost of fees
  and a live losing position. All three are cleared by `fundLane`: bad debt first, then the receivable (which goes to
  the LPs), then insurance. Natural trading fees and losses in the lane also clear them. Liquidations keep working
  through the existing pool capacity and expiry, so a closed pool doesn't stop liquidation. **It doesn't matter for
  safety.** Ops should alert on `backstopDepositStatus().open == false` that lasts.
- **I4-2 (current-price window).** In `_orderCurrentPrice` the executor still picks which print newer than `execAfter`
  counts as current. `R4-05b` shows the same order failing at 2.80 and escaping at 2.95. This is the accepted R2-06
  class, now bounded to at most 15 s.
- **I4-3 (triple fee).** An in-auction reduce parses the blob three times: other legs, current price, and the unique
  fill. That is three Pyth fees if fees ever return.
- **I4-4 (dead sweep branch).** The `swept` cash branch of `_poolSweepIfEmpty` can only be reached through dust (R4-02).
  Without R4-02, `supply == 0` already implies `cash == 0`.
- **I4-5 (LP invariant).** `invariant_LpValueConserved` checks consistency with NAV, not that NAV is fair. Consider a
  ghost "fair NAV" in the handler (cash plus realisable gain plus receivable) to catch R4-01-style cases.

#### Checked and found sound in v4

- **Deposit gates.** `_poolSettleIfBroke` runs first, so a settlement that creates bad debt is refused. Then bad debt,
  the receivable, the TVL cap, and the gain cap are checked. Under all gates, the full and the capped NAV are equal at
  entry.
- **Netting.** The pool's realised loss first repays bad debt through `_creditLane`. Netting then moves the same amount
  from the receivable back into bad debt: the receivable shrinks by the pool's loss, bad debt is unchanged, and
  `insurance == 0` holds whenever the receivable is positive. A reset only happens when cash plus receivable ≤ 0.
- **Sweep.** It forgives the receivable and credits orphaned cash through `_creditLane` (bad debt, then insurance).
  `LaneInDeficit` is consistent with it.
- **`depositWithPrice`.** It is `nonReentrant` with `refundsExcess`. It charges exactly the Pyth fee and never spends
  escrow. The update is ignored for accounts without positions. Prices only advance monotonically, as with any other
  call (`R4-05a`).
- **Dead-feed rule.** It is evaluated at execution time. Pushing a fresh old-feed message during the delay turns a
  50% proposal into `InvalidParam`, which is the intended refutation. The new feed must be fresh and valid. The swap
  resets markers.

---

## v3 re-review

**Date:** 2026-10-07.
**Revision:** `src/prod/ParaclrClearinghouseProd.sol` sha256 `c2ed9f9a…05bcd4a8`. The hash was the same at the start
and the end of this round. `script/DeployProd.s.sol` is unchanged except for a new `topUpTargetBps` output key.
**Baseline:**

- `forge test`: **247 passed, 1 skipped** (the opt-in fork test), invariants included.
- `forge test --match-path 'test/review/*'`: **50 passed**. That is the flipped v1 and v2 regressions plus 9 new
  `R3-xx` tests.

Every `R3-0x` finding test asserts that the problem exists today. Flip each one when it is fixed. `R3-05b` is a
regression for a property found sound.

### Verdict on the launch gate (v3)

**Does v3 pass the launch gate? No, not yet. It is close.**

- **Critical/High: none open.**
- **Mediums open: R3-01, R3-02, R3-03.**
  - **R3-01 should be fixed, not accepted.** It is a value transfer between users: a new LP takes the receivable that
    belongs to existing LPs, and a pool reset destroys it. The fix is small (see below).
  - **R3-02 and R3-03 can be accepted in writing with a stated bound**, or fixed with about one line each.
    - R3-02 only matters if a Pyth feed dies *and* the market moves more than 10% before the timelock acts.
    - R3-03 is bounded by the lane's OI capacity. Its one-line fix is `TOP_UP_TARGET_BPS = 10_000`.
- After those changes, re-run the invariants, Slither and the fork rehearsal on the final hash. With R3-01 fixed and
  R3-02 and R3-03 fixed or accepted, I see no remaining blocker for the capped beta.

### Did each v2 fix close its finding?

I checked the flipped tests and wrote variants beyond them.

| v2 | Verdict | Evidence |
| --- | --- | --- |
| R2-01 (top-up ratchet) | **Partly fixed**, see **R3-03** | `MarginAboveNotional` stops dust margin, and the exemption needs equity below IM. But the 110% target leaves 10% of free, exempt collateral that a ~1x increase can book as margin. One 5e-8 USD down-tick then re-opens the exemption. 28 orders give **719.76 AUSD** in one account (cap 50) and a lane TVL of 719.76 (cap 500). Bounded by OI capacity |
| R2-02 (dead feed) | **Partly fixed**, see **R3-02** | `replaceMarketFeed` works for small moves. The 10% hard cap is measured against the *frozen* last price, though, so after a >10% move recovery is impossible for good |
| R2-03 (multi-leg / steering) | **Fixed by decision** | Other legs come from the executor's blob via the monotonic path. No push is needed. Steering is limited to *newer* prices (the accepted R2-06 residual) |
| R2-04 (NAV / standing requests) | **Fixed**, with a new side effect, see **R3-01d** | Gains in NAV are capped at insurance, and requests are single-use with a 1 h window. The cap is tied to insurance, and insurance can be drained and refilled within seconds. Info: an LP can still keep a ripe request for part of its position by alternating across addresses |
| R2-05 (cure trap) | **Fixed** | The cure is at maintenance again, and reduce-only orders work in auction. A bankrupt full close in auction fails (`R3-05b`). New Low: **R3-05** |
| R2-06 (dip print) | **Accepted residual** (Low) | — |
| R2-07 (hidden insolvency) | **Fixed for accounts already negative at start** | They are closed out in `startAuctions`. Accounts that go negative *during* their auction still have the 3 to 20 block window (documented in R2-07b) |
| R2-08 (one-way waterfall) | **Fixed for the netting case**, with new issues, see **R3-01** | `poolAbsorbed` repays the pool before insurance. But the receivable is left out of share accounting and is wiped on reset |
| R2-09 (gas) | Unchanged | Measurement only |
| I2-8 | **Fixed** | `claimKeeperRewards` skips a lane that can't pay |

### Were the rewritten v1 regressions weakened?

| Test | Still tests the original attack? |
| --- | --- |
| `test_R04a_AccountAtDepositCapCanTopUpAndCure` | **Yes.** It is still the capped account, in auction, topping up and curing. Its new bound assertion follows the v3 rule. It only runs with fresh storage, so it doesn't cover **R3-04** |
| `test_R09_JitLpNetsNothingOnBankruptAuction_InsuranceNotDrained` | **Yes.** It now gaps the account into negative equity *during* the auction, because v3 closes accounts already negative at start, and it still proves that pool and JIT get nothing from insurance |
| `test_R02a_WideConfOnUnheldFeed_DoesNotBlockLiquidations` | **Yes.** It still covers start, pool take, cure and expiry with the full blob that has a wide BTC price. The second victim is placed in (0, MM) so it is auctioned rather than closed out |
| `test_R10_ExecutorCannotChooseOutcomeViaOlderOtherLegPrices` (renamed) | **Narrowed, by decision.** v1's attack used a *newer* live price; the regression now only proves *older* prices can't steer. Steering with a newer price works again (R2-03 decision, accepted as R2-06). The same applies to `test_R2_03b_ExecutorCannotSelectOlderOtherLegPrices` |

### New findings in v3

| ID | Severity | Title | PoC (`contracts/test/review/`) |
| --- | --- | --- | --- |
| R3-01 | **Medium (fix)** | The pool receivable is left out of share accounting. New LPs take old LPs' receivable, a share-less pool's repaid receivable goes to the first depositor, a reset wipes it, and the NAV cap can be gamed | `R3-01_ReceivableNav.t.sol`: `test_R3_01a`, `test_R3_01b`, `test_R3_01c`, `test_R3_01d` |
| R3-02 | Medium (fix or accept) | Dead-feed recovery is impossible once the market has moved more than 10% from the frozen price | `R3-02_FeedSwapBound.t.sol` |
| R3-03 | Medium (fix or accept, bounded) | R2-01 residual: the 110% top-up target compounds past both caps at 1x | `R3-03_TopUpRatchetResidual.t.sol` |
| R3-04 | Low | `deposit` takes no `priceUpdate`, so the rescue top-up disappears whenever storage is older than 15 s | `R3-04_TopUpNeedsFreshStorage.t.sol` |
| R3-05 | Low | Blob order collapses the in-auction reduce's current-price check onto the stale fill price | `R3-05_ReduceInAuctionCurrentPrice.t.sol`: `test_R3_05` (`test_R3_05b` is a sound regression) |
| I3-1 … I3-5 | Info | See [v3 informational](#v3-informational) | — |

#### R3-01 (Medium, fix): the pool receivable is left out of share accounting

**Where:**

- `_creditLane` (L2441) repays `poolAbsorbed` into `pool.cash`.
- `_poolEquity` (L2642) excludes the receivable.
- `_poolSettleIfBroke` (L2782) treats "flat and cash ≤ 0" as insolvent and zeroes `poolAbsorbed`.
- `backstopDeposit` mints 1:1 when `supply == 0`, whatever cash the pool holds.

**What:** the receivable belongs to the LPs who were in the pool when their cash was consumed, but nothing ties it to
them.

- **(a) New LPs take it.** A deposit made while a receivable is outstanding is priced as if the receivable were worth
  zero. When the lane repays, the newcomer collects pro rata.
  - **PoC:** an old LP has 400 in the pool. A hedged SOL pair in the same lane closes the winner first: insurance 100
    is gone and the pool lends **49.32**. The attacker deposits 3,500, then the loser closes. The attacker LP makes
    **+44.83**, and the old LP gets back **355.17** of 400. The hedged pair nets about 0 apart from fees.
- **(b) An emptied pool's repayment goes to the next depositor.** LPs who exit while the receivable is outstanding
  forfeit it. Once supply is 0, the repayment lands in a share-less pool, and the next depositor mints 1:1.
  - **PoC:** the old LP exits with 350.68. Then **1 AUSD deposited returns 50.32**.
- **(c) A reset wipes it.** If the pool's cash is fully consumed and bad debt is outstanding, a routine operator
  unwind at a 0.4% loss takes cash slightly below 0. `_poolSettleIfBroke` then retires the shares *and zeroes the
  receivable*, although cash plus receivable was about +101.
  - **PoC:** **102.65 receivable destroyed**. The loser's later repayment goes to insurance (+250.66) instead of the
    old LP.
- **(d) The NAV cap (R2-04 fix) is tied to insurance, which a hedged pair can drain and refill in seconds.**
  - **PoC:** the pool's gain is capped by insurance of ~147. The winner drains insurance to ~7, which drops NAV by
    **139.02**. The attacker deposits 3,000, the loser refills insurance, and the attacker LP marks **+104.93**.

**Fix:**

1. Refuse `backstopDeposit` while `poolAbsorbed > 0`, or while the cap binds (unrealised gain > insurance), in the
   same way as `LaneInDeficit`. Alternatively, price deposits at NAV including the receivable and the uncapped gain
   (conservative for existing LPs), and withdrawals at the capped NAV.
2. In `_poolSettleIfBroke`, net the receivable first, and reset only if `cash + poolAbsorbed ≤ 0`.
3. When supply reaches 0, sweep any pool cash and forgive `poolAbsorbed` (into insurance) before the next 1:1 mint.
4. Add an invariant: `supply == 0 ⇒ cash == 0 && poolAbsorbed == 0`.

#### R3-02 (Medium, fix or accept): dead-feed recovery closes for good after a >10% move

**Where:** `replaceMarketFeed` (L672–702). The deviation is measured against each lane's last-used price, which is
frozen because the feed is dead, and `maxDeviationBps ≤ MAX_FEED_SWAP_DEVIATION_BPS` (10%).

**What:** detection, the 24 h timelock and Safe signing take days. MON moving more than 10% in that time is ordinary,
and after that no call can recover the market.

**PoC:** the feed dies at 3.00, and three days later MON is at 3.40 (+13%).

- `replaceMarketFeed(…, 1_000)` reverts `FeedSwapDeviation`.
- `1_500` reverts `InvalidParam`.
- `setMarketConfig` reverts `MarketHasOpenInterest`.
- The account is still frozen: no withdrawal and no liquidation.

**Fix:** when the old feed is dead (its last publish time is older than, say, 1 h), allow a wider bound (for example
50%). The 24 h public timelock is the protection there, and the check only needs to catch a wrong-asset feed. Or
compare against a second reference, such as the same asset on another Pyth feed. **If accepted:** document that a dead
feed is only recoverable while the price stays within 10% of the frozen price.

#### R3-03 (Medium, bounded): the top-up ratchet survives at 1x

**Where:** `topUpAllowance` (L871) targets `TOP_UP_TARGET_BPS = 11_000` of IM.

**What:** the last 10% of an exempt top-up is free collateral, so it can fund new margin through a ~1x increase that
passes `MarginAboveNotional`. Any down-tick then puts equity below IM again. Collateral compounds by about 1.1x per
order.

**PoC:** 28 orders (total price drift 0.0000645 USD) give one account **719.76 AUSD** (cap 50) and lane TVL **719.76**
(cap 500). The account then closes and withdraws it all.

**Bound:** per lane, about 1.1 × Σ over markets and sides of `min(maxLaneOi, insurance × 5)`. With the deploy's
5,000 AUSD `maxLaneOi`, that is up to about 33,000 AUSD of TVL per lane, if insurance is at least 1,000.

**Fix:**

- **(one line)** `TOP_UP_TARGET_BPS = 10_000`. Exempt money then only restores IM and can never fund new margin.
- **Or** track exempt deposits per account and exclude them from `_commitChecks`' collateral.

#### R3-04 (Low): the rescue top-up silently needs fresh storage

**Where:** `deposit(amount)` takes no `priceUpdate`. `topUpAllowance` returns 0 when the leg's stored and lane prices
are older than 15 s.

**What:** that is the normal state on Monad (pushes 60–143 s apart, and the keeper pushes only for multi-leg
executions). A capped holder sliding below IM gets `DepositCapExceeded`, which is v1's R-04 again, until something
records a fresh price in the lane.

**PoC:** the deposit reverts. After a no-op `startAuctions(lane, [self], update)`, the same deposit succeeds.

**Fix:** add `deposit(amount, priceUpdate)`, or at least make the app do the no-op call first.

#### R3-05 (Low): blob order collapses the in-auction reduce's current-price check

**Where:** `_executionPrices` (L1087–1107) resolves the "current" price of the order market from the executor's blob.
Pyth's `parsePriceFeedUpdates` takes the *first* in-range message. The unique fill message (published at `execAfter`)
is newer than the auction's lane marker.

**What:** with `[unique, latest]` the current price equals the stale fill price, and the dual check becomes a single
check.

**PoC:** fill at 2.95, real price 2.80.

- The keeper's `[latest, unique]` fails the order (below MM).
- The trader's own `[unique, latest]` executes and ends the auction, even though equity at 2.80 is **19.42 < MM 22.17**.

This is bounded by the 30 s supplied window and by prompt keepers and takers.

**Fix:** for `needCurrent`, require the current price's publish time to be at least `block.timestamp − small` (for
example 5 s). Or resolve the order market without the supplied blob (storage or lane only, rejected if stale).

#### v3 informational

- **I3-1 (live-feed front-running).** `replaceMarketFeed` doesn't require the old feed to be dead. Used on a *live*
  feed with a basis to the new one, the swap is public 24 h ahead, and traders can position for the ≤10% mark jump.
  Lanes without OI skip the deviation check, and pending orders in those lanes fill on the new feed. Use it only for
  dead feeds, or pause increases across the swap.
- **I3-2 (standing exit option).** LPs can still keep a partly-ripe exit request by alternating requests across 2+
  addresses. Combined with R3-01 this keeps a fast exit option. Minor.
- **I3-3 (instant close-out at a dip).** Close-out at start is permissionless at a caller-chosen *newer* price, so a
  dip print with equity < 0 means an instant close-out with no auction and no cure. This is bounded by the R2-06
  window. The lane, not the caller, receives the difference.
- **I3-4 (invariant gaps).** Nothing checks `poolAbsorbed`, or LP value conservation (no deposit or withdraw sequence
  moves value between LPs at constant prices). `supply == 0 ⇒ cash == 0` is not asserted, and R3-01b violates it. The
  handler never calls `replaceMarketFeed`. These gaps are why R3-01 passed 256 × 100 invariant runs.
- **I3-5 (dead code).** The batch close-out path pays no keeper reward. That's correct for `E < 0`, but the
  `acct.collateral > 0` penalty branch of `_closeOut` can never run from `_startOne`.

#### Checked and found sound in v3

- **Reduce-only orders in auction.**
  - Only reduce-only orders may be committed or filled in auction.
  - Maintenance is checked at the fill price and at the current price (modulo R3-05), and the auction ends only on
    success.
  - A bankrupt full close fails (`R3-05b`).
  - A take before the fill makes the order fail with `PositionChanged`.
- **Close-out ordering in batches.** Closing out one account doesn't affect the next account's health evaluation in
  the same batch, because health doesn't depend on insurance or the pool. `_poolCanTake` re-reads pool cash and the
  cap for every account in `backstopTakeBatch`.
- **Receivable bookkeeping (apart from R3-01).** `_debitLane` records exactly the pool cash it takes. `_creditLane`
  repays bad debt, then the pool, then insurance. The per-lane identity still holds, because the receivable is
  off-ledger and repayments move value from inflow to pool cash.
- **`replaceMarketFeed` access and markers.** It is owner-only (the timelock), checks validity and freshness of the
  new feed, rejects a feed id already used by another market, and resets the lane markers of the market (no stale
  marker survives). `setMarketConfig` also resets markers on a zero-OI feed change.
- **`MarginAboveNotional`.** It only applies when margin is added, so existing positions and reduces are unaffected.
- **Monotonic other-leg pricing in `executeOrder`.** A keeper blob that is missing other legs falls back to storage or
  the lane price.
- **I2-8 fix.** A lane that can't pay is skipped and its rewards stay claimable.

#### Residual risks after v3 (in addition to the v2 and v1 lists below)

1. **LP share accounting** around lane inflows, until R3-01 is fixed.
2. **Dead-feed recovery** within ±10% only (R3-02, if accepted).
3. **Cap bound** of about 1.1 × OI capacity instead of the TVL cap (R3-03, if accepted).
4. **Executor price choice** among newer prices: R2-06, R3-05.
5. **Unaudited.** The mechanism count has grown with every round. An external audit is needed before caps rise.

---

## v2 re-review

**Date:** 2026-10-07.
**Revision:** `src/prod/ParaclrClearinghouseProd.sol` sha256 `23d6aff2…8d11b1ca` (47,287 B runtime),
`script/DeployProd.s.sol` v2, and the keeper's `pricepush.ts` and `sweeper.ts` as of 03:56.
**Baseline:**

- `forge test --match-path 'test/prod/**'`: 99 passed, 1 skipped (the opt-in fork test), invariants included.
- `forge test --match-path 'test/review/*'`: **38 passed**. That is the 23 v1 PoCs flipped into regressions by the
  contracts agent, plus 15 new `R2-xx` tests.

Every `R2-0x` finding test **asserts that the problem exists today**. Flip each one when it is fixed. `R2-09` is a
gas measurement, and `R2-10` holds regressions for v2 properties found sound.

### Verdict on the launch gate (v2)

**Does v2 pass the launch gate? No, not yet.**

- **Critical/High: none open.** The v1 High (R-01) is fixed. What remains of it is a bounded Low (R2-06).
- **Mediums still open: R2-01, R2-02, R2-05, R2-08.**
  - **R2-01** cannot be "accepted with bounded impact under beta caps", because it **removes the beta caps**. Any
    position holder can grow its own balance and its lane's TVL without limit: 1,050 AUSD against a 50 / 500 cap in
    20 cheap orders. Every other bounded-impact argument depends on those caps. **It must be fixed.**
  - **R2-02, R2-05 and R2-08** have bounded impact under the caps (once R2-01 is fixed), and each has a small, local
    fix. **Fix them, or accept each one in writing.**
- After the fixes, re-run the invariants, Slither and the fork rehearsal (gate items) on the final code. Keep the
  R2 tests as regressions.

If R2-01 is fixed and R2-02, R2-05 and R2-08 are each fixed or explicitly accepted, I see no remaining blocker for the
capped beta.

### Did each v1 fix close its finding?

I checked the flipped PoCs and wrote variants beyond them.

| v1 | Verdict | Evidence |
| --- | --- | --- |
| R-01 (High) | **Fixed.** Residual **Low** | Per-lane monotonic prices: no call can use a price older than one already used in its lane. Stored and lane prices are usable for 15 s, supplied updates for 30 s. Cure needs 110% MM and at least 1 block. LP exits are delayed. **Residual variant:** a dip print *newer* than the lane price still starts an auction on an account that is healthy at the live price. The loss is bounded by the dip: 6.33 AUSD on 1,900 notional (R2-06). **Side effects of the fix:** R2-05 (cure buffer trap), R2-04c (standing requests defeat the delay) |
| R-02 | **Fixed** | Only the markets a call touches are parsed and validated. Batches skip unpriceable accounts (`AccountSkipped`), and views never revert. A pool that holds an unpriceable market skips every take, so those auctions go to expiry (acceptable) |
| R-03 | **Fixed** | Epoch reset. R2-10a: a ripe request from a retired epoch is dead, old LPs hold 0 shares, and new LPs enter at 1:1 and leave whole |
| R-04 | **Fixed** for top-ups and cures | But the exemption introduces **R2-01** |
| R-05 | **Fixed** across lanes | No lane pays another lane, and Σ `held` equals the token balance by construction for every flow I traced. The haircut is pro rata and order-independent, and a lane never pays more than it holds (R2-10b). **New issues inside a lane:** R2-07 (first-come on realisation), R2-08 (one-way waterfall), R2-04 (pool NAV counts gains it can't be paid) |
| R-06 | **Fixed** | The fee comes out of the margin, and leverage is checked on gross margin. Margin stays at least about `1/lev − fee` of notional |
| R-07 | **Fixed** | The OI cap counts insurance only. OI capacity therefore now needs insurance, which can never be withdrawn (I2-5) |
| R-08 | **Fixed** | Max discount ≤ 5%, and an empty pool never takes |
| R-09 | **Fixed** | The pool is paid at most `max(E, 0)`. Once insurance is gone, pool cash absorbs the shortfall of bankrupt accounts the pool takes (by design: the second loss layer) |
| R-10 | **Partly fixed** | The executor's blob is no longer used for other legs, but steering just moves one call earlier (R2-03b) |
| R-11 | **Fixed** | `reduceOnly` plus the position id (R11b) |
| I-2 | **Fixed** | But freezing the feed while OI > 0 introduces **R2-02** |
| I-7 | **Fixed** | Operators are per lane. `OWNER_IS_EOA` gates EOA owners. Keepers must be distinct. `_verifyWiring` checks every keeper × lane pair |
| I-8 | **Fixed** | The cache scope is bumped before every native push: refund, cancel push, claim |
| I-9, I-10, I-13 | **Fixed** | — |

### New findings in v2

| ID | Severity | Title | PoC (`contracts/test/review/`) |
| --- | --- | --- | --- |
| R2-01 | **Medium (must fix)** | The R-04 top-up exemption lets one account ratchet its balance, and its lane's TVL, past both beta caps | `R2-01_TopUpCapBypass.t.sol`: `test_R2_01_HolderRatchetsCollateralPastBothCaps` |
| R2-02 | Medium | The feed is frozen while OI > 0, so a dead Pyth feed permanently freezes every position and all collateral in that market. There is no recovery path | `R2-02_DeadFeedDeadlock.t.sol`: `test_R2_02_DeadFeedWithOpenInterest_FundsFrozenForever` |
| R2-05 | Medium | The cure buffer creates a "zombie auction" band where the clock keeps running. A recovered account is later taken at the maximum discount for its whole equity | `R2-05_CureBandTrap.t.sol`: `test_R2_05_RecoveredAccountTrappedThenTakenAtMaxDiscount` |
| R2-08 | Medium | The loss waterfall only runs one way. LPs pay for the *order* of realisation; inflows refill insurance, never the pool | `R2-08_WaterfallAsymmetry.t.sol`: `test_R2_08_ZeroNetLaneResult_LpsLose_InsuranceGains` |
| R2-04 | Low | Pool NAV counts gains the lane can only pay out of the pool itself. The first LP out wins and new LPs overpay. One request is a 24 h instant-exit option | `R2-04_PoolNavFirstExit.t.sol`: `test_R2_04a`, `test_R2_04b`, `test_R2_04c` |
| R2-03 | Low | The R-10 fix doesn't stop steering, and multi-leg executions now need a separate, global Pyth push | `R2-03_MultiLegLiveness.t.sol`: `test_R2_03a`, `test_R2_03b` |
| R2-06 | Low | R-01 residual: a dip print newer than the lane price | `R2-06_R01Residual.t.sol` |
| R2-07 | Low | The haircut is first-come on realisation, and `laneSolvency` is silent while a bankrupt account sits in auction | `R2-07_HiddenInsolvencyFirstCome.t.sol` |
| R2-09 | Info | Batch gas per account; the keeper doesn't chunk batches | `R2-09_BatchGas.t.sol` |
| I2-1 … I2-8 | Info | See [v2 informational](#v2-informational) | — |

#### R2-01 (Medium, must fix): top-ups ratchet past both beta caps

**Where:** `deposit` (L773–789). A holder's limit is `maxDepositPerAccount + Σ position margins`, and top-ups skip
the lane TVL cap. `_increase` lets an order add any `marginDelta` with a dust `sizeDelta`.

**What:** Σ margins is not tied to exposure. The loop is:

1. Top up to the limit.
2. Commit an increase of 1e11 base units (zero notional, zero fee) with all free collateral as `marginDelta`. This
   raises the limit by another `maxDepositPerAccount`.
3. Repeat.

Closing the position afterwards leaves the whole balance free to withdraw.

**PoC:** with the beta caps (50 per account, 500 per lane), 20 rounds give one account **1,049.99 AUSD** of
collateral, and lane TVL **1,049.99** against a 500 cap. Each round costs 0.1 MON (~$0.003). The position is then
closed and the full balance withdrawn.

**Impact:** the launch-gate control "caps set to the beta values" no longer binds. The amount of user money exposed
to an unaudited contract (and to R2-05, R2-08 and so on) is unbounded per account and per lane. OI caps still bound
the protocol's trading exposure.

**Fix:**

- Exempt a top-up only while the account is below `ceil(IM × 1.1)` (or in auction), and only up to the amount that
  brings equity back to that level. Apply the fresh-deposit caps to everything else.
- Independently, cap position margin at notional (≥ 1x), so that margin cannot be parked in dust increases.

#### R2-02 (Medium): a dead feed with open interest deadlocks funds forever

**Where:** `setMarketConfig` (L639–647) reverts `MarketHasOpenInterest` on a feed change while any lane has OI.

**What:** if Pyth stops publishing a listed feed (deprecated, or re-issued under a new id), then:

- every account holding that market can no longer withdraw *anything*, because every leg must be priced;
- its positions in that market can never be closed, because no unique fill update can exist;
- its positions in *other* markets cannot be closed either, because the dead leg must be priced;
- liquidations skip it;
- governance cannot repoint the feed, because the OI can never reach 0;
- `setPyth` doesn't help, because the feed id is the same.

**PoC:** the account has ~1,000 AUSD and holds MON and SOL. MON stops publishing.

- `withdraw(1 AUSD)` reverts `StalePrice(MON)`.
- The SOL close reverts `StalePrice(MON)`.
- The MON close reverts `PriceFeedNotFoundWithinRange`.
- `setMarketConfig(MON, newFeed)` reverts `MarketHasOpenInterest`.
- `startAuctions` skips the account.

**Fix:** let the timelock change a feed even with OI (the 24 h notice protects users), with a sanity check that the
new feed's price is within a few % of the old feed's last price. Alternatively, add a timelocked `settleMarket` that
closes the market at the last valid price.

#### R2-05 (Medium): the cure buffer traps recovered accounts while the clock keeps running

**Where:** `cancelAuction` (L1331–1350) cures only at `equity ≥ 1.1 × MM`. `take` and `backstopTakeBatch` need
`equity < MM`. `_expire` needs `equity < MM`. Accounts in auction cannot commit orders or withdraw.

**What:** an account whose equity recovers into `[MM, 1.1 MM)` can be neither cured, taken nor expired. It is frozen,
and its Dutch clock keeps counting from the original `startBlock`. The first later wiggle below MM lets a taker in at
the **maximum** discount (5% of notional, about 2× MM), which takes all of its equity.

Anyone can also drop an account into this band: start its auction on one dip print newer than the lane price (R2-06).
The only remedy is a top-up to 110% MM, if the user has funds and is watching.

**PoC:** the account recovers to equity 48.4 (MM 46.2, cure threshold 50.9). After 30 blocks it still cannot cure,
be taken, expire or close (`AccountInAuction`), and the discount reaches 500 bps. A **−0.14%** move (2.920 → 2.916)
then lets the taker take **45.85 AUSD, the whole equity**. A fresh auction's 75 bps pool take would have cost 13.85.

**Fix:** with monotonic prices, the flip-flop the buffer guarded against is gone.

- Either cure at `≥ MM` again,
- or keep the buffer but **restart the clock** (`startBlock = block.number`) whenever the account is observed at
  `≥ MM`.

Also allow reduce-only orders while in auction.

#### R2-08 (Medium): one-way waterfall; LPs pay for realisation order

**Where:** `_debitLane` (L2293) takes insurance, then **pool cash**, then records bad debt. `_creditLane` (L2284)
repays bad debt, then **insurance**. Nothing ever flows back to the pool.

**What:** in a fast move, winners realise before losers (losers are still in their auctions, or simply still open).
Pool cash pays the winners once insurance is exhausted, and the losers' later losses refill *insurance*. The lane's net
result can be exactly zero and the LPs still lose. The LPs' loss becomes non-withdrawable insurance. A hedged pair of
accounts in one lane does this on purpose for the cost of fees.

**PoC:** lane insurance 100, pool 1,000. A short and a long of 500 each, then a −40% move. The winner closes first and
the solvent loser after. No bad debt arises, yet **LPs −99.50** and **insurance +99.80**.

**Fix:** track `poolAbsorbed[lane]` (pool cash consumed by `_debitLane`). In `_creditLane`, repay bad debt, then the
pool up to `poolAbsorbed`, then insurance. In effect the pool's contribution becomes a loan to the lane.

#### R2-04 (Low): pool NAV counts gains the lane can only pay from the pool; standing requests

**Where:** `_poolEquity` counts the full unrealised gain. The pool's counterparty is its own lane, and because of the
v2 waterfall, a gain beyond insurance is paid out of pool cash. Requests stay executable for 24 h after they ripen.

**PoCs:**

- (a) The pool's gain is 206.7 against 146.9 of lane insurance. LP1 holds a ripe standing request and exits at **1,104.66**. After the unwind, LP2
  holds **1,044.86**. The 59.80 difference is exactly the gain the lane could only pay out of the pool.
- (b) A new LP deposits 1,000 at the overstated NAV and is worth **981.37** after the unwind. `LaneInDeficit` never
  fires, because it only sees realised bad debt.
- (c) One request allows instant exits at any time from +1 h to +25 h.

**Fix:**

- Cap the pool's unrealised gains in NAV at the lane's insurance (`min(gain, insurance)`).
- Make requests single-use with a short window, or pay `min(NAV at request, NAV at exit)`.

#### R2-03 (Low): R-10 incompletely fixed; multi-leg executions need a separate global push

**What:** other legs come only from storage or the lane price, which are usable for 15 s. Monad's on-chain pushes were
measured 60–143 s apart.

- (a) With the keeper's data shape and no push, a multi-leg **close** order reverts `StalePrice` until its deadline
  and expires. The keeper's new on-demand pusher (`pricepush.ts`) covers this with a separate `updatePriceFeeds` tx
  before each such execution. That is a global Pyth storage write, so these executions conflict across lanes under
  parallel execution. With `PYTH_PUSH_MODE=off`, or if the pusher fails, orders expire.
- (b) Anyone can still steer the outcome. They first call `startAuctions(lane, [account], newerUpdate)`: the healthy
  account is skipped, but its prices are recorded. In the PoC that turns Executed into Failed, and the griefer is
  paid.

**Fix:** resolve other legs through `_beginPricing` with the executor's blob. Since prices are monotonic this is no
less safe, it removes the push, and the remaining choice is the same bounded window as R2-06. Alternatively, price
other legs at the fill's publish time.

#### R2-06 (Low): R-01 residual, a dip print newer than the lane price

**What:** the first caller after a quiet period can still pick any Pyth message newer than the lane and stored prices
(supplied updates up to 30 s old).

**PoC:** a 1-second 0.34% dip, then a start and a take in the same block at a 0% discount. The victim, healthy at the
live price, loses **6.33 AUSD**, the dip size. It is worse if the victim lands in the R2-05 band.

**Fix (optional):** for `startAuctions`, require supplied prices with `publishTime ≥ now − 3 s`, or forbid `take` in
the start block.

#### R2-07 (Low): the haircut is first-come on realisation

**What:** while a bankrupt account sits in its auction (3 blocks for a pool take, 20 to expiry), `laneSolvency()`
reports a positive surplus and withdrawals are paid in full. Identical depositors who are slower take the whole
deficit.

**PoC:** two depositors with identical 1,000 AUSD claims. The fast one gets **1,000.00**. The slow one gets
**961.83** (382 bps haircut), after the winner's close and the expiry realise the deficit.

**Fix:** close accounts with `E ≤ 0` immediately in `startAuctions`: nobody pays for them, so they need no auction.
Optionally include in-auction negative equity in `laneSolvency`.

#### v2 informational

- **I2-1 (vacuous test).** My v1 `R99` fuzz `testFuzz_PoolRoundTripNeverProfits` no longer tests anything under v2:
  its one-step withdraw always reverts inside `try/catch`. `R2-10c` replaces it with the two-step flow.
- **I2-2 (same-second ties).** Supplied updates win ties against stored prices, and the lane price loses ties. A caller
  can therefore switch between the 2–3 different prices Pyth publishes within one second. Negligible.
- **I2-3 (pusher breaks lane locality).** The keeper's on-demand pusher writes Pyth storage, which is global, so
  multi-leg executions no longer have lane-local writes.
- **I2-4 (no operator for some lanes).** Lanes with an index ≥ `KEEPER_ADDRESSES.length` have no backstop operator, so
  only the 24 h timelock can unwind those pools. The keeper still has no `backstopReduce` policy at all. An R-03 reset
  needs a flat pool, so a pool that nobody reduces can stay underwater indefinitely.
- **I2-5 (OI capacity needs insurance).** OI capacity is now `insurance × 5` only. To offer the deploy's 5,000 AUSD
  per-side cap, each lane needs 1,000 AUSD of insurance, and insurance can never be withdrawn (I-6).
- **I2-6 (batch gas).** Per account, `startAuctions` costs 57.5k gas and `backstopTakeBatch` 75.5k (Foundry pricing;
  Monad charges more for cold state). That is about 520 and 400 accounts per 30M-gas transaction. A lane at beta caps
  can hold about 500 one-AUSD accounts with positions, and the keeper does not chunk batches. Chunk at about 200.
- **I2-7 (`[]` calls).** Frontend calls with an empty update (`withdraw`, pool operations, cure) need storage no older
  than 15 s. The app must fetch updates through the proxy, as `pricepush.ts` documents.
- **I2-8 (one insolvent lane blocks all claims).** `claimKeeperRewards` reverts for **all** lanes if one lane has
  `debited > held + debt`. This is an edge case that needs a lane full of negative-collateral accounts.

#### Checked and found sound in v2

- **Per-lane identity.** `held == collateral + insurance + pool cash + keeper rewards − bad debt`, and Σ `held` equals
  the token balance. I traced this through:
  - deposit and withdraw;
  - `fundLane` and both claims;
  - pool deposit and withdraw;
  - every `_debitLane` and `_creditLane` path;
  - write-offs and `_poolSettleIfBroke`.

  Also, `insurance > 0` implies `badDebt == 0`.
- **Haircut.** It is pro rata and order-independent (to 1 unit). Floors favour the claimants who remain. A lane never
  pays more than `held` (R2-10b).
- **Epochs.** Shares are keyed by epoch, requests carry their epoch, and a reset only happens to a flat pool with
  `cash ≤ 0` (R2-10a). The pool round trip never profits (R2-10c).
- **Monotonic marker.**
  - It only records valid prices.
  - A stale lane price never blocks a newer supplied or stored price.
  - It cannot get stuck: it expires after 15 s, and future skew is at most 5 s.
  - It writes lane-local storage only.
- **Access control.** Every state-changing external function is `nonReentrant` or `onlyOwner`, except `pause`
  (guardian or owner, checked inside) and `selfFill` (self-call only). `backstopReduce` takes the owner or that lane's
  operator. `backstopRequestWithdraw` only works on the caller's own current-epoch shares.
- **Deploy script.**
  - `OWNER_IS_EOA` gates EOA owners.
  - There are at most 8 keepers. Keepers must be distinct from each other, from the deployer, from the guardian and
    from the multisig.
  - Keeper *i* operates lane *i* only, and every keeper × lane pair is verified.
  - The deployer holds no role, and the timelock administers itself.
  - The price check now tolerates staleness (`latestPrice`).
- **Orders.** `reduceOnly` and the position id block every stale-order reuse I tried (R-11, R11b). The fee from margin
  cannot push margin below `1/lev − fee` of notional.
- **Cache.** The price cache is invalidated before every outbound native push.

#### Residual risks after the v2 fixes (in addition to the v1 list below)

1. **Oracle-push liveness.** With a 15 s storage age, `[]` calls and multi-leg executions depend on someone pushing:
   the keeper, or the app through the proxy.
2. **First-come within a lane** (R2-07 if not fixed): early claimants are paid in full before a realised deficit.
3. **Gap risk** against insurance plus pool cash; correlated markets are not netted.
4. **Withdrawals are unpausable by decision.** An oracle compromise drains at most the lanes' holdings, within the caps
   (once R2-01 is fixed).
5. **Insurance is permanently locked**, and OI capacity requires it.

---

# v1 review (original, superseded by the v2 re-review above)

**Revision:** `contracts/src/prod/ParaclrClearinghouseProd.sol` sha256 `0a18674a…cb760035` (untracked on top of
`db17795`), `contracts/script/DeployProd.s.sol`, `test/prod/**`, vendored Pyth SDK 4.3.1 / OZ 5.6.1 interfaces.
**PoCs:** `contracts/test/review/` (22 tests at the time). Each `R0x` test asserted that the exploit worked. The
contracts agent has since flipped them into regressions for v2. `R99_SoundRegressions` covers properties checked and
found sound in v1.

```bash
cd contracts && forge test --match-path 'test/review/*' -vv
```

Read-only chain checks (2026-10-07, `https://rpc.monad.xyz`):

- Monad block timestamp equals wall-clock time (lag 0 s, 3 samples).
- The Pyth-stored MON/SOL/BTC prices on `0x2880…C17B43` were 8 s old.
- `getUpdateFee([])` returned 0.
- MON/USD read 0.0286.

No transactions were sent and no anvil was started. I did not run Slither or the opt-in fork test.

---

## Verdict on the launch gate

**Does this block the mainnet launch? Yes (reviewer's verdict).**

The literal gate only says "all criticals fixed", and I found **no Critical**. But I found:

- **one High (R-01).** Using only public on-chain data, any bot in the same lane can take **100%** of the equity of an
  account that is **healthy at the live price**. A 0.34% lag of Pyth's on-chain push is enough. This will happen
  routinely to accounts near maintenance margin.
- **five Mediums.** They interact badly in exactly the scenario the beta has to survive, a fast crash:
  - R-02: a confidence spike on any one feed stops every liquidation in all lanes with the shipped keeper.
  - R-03: the first pool insolvency permanently kills that lane's backstop.
  - R-04: users who deposited the 50 AUSD cap cannot add margin or cure.
  - R-09: bankrupt auctions pay JIT LPs out of insurance.
  - R-05: the resulting bad debt leaks across lanes, and `solvency()` (the planned alert) reports `solvent` throughout.

The caps (50 AUSD per account, 500 AUSD per lane) bound the absolute loss, but real users would lose real money through
designed paths. **Fix R-01 to R-05 and R-09, or accept each one in writing with compensating controls.** Then re-run
the other gate items (invariants, Slither, fork rehearsal) on the changed code.

---

## Findings

| ID | Severity | Title | PoC (`contracts/test/review/`) |
| --- | --- | --- | --- |
| R-01 | **High** | Prices move backwards between calls: the stale stored price lets bots liquidate healthy accounts, lets traders stall auctions and over-withdraw, and lets LPs exit before a loss | `R01_PriceRegression.t.sol`: `test_R01a`…`test_R01e` |
| R-02 | Medium | One invalid listed feed reverts every call carrying a full update (all liquidations, multi-leg executions). One unpriceable account reverts its whole batch | `R02_CrossFeedCoupling.t.sol`: `test_R02a`/`b`/`c` |
| R-03 | Medium | A backstop pool is permanently bricked after an insolvency write-off | `R03_PoolBrick.t.sol`: `test_R03_PoolPermanentlyBrickedAfterWriteOff` |
| R-04 | Medium | Deposit caps block margin top-ups: capped users cannot avoid or cure an auction, and a third party can fill lane TVL to block top-ups | `R04_DepositCapBlocksCure.t.sol`: `test_R04a`/`b` |
| R-05 | Medium | Lane bad debt is paid out of other lanes' AUSD, and `solvency()` keeps reporting solvent | `R05_CrossLaneBadDebt.t.sol`: `test_R05_…` |
| R-09 | Medium | The pool discount on bankrupt accounts is paid by insurance, and a JIT LP captures it | `R08_R09_PoolDiscountExtraction.t.sol`: `test_R09_…` |
| R-06 | Low | An "all-in" increase order passes commit and always fails at fill (the trading fee is not escrowed) | `R06_AllInMarginFails.t.sol` |
| R-07 | Low | The backing-based OI cap is bypassed with a transient pool deposit | `R07_OiCapBypass.t.sol` |
| R-08 | Low | An empty pool (no shares) takes auctions if `auctionMaxDiscountBps >= 1000`, and the first LP captures the discount | `R08_R09_PoolDiscountExtraction.t.sol`: `test_R08_…` |
| R-10 | Low | The executor decides Executed vs Failed for multi-leg orders through its choice of other-leg prices | `R10_R11_OrderEdges.t.sol`: `test_R10_…` |
| R-11 | Low | A stale reduce order executes as an increase of an inherited opposite position. SECURITY_NOTES #4 is incomplete | `R10_R11_OrderEdges.t.sol`: `test_R11_…` |
| I-1 … I-13 | Info | See [Informational](#informational) | — |

---

### R-01 (High): prices move backwards between calls

**Where:** `_ingestFresh` (L1823–1852) and `_price` (L1793). This affects every fresh-price entry point:

- `withdraw`
- `startAuctions`, `take`, `backstopTakeBatch`, `cancelAuction`, `expireBatch`
- `backstopDeposit`, `backstopWithdraw`, `backstopReduce`
- the other-leg prices in `_executionPrices` (L917)

**What:**

- Per call, the caller selects the price. `[]` means the Pyth-stored price, which may be up to `maxPriceAge` (60 s) old.
  A non-empty blob means any message with a publish time between the stored one and `now + 10`, and the caller also
  chooses the blob order, because "first in range" wins inside Pyth.
- `parsePriceFeedUpdates` stores nothing, and the production keeper never calls `updatePriceFeeds`. It only does so
  inside an `eth_simulateV1` for its views. So the stored price does not advance when the keeper acts.
- As a result, two consecutive calls in the same lane can see the market go back in time.

SECURITY_NOTES #6 ("nobody can submit a price older than the on-chain one") is literally true, but it misses the point:
the on-chain price itself lags by up to 60 s, and anyone can select it by passing `[]`.

**Exploits (all PoC'd):**

| Test | Scenario | Result |
| --- | --- | --- |
| `test_R01e` | Stored push 2.91, live 2.92 (a **0.34%** gap). The victim is healthy at live (equity 48.38 > MM ≈ 46.2). A same-lane taker calls `startAuctions(…, [])` and then `take(victim, [])` at 275 bps | The victim keeps **0**. The taker gets a 42.05 payment plus 6.33 of mark-to-live gain, which is **all 48.38 AUSD** of the victim's live equity |
| `test_R01b` | Same with a 4% gap | Total loss of the victim's 99 AUSD; the taker is +76 on the inherited position |
| `test_R01a` | The keeper starts the auction at live 2.88; the trader calls `cancelAuction(self, [])` at stored 3.00 | 12 auctions started and 12 cured over 36 blocks (max discount needs 20). The pool never takes, and the Dutch clock resets every time. Once the live price is stored, the cure fails (mitigation check) |
| `test_R01c` | Live −9%, stored 20 s stale | The trader withdraws **899.50** with `[]` (809.50 allowed at live). Equity at live is **10.00 < MM 22.75**: liquidatable immediately, and a further move becomes bad debt |
| `test_R01d` | The pool holds a long; live 2.60, stored 2.88 | LP1 withdraws **1,006.84** with `[]` instead of **918.17** at live. LP2 absorbs LP1's 88.67 share of the loss |
| `test_R10` | Same root cause in `executeOrder` | See R-10 |

**Impact:**

- Repeatable theft of equity from accounts within the push deviation of maintenance margin.
- Liquidation stalling, which leads to bad debt.
- Withdrawals past initial margin.
- LPs front-running pool losses.

Pyth pushes on deviation or heartbeat, so a gap of a few tenths of a percent between stored and live is the normal
state.

**Fix:**

1. **Make prices monotonic per lane.** Keep `lastPublishTime[lane][market]`. This is lane-local storage, so it does not
   hurt parallelism. Never use a price older than it, and advance it whenever a newer price is used in that lane. Once
   a keeper starts an auction at time T, nobody in that lane can cure, take, withdraw or redeem at a price older than T.
   The order fill price (`_ingestUnique`) stays historical by design; the IM legs must respect the marker.
2. **Tighten `maxPriceAge`** for the stored path to about 10–15 s (the observed push age is ~8 s). Alternatively,
   require a non-empty update with `publishTime >= now − 5 s` for `startAuctions`, `take`, `backstopTakeBatch` and
   `expireBatch`.
3. **Cure hysteresis.** `cancelAuction` should require `equity >= IM` (or MM × k) and should be impossible in the start
   block. A re-start within N blocks should keep the original `startBlock`.
4. **Keeper.** Push the update into Pyth storage (`updatePriceFeeds`, fee 0 today) in liquidation transactions.
5. **Pool withdrawals.** Make them two-step (request, then execute after N s at the then-current NAV), or add a
   cooldown. This also addresses R-09.

### R-02 (Medium): one invalid feed halts every call that carries a full update

**Where:** `_ingestFresh` L1835–1848. `_toPrice` runs inside the `try` *success* block, and Solidity does not catch
reverts there. The batch loops in `startAuctions`, `backstopTakeBatch` and `expireBatch` call
`accountHealth`/`isLiquidatable` for each account without isolating failures.

**What:**

- Any listed feed whose price in the update (or whose newer stored price) has `conf/price > maxConfBps`, a non-positive
  price, or an out-of-range exponent reverts the whole call. This happens even if no account involved holds that
  market.
- The shipped keeper always sends one Hermes "latest" blob for all feeds to every auction call
  (`keeper/src/prod/sweeper.ts`). The executor appends the same blob for multi-leg accounts (`executor.ts`). Neither
  ever falls back to `[]`.
- Separately, one account in a batch whose own market is unpriceable reverts the batch. The keeper's lane views
  (`getLiquidatableAccounts`, built on `_page`) revert the same way.

**PoC:** BTC confidence widens to 3%.

- `startAuctions`, `backstopTakeBatch`, `expireBatch` and `cancelAuction` for a **MON-only** account all revert with
  `PriceConfidenceTooWide(BTC, …)`. With `[]` they work.
- A MON order of an account that also holds SOL reverts with the keeper's data shape, and expires.
- The batch `[v (MON), w (BTC)]` reverts even with `[]`.

**Impact:** a volatility spike on one market (exactly when liquidations matter) stops liquidations in all 8 lanes and
lets multi-leg orders expire. The result is bad debt (R-05).

**Fix:**

- Validate lazily. In `_ingestFresh`, cache only the prices that pass a non-reverting validity check, and leave the
  others uncached so that `_price` reverts only when that market is actually needed.
- Accept partial blobs: drop the "every feed" coverage rule.
- In batch functions, skip accounts whose markets cannot be priced instead of reverting.
- Keeper: on an oracle revert, retry with `[]` or with per-market blobs.

### R-03 (Medium): backstop pool permanently bricked after a write-off

**Where:** `_poolWriteOffNegative` (L2280), `backstopDeposit` (L1323–1328), `backstopWithdraw` (L1352–1353),
`_poolCanTake` (L2169).

**What:**

- A flat pool with negative cash is written off to `cash = 0`, but `totalShares` stays non-zero.
- `_poolEquity` is then 0, so every `backstopDeposit` and `backstopWithdraw` reverts `BackstopInsolvent`.
- `_poolCanTake` would need a discount of at least 10%, which is impossible under the 5% cap.
- No admin function can reset a pool.

The trigger is ordinary: a pool loss larger than its equity, followed by the routine operator unwind (`backstopReduce`
from a keeper hot key). In other words, the first serious crash in a lane.

**PoC:**

1. An LP deposits 300. The pool takes a 1,824 AUSD long.
2. A −20% move puts pool equity at −53.6. The operator unwinds, leaving `(equity 0, cash 0, supply 300e6)`.
3. A 10,000 AUSD deposit reverts, and the LP's withdrawal reverts.
4. A new auction in the lane is never taken by the pool (19 blocks).
5. `laneOiCap` falls back to insurance only.

**Impact:** the lane permanently loses its backstop and its pool-cash OI backing. Every later auction in that lane can
only expire (lane absorbs at mark, 1% penalty) or be taken externally.

**Fix:** add a per-pool `epoch` and key shares by `(epoch, lp)`. When the pool is flat with `cash <= 0` and
`totalShares > 0`, retire all shares (bump the epoch, set `totalShares = 0`) so that the next deposit starts at 1:1.

### R-04 (Medium): deposit caps block margin top-ups and cures

**Where:** `deposit` (L735) → `_checkDepositCaps` (L1912).

**What:**

- Both caps apply to every deposit, including top-ups by accounts with positions or in auction.
- `collateral` does not fall with unrealised losses, so an account that deposited the 50 AUSD maximum (the obvious
  choice) can never add margin.
- A third party can fill a lane's 500 AUSD TVL with throwaway accounts (refundable later) to block every top-up in
  that lane before a move.

The README and pause docs promise exactly this top-up/cure path ("holders can still top up margin…").

**PoC:**

- `test_R04a`: 50 deposited, 450 notional at 10x, then a −9.3% move. `deposit(20)` reverts `DepositCapExceeded`
  before and during the auction, and `cancelAuction` returns false. With a higher cap the same top-up cures. Without
  it, the user pays the discount to a taker.
- `test_R04b`: the lane is filled to 500 AUSD, and the victim's 10 AUSD top-up reverts with
  `LaneTvlCapExceeded(510e6, 500e6)`.

**Impact:** forced liquidation and loss of the discount (up to 5% of notional, about half of a 10x margin) for the
most common deposit size. Only reduce orders remain, with a 2 s delay, and they are unavailable once the account is in
auction.

**Fix:**

- Exempt top-ups by accounts that hold positions from the per-account cap, at least up to the amount that restores IM.
- Exclude such top-ups from the lane TVL cap, or reserve TVL headroom for them.
- UI: warn users against depositing the full cap.

### R-05 (Medium): lane bad debt is paid with other lanes' AUSD; `solvency()` stays true

**Where:** `_closeLeg` L1109–1110: `_adjustCollateral(+pnl)` credits the winner in full, then `_debitLane` records the
shortfall as `badDebt`. Also `withdraw`, which has no lane check, and `solvency()` (L1706), which subtracts `badDebt`
from liabilities.

**What:**

- The AUSD is one shared balance. Winners withdraw from it whatever their lane's insurance was, so lane isolation
  exists only in the ledgers.
- The loss lands on whoever withdraws last, in any lane: in practice other lanes' insurance first, then users.
- `solvency()` holds by construction for trading losses. It only detects external balance changes, so the
  SECURITY_NOTES alert `solvency().surplus < 0` can never fire on bad debt.

**PoC:**

1. Only lane 3 is funded (100 AUSD of insurance).
2. `x` (lane 3) wins 150 on 500 notional at +30%. Lane 3 bad debt is **49.42**.
3. `x` withdraws everything. The contract holds **950.58** AUSD.
4. `y` (lane 5, never traded, 1,000 deposited) **cannot withdraw**.
5. `solvency()` reports `solvent, surplus 0` at every step.

**Coordinated drain:** a long in lane A plus a short in lane B profits from any gap larger than `1/leverage`. The
loser's bad debt, and whatever the winner takes beyond lane A's insurance, land on everyone else. R-07 and R-09 enlarge
this.

**Fix:** choose a model and implement it.

- **(a) Real isolation:** when a lane has `badDebt > 0`, haircut that lane's PnL credits and profit withdrawals, or block
  withdrawals beyond net deposits until the lane is repaid.
- **(b) Global mutualisation:** state it explicitly and drop the isolation claims from the docs.

In both cases, add an economic-solvency view (AUSD held vs Σ positive collateral + pool cash + keeper rewards +
unrealised profits) and alert on any `badDebt > 0` or low insurance-to-OI ratio.

### R-09 (Medium): insurance-funded pool discount; a JIT LP extracts it

**Where:** `_take` L2051–2058. The pool gets the full `P = discount × notional`, and the lane pays
`P − min(P, E⁺)`. `backstopDeposit` has no lockup.

**What:** for a bankrupt account the entire discount is a transfer from insurance to whoever holds pool shares at the
take. A JIT LP deposits in the block before expiry (475 bps), calls `backstopTakeBatch`, and exits after the routine
operator unwind. Pools are margin-constrained in a crash, so they cannot take at 75 bps, and that is when this matters.

**PoC:**

1. Lane 4 has no pool liquidity. An account with 1,773 notional gaps to equity −27.6.
2. A JIT LP deposits 1,000 at d = 475 bps and takes. The operator unwinds at the same mark.
3. The LP withdraws 1,084.23, a **+84.23 AUSD** profit. That is exactly the extra insurance outflow compared with
   letting the auction expire.

**Fix:**

- Pay the pool `min(P, max(E, 0))`, as for external takers, or a small capped lane-funded fee.
- Exclude shares minted within N blocks from takes, or add a withdrawal delay.

### R-06 (Low): an all-in margin order always fails

**Where:** `commitOrder` checks `reserved + marginDelta + Σmargins <= collateral` (L850). The fill then charges the fee
and requires `equity >= Σmargins`.

**PoC:** deposit 50 and commit 500 notional with margin 50. The order is `Failed`, and the user loses the 0.1 MON
execution fee. With margin 49.5 on 495 notional, it fills. The same trap hit two of my own PoC setups.

**Fix:**

- Include the fee estimate (`ceil(|size| × acceptablePrice × feeBps)`) in the commit check.
- UI: leave headroom for the fee.

### R-07 (Low): OI-cap backing bypassed with a transient pool deposit

**What:** the cap is checked only on increases, and `backstopWithdraw` never re-checks the lane's OI against the
reduced backing.

**PoC:**

1. Lane insurance is 100, so the cap is 500.
2. A 1,000 pool deposit raises the cap to 5,500. The attacker opens 5,000 of OI.
3. The deposit is withdrawn in full. The cap is now **512.5** while OI is **5,000**.
4. A +5% move leaves **144.87** of bad debt.

The absolute cap (`maxLaneOi` 5,000) and lane TVL bound this.

**Fix:**

- In `backstopWithdraw`, require every market's lane OI to stay at or below the cap after the withdrawal.
- Alternatively, count pool cash as backing only after a minimum age.

### R-08 (Low): empty pool takes auctions at ≥ 10% max discount

**What:** `setAuctionParams` allows up to 5,000 bps. At 1,000 bps or more, `_poolCanTake` passes with zero cash and zero
shares.

**PoC:** at 1,100 bps a share-less pool collects 182 AUSD. The first LP deposits 1 AUSD and withdraws about 183 after
the unwind.

**Fix:**

- `_poolCanTake` should return false when `totalShares == 0`.
- Bound `auctionMaxDiscountBps` below `BACKSTOP_MARGIN_BPS`.

### R-10 (Low): the executor chooses the multi-leg outcome

**What:** the order's own fill price is pinned, but the other legs' prices come from whatever the executor sends:

- a blob that fails to parse, which means stored prices;
- or a fresh blob.

When the two differ, the executor decides between `Executed` and `Failed`, and is paid either way.

**PoC:** BTC is 1.2% lower live than stored. One blob shape fills the order. The other fails it, and the griefer is
paid 0.1 MON.

**Fix:** price the other legs deterministically at the fill's publish time: `parsePriceFeedUpdates(update, heldIds,
P*.publishTime, P*.publishTime + δ)`. Alternatively, use the minimum health over (stored, supplied).

### R-11 (Low): a stale reduce order increases an inherited position

**What:** SECURITY_NOTES #4 claims a stale reduce "can never open a position". The sequence below shows otherwise:

1. A pending sell exists on a long.
2. The long is taken by the pool.
3. The account then takes another auction and inherits a short in the same market.
4. The sell executes as an **increase of the short** with **zero added margin**. It passes the leverage check on the
   inherited margin.

**PoC:** `test_R11`: the short grows by the order size, and the margin is unchanged.

**Fix:** store `reduceOnly` (or the position side at commit) on the order, and fail the fill if it would increase.

---

## Informational

- **I-1 No circuit breaker for outflows.**
  - Pause (guardian) blocks only deposits by accounts without positions, pool deposits, and increases.
  - Withdrawals, closes and pool withdrawals cannot be stopped by anyone, not even the timelock.
  - An oracle compromise or a pricing bug therefore drains without recourse.
  - This is the plan's design choice; consider a short, self-expiring guardian halt.
- **I-2 Governance bounds are loose** (24 h notice):
  - `auctionMaxDiscountBps` up to 50%. With R-09 this means insurance can be drained at 50%.
  - `maxPriceAge` up to 1 h, which stretches R-01's window to 1 h.
  - `maxConfBps` up to 10%.
  - `oiCapMultiplierBps` and the caps are unbounded.
  - `setMarketConfig` can swap the feed of a market with open positions.
  - `setPyth` probes only `getPriceUnsafe`, not `parsePriceFeedUpdatesUnique`.
- **I-3 Lane locality.**
  - **Confirmed** for `executeOrder` (Pyth fee 0), `startAuctions`, `take`, `backstopTakeBatch`, `cancelAuction`,
    `expireBatch` and `backstopReduce`: there are no shared persistent writes. This matches `ProdParallel.t.sol` and my
    reading.
  - **Refuted** for:
    - `commitOrder`, `cancelOrder` and `claimExecutionFees` (the contract's native balance);
    - every AUSD-moving function (the token's `balanceOf[clearinghouse]` slot);
    - every trade, which reads `_funding[market]`, written by `updateFunding`.
  - The author documents all of these. If Pyth fees become non-zero, every keeper path also writes Pyth's balance.
- **I-4 `minExecDelay` = 2 s.** Monad timestamps match wall clock (checked), so knowing P\* at commit is not possible
  today, but the margin over Pyth/Hermes latency is thin. Recommend 3–5 s.
- **I-5 Execution fee of 0.1 MON is about $0.003** at the on-chain MON/USD of 0.0286. Commit spam is nearly free, and
  each commit writes the shared native balance. Consider a USD-indexed minimum.
- **I-6 Locked funds.** Lane insurance (including seeded funds) and stray AUSD can never leave the contract. There is no
  sweep or migration path.
- **I-7 Deploy script.**
  - Keeper hot keys become backstop operators for **all** lanes. One compromised key can unwind any pool at a
    cherry-picked price and trigger R-03.
  - There is no `code.length` check on `OWNER_MULTISIG_ADDRESS` (Safe is deployed on 143). Require code unless a
    hardware-wallet flag is set explicitly.
  - Keepers are not checked to be distinct from the guardian or the multisig.
  - The contract is live and unpaused from the constructor onward.
  - Wiring is otherwise correct: the timelock administers itself, the multisig is proposer, executor and canceller, and
    the deployer holds no role. Verified in the script's `_verifyWiring` and in `DeployProd.t.sol`.
- **I-8 Read-only reentrancy.** During outbound native pushes (excess refund, cancel push, claim), the views
  `accountHealth`, `freeCollateral`, `isLiquidatable` and `backstopNav` return values computed with the in-flight call's
  caller-chosen cached prices. This only matters to third-party integrators.
- **I-9 Double Pyth fee.** `executeOrder` parses the update twice, so the Pyth fee doubles if fees return.
- **I-10 Dust registrations.** `deposit(1)` registers an account for 1e-6 AUSD, so `_laneAccounts` can be spammed.
  Only views use it; keepers should index events.
- **I-11 Funding rate.** The rate comes from instantaneous skew at a permissionless update and persists until the next
  one. This is low impact while OPS updates every 60 s; it is not profitable to manipulate with fees and order delays.
- **I-12 Frozen or paused AUSD.** Liquidations continue while nobody can top up, because transfers revert. Users can
  only reduce. A burn from the clearinghouse is the one failure `solvency()` does detect.
- **I-13 Keeper scanning.** `getLiquidatableAccounts` reverts if any account in the page needs an unpriceable market
  (liveness, see R-02).

---

## SECURITY_NOTES claims, verified

| Claim | Verdict |
| --- | --- |
| #1 Gas starvation cannot fake a `Failed` order | **Holds.** `selfFill` makes no external call (all prices are cached in transient storage first). Out-of-gas returns empty data and panics carry `0x4e487b71`; both are re-thrown. Existing sweep test passes |
| #2/#3 Typed `int128` bound, `MarginRequired` | Hold |
| #4 A stale reduce can never open a position | **Incomplete**, see R-11 |
| #5 External taker never subsidised | Holds (`min(P, E⁺)`). But the **pool** is subsidised by insurance, see R-09 |
| #6 Price cherry-picking "mitigated" | **Understated**, see R-01 |
| #7 Fee-on-transfer, over-debit, freeze | Hold (balance-delta checks; only the frozen party is affected) |
| Slither `arbitrary-send-eth` / `reentrancy-eth` false positives | Agree. Every state-changing external function holds the transient lock except owner-only admin and `selfFill` (self-call guard). The Pyth fee is metered against `msg.value` only: `test_PythFeeNeverPaidFromEscrow` |
| Residual #5 (insurance as counterparty) | **Understated.** Losses are not lane-contained, see R-05 |
| Residual #7 (fresh-price window) | **Understated**, see R-01 |
| Ops alert `solvency().surplus < 0` | **Cannot detect trading bad debt**, see R-05 |

## Checked and found sound

- **Oracle.**
  - Exponent normalisation in [−30, 12] with no overflow (`raw ≤ 2^63`, `10^30`).
  - `price <= 0` rejected; confidence compared in raw units; `> uint128` rejected.
  - The fill window `[execAfter, deadline]` is enforced both by Pyth and by the contract. `parsePriceFeedUpdatesUnique`
    returns exactly one admissible message per feed (`prev < execAfter ≤ publish`), so **fill prices cannot be chosen**
    by anyone.
  - Feed ids are unique across markets; the response id and order are checked.
  - A malformed or partial update falls back to stored prices without charging a fee.
  - Escrowed MON can never pay Pyth.
  - Excess `msg.value` is refunded inside the lock.
- **Orders.**
  - Order ids are account-scoped (`account << 96 | nonce`) with no collisions. Replay and double execution revert, and
    cancel works only after the deadline.
  - Escrow: margin is reserved and released exactly once; native escrow → owed → claim is balanced (`nativeSolvency`).
  - `Failed` reverts all fill effects and only releases escrow and pays the executor.
  - Slippage direction is correct for buys and sells, opens and closes.
  - Flip is prevented at commit and at fill.
  - The free option exists only while no keeper executes, bounded by `maxExecDelay` (residual). A trader can turn an
    increase into `Failed` by withdrawing, but learns nothing beyond the market price at `execAfter`.
- **Accounting.**
  - The solvency identities hold by construction (every collateral change goes through `_adjustCollateral`, every lane
    flow through `_creditLane`/`_debitLane`).
  - Rounding is always against the user: PnL and funding floored, fee and MM ceiled, entry prices rounded against the
    holder, reduced margin ceiled. Fuzzed in `testFuzz_RoundTripAtConstantPriceNeverProfits`.
  - Funding is settled before every size change and in `_closeLeg`, `_inherit` and the pool paths. The `int64` rate and
    `int128` index have ample headroom.
  - Lane OI equals positions plus pool bookings.
- **Auctions and pools.**
  - External take payment is capped at E⁺ and the taker must be in the same lane and registered. Self-take is blocked.
  - Duplicate accounts in batches are harmless. `_endAuction` swap-pop is consistent.
  - Expiry penalty and keeper split are balanced.
  - Pool first-depositor and donation inflation is not possible: there is no donation path to pool cash, the first
    deposit mints 1:1, the minimum deposit is 1 AUSD, and withdrawals are pro-rata and floored. Fuzzed in
    `testFuzz_PoolRoundTripNeverProfits`. R-08 is the governance-only exception.
  - The withdrawal margin guard and cash check hold.
- **Access control.**
  - Every setter is `onlyOwner`; `renounceOwnership` is disabled; `pause` is guardian or owner; `unpause` is owner
    only; `selfFill` is guarded by `msg.sender == this`.
  - There is no initializer and no proxy, so no re-initialisation.
  - The deploy script leaves the deployer with no power, and the timelock administers itself.
- **Reentrancy.**
  - The EIP-1153 lock covers all state-changing user paths. Native pushes cannot re-enter
    (`test_NativeRefundReentrancyBlocked`). Pyth and token re-entry are covered by existing tests.
  - The price cache is scoped per call id and invalidated on exit.
- **DoS.**
  - All state-changing loops are bounded by 8 (markets, legs, lanes).
  - `_laneAccounts` grows unboundedly but is used only in paged views.
  - Users without positions can always withdraw, subject to AUSD-level freezes and R-05.

## Residual risks that remain after the fixes

1. **Oracle trust.** Pyth is upgradeable by Pyth governance and is the sole price authority. The Hermes API key is a
   liveness dependency for keepers. A small selection window remains even with per-lane monotonic prices: any price
   between the last one used in the lane and `now`.
2. **Gap risk against insurance as counterparty.** Cross-lane hedged pairs profit from gaps larger than `1/leverage`.
   Correlated markets (MON, SOL, BTC) are not netted against lane backing. Unless real lane isolation is implemented,
   losses are mutualised across lanes.
3. **Agora AUSD powers:** freeze, pause, burn and instant upgrade.
4. **Keeper liveness:** the order free option during outages (≤ `maxExecDelay`), funding updates, and the 8 s Monad
   auction (25 bps per 400 ms block).
5. **Governance.** The multisig plus a 24 h timelock can change the oracle, feeds and parameters. There is no outflow
   circuit breaker.
6. **Monad specifics.** Gas-limit billing affects keeper economics. AUSD and native balance writes serialise deposits,
   withdrawals and commits under parallel execution.
7. **Unaudited.** An external audit is required before raising caps above the beta values.
