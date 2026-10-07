// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R-01 (High): prices can move BACKWARDS between calls. **FLIPPED INTO A REGRESSION.**
/// @notice FLIPPED 2026-10-07 after the fix. These tests originally asserted that the exploit
///         WORKS; they now assert that it FAILS. Same scenarios, same numbers.
///         Fix (ParaclrClearinghouseProd v2):
///         - per lane and market the contract records the newest price used (`lanePrice`); every
///           state-changing call uses the newest of (supplied update, Pyth-stored, lane price), so
///           no call can use a price older than one already used in its lane;
///         - Pyth-stored (and lane) prices are only usable for `maxStoredPriceAge` = 15 s;
///         - `cancelAuction` needs equity >= 110% of maintenance and never works in the start block;
///         - LP withdrawals are two-step (request → `backstopWithdrawDelay` → withdraw at the then
///           current, monotonic NAV).
///         Residual (documented): before any newer price has been used in a lane, a caller can
///         still pick the stored push (<= 15 s old) over a fresher Hermes price.
contract R01_PriceRegressionTest is ReviewBase {
    uint8 internal constant L = 5;
    address internal lp = makeAddr("lp");

    function setUp() public override {
        super.setUp();
        _lpDeposit(lp, L, 1_000e6);
    }

    function _victim(uint256 salt) internal returns (address v) {
        v = laneAddr(L, salt);
        fund(v, 100e6);
        _open(v, MON, true, 1_900e6, 95e6);
    }

    // ---------------------------------------------------------------- a) cure no longer stalls auctions

    function test_R01a_TraderCannotCureWithOlderStoredPrice_PoolTakes() public {
        address v = _victim(1);
        // Market drops 4% to 2.88; Pyth's on-chain push still shows 3.00.
        vm.warp(block.timestamp + 1);
        bytes[] memory live = _updMon(2.88e8, block.timestamp);
        assertEq(ch.startAuctions(L, _one(v), live), 1, "keeper starts the auction at the live price");
        vm.prank(v);
        assertFalse(ch.cancelAuction(v, _none()), "no cure in the start block");
        vm.roll(block.number + 2);
        vm.prank(v);
        assertFalse(ch.cancelAuction(v, _none()), "[] cannot go back to the older stored 3.00");
        (, uint256 t) = ch.lanePrice(L, MON);
        assertEq(t, block.timestamp, "lane remembers the live price");
        assertEq(ch.markPriceInLane(L, MON), 2.88e18);
        vm.roll(block.number + 1);
        assertEq(ch.backstopTakeBatch(L, _one(v), live), 1, "pool takes at its discount");
        assertEq(ch.getPosition(v, MON).size, 0);
        (, uint256 started,, uint256 cancelled,) = ch.auctionStats(L);
        assertEq(started, 1);
        assertEq(cancelled, 0);
    }

    // ---------------------------------------------------------------- b) healthy account not liquidated

    function test_R01b_HealthyAccountNotLiquidatableWithOlderStoredPrice() public {
        address v = _victim(2);
        address taker = laneAddr(L, 7);
        fund(taker, 5_000e6);
        _store(FEED_MON, 2.88e8, block.timestamp); // a pushed dip
        vm.warp(block.timestamp + 10);
        bytes[] memory live = _updMon(3e8, block.timestamp);
        assertEq(ch.startAuctions(L, _one(v), live), 0, "healthy at the live price");
        assertEq(ch.startAuctions(L, _one(v), _none()), 0, "[] cannot select the 10 s old dip any more");
        (bool active,,) = ch.auctionOf(v);
        assertFalse(active);
        vm.roll(block.number + 10);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(CH.NotInAuction.selector, v));
        ch.take(v, _none());
        assertEq(collateralOf(v), 99_050_000, "victim untouched");
        assertSolvent();
    }

    /// @notice The 0.34% realistic gap: the victim keeps everything.
    function test_R01e_SmallStaleGap_HealthyVictimKeepsEquity() public {
        address v = _victim(4);
        address taker = laneAddr(L, 8);
        fund(taker, 5_000e6);
        _store(FEED_MON, 2.91e8, block.timestamp);
        vm.warp(block.timestamp + 5);
        bytes[] memory live = _updMon(2.92e8, block.timestamp);
        assertEq(ch.startAuctions(L, _one(v), live), 0, "healthy at the live price");
        assertEq(ch.startAuctions(L, _one(v), _none()), 0, "not on the 5 s old push either");
        vm.roll(block.number + 11);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(CH.NotInAuction.selector, v));
        ch.take(v, _none());
        assertEq(collateralOf(v), 99_050_000, "victim keeps its collateral");
    }

    // ---------------------------------------------------------------- c) no withdraw past IM

    function test_R01c_CannotWithdrawPastInitialMarginWithOlderStoredPrice() public {
        address t = laneAddr(3, 9);
        fund(t, 1_000e6);
        _open(t, MON, true, 1_000e6, 100e6);
        vm.warp(block.timestamp + 20); // storage is now 20 s old (> 15 s)
        bytes[] memory live = _updMon(2.73e8, block.timestamp);
        uint256 freeBefore = 899_500_000; // what the stale 3.00 would have allowed
        vm.prank(t);
        vm.expectRevert(); // StalePrice: the 20 s old push is not usable any more
        ch.withdraw(freeBefore, _none());
        vm.prank(t);
        vm.expectRevert(); // InsufficientFreeCollateral at the live price
        ch.withdraw(freeBefore, live);
        vm.prank(t);
        ch.withdraw(1e6, live); // a small withdrawal at the live price records it for the lane
        uint256 freeLive = ch.freeCollateral(t); // now priced at the lane's live price
        assertLt(freeLive, 810e6, "only what the live price allows");
        vm.prank(t);
        ch.withdraw(freeLive, _none()); // [] now uses the lane's live price (newer than storage)
        (int256 eq,, uint256 im,) = ch.accountHealth(t);
        assertGe(eq, int256(im), "still at/above initial margin");
        assertFalse(ch.isLiquidatable(t));
    }

    // ---------------------------------------------------------------- d) no LP exit at a stale NAV

    function test_R01d_LpCannotExitAtStaleNav() public {
        address lp2 = makeAddr("lp2");
        _lpDeposit(lp2, L, 1_000e6);
        address v = _victim(3);
        _setSpot(FEED_MON, 2.88e8);
        ch.startAuctions(L, _one(v), _none());
        vm.roll(block.number + 3);
        assertEq(ch.backstopTakeBatch(L, _one(v), _none()), 1, "pool holds a long at 2.88");
        vm.warp(block.timestamp + 15);
        uint256 shares = ch.backstopSharesOf(L, lp);
        // one-step exit is gone
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(CH.NoWithdrawRequest.selector, L, lp));
        ch.backstopWithdraw(L, shares, _none());
        vm.prank(lp);
        ch.backstopRequestWithdraw(L, shares);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(CH.WithdrawNotReady.selector, block.timestamp + 1 hours));
        ch.backstopWithdraw(L, shares, _none());
        // after the delay the market is at 2.60; the stored 2.88 is long stale
        vm.warp(block.timestamp + 1 hours);
        bytes[] memory live = _updMon(2.6e8, block.timestamp);
        vm.prank(lp);
        vm.expectRevert(); // StalePrice: no stale NAV
        ch.backstopWithdraw(L, shares, _none());
        uint256 snap = vm.snapshotState();
        vm.prank(lp);
        uint256 got = ch.backstopWithdraw(L, shares, live);
        (int256 eqAfter,,, uint256 supplyAfter) = ch.backstopNav(L);
        vm.revertToState(snap);
        // fair: LP1 got its pro-rata share of the LIVE NAV, LP2's share is worth the same
        uint256 lp2Shares = ch.backstopSharesOf(L, lp2);
        vm.prank(lp);
        ch.backstopWithdraw(L, shares, live);
        (int256 eq,,, uint256 supply) = ch.backstopNav(L);
        uint256 lp2Value = (lp2Shares * uint256(eq)) / supply;
        assertApproxEqAbs(got, lp2Value, 2, "both LPs bear the loss equally");
        assertLt(got, 920e6, "LP1 did not escape the loss");
        assertEq(supplyAfter, supply);
        assertEq(eqAfter, eq);
    }
}
