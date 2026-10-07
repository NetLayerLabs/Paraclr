// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R4-02 (Low): a dust pool position skipped the R3-01 sweep, and the next depositor took the
///        repaid receivable. **FLIPPED INTO A REGRESSION (v5).**
/// @notice FLIPPED 2026-10-07 after the v5 fix: the last LP cannot leave a pool that holds a position.
///         Original finding (v4): `_poolSweepIfEmpty` only runs for a FLAT pool. A dust position
///         (exposure floored to 0, so the margin guard required 0) let the last LP out without the
///         sweep; the receivable was later repaid into a share-less pool and the next 1:1 depositor
///         collected it.
///         Fix (v5): `backstopWithdraw` refuses a withdrawal that would leave zero shares while the
///         pool holds any position (`BackstopPositionsOpen`). The lane operator (or the timelock)
///         unwinds the remainder first; the last exit then always runs the sweep, so
///         `supply == 0 ⇒ no positions, no cash, no receivable` holds.
contract R4_02_DustPositionSkipsSweepTest is ReviewBase {
    uint8 internal constant L = 5;
    address internal lp = makeAddr("lp");
    address internal attacker = makeAddr("attacker");

    event BackstopSwept(uint8 indexed lane, uint256 cash, uint256 receivableForgiven);

    function setUp() public override {
        super.setUp();
        uint256[8] memory seed;
        seed[L] = 100e6;
        _bareClearinghouse(seed);
    }

    function test_R4_02_LastLpCannotLeaveDust_SweepAlwaysRuns() public {
        uint256 s = _lpDeposit(lp, L, 400e6);
        // the pool takes a liquidated MON long, then is unwound to a dust remainder
        address v = laneAddr(L, 3);
        fund(v, 50e6);
        _open(v, MON, true, 400e6, 40e6);
        _setSpot(FEED_MON, 2.65e8);
        ch.startAuctions(L, _one(v), _none());
        vm.roll(block.number + 3);
        assertEq(ch.backstopTakeBatch(L, _one(v), _none()), 1);
        (, int256[] memory sz,) = ch.backstopPositions(L);
        vm.prank(admin); // a lane operator (keeper hot key) in production
        ch.backstopReduce(L, MON, uint256(sz[0]) - 1e11, _none()); // leaves 1e11 base units
        (bytes32[] memory pm,,) = ch.backstopPositions(L);
        assertEq(pm.length, 1, "dust position left");

        // a hedged SOL pair drains insurance and part of the pool: receivable outstanding
        address w = laneAddr(L, 1);
        address x = laneAddr(L, 2);
        fund(w, 100e6);
        fund(x, 400e6);
        _open(w, SOL, false, 700e6, 70e6);
        _open(x, SOL, true, 700e6, 70e6);
        _setSpot(FEED_SOL, 135e8); // -25%: w +175
        _closeAll(w, SOL);
        uint256 rec = ch.backstopReceivable(L);
        assertGt(rec, 20e6);

        // the last LP may not leave while the dust is open (partial exits still work)
        _requestAndWait(lp, L, s);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(CH.BackstopPositionsOpen.selector, L));
        ch.backstopWithdraw(L, s, _none());
        vm.prank(lp);
        uint256 outPart = ch.backstopWithdraw(L, s / 2, _none());
        assertGt(outPart, 0, "partial exit fine");

        // the operator unwinds the dust; the last exit then sweeps and forgives the receivable
        vm.prank(admin);
        ch.backstopReduce(L, MON, type(uint256).max, _none());
        _requestAndWait(lp, L, s - s / 2);
        uint256 recNow = ch.backstopReceivable(L);
        vm.expectEmit(true, false, false, true, address(ch));
        emit BackstopSwept(L, 0, recNow);
        vm.prank(lp);
        ch.backstopWithdraw(L, s - s / 2, _none());
        (, int256 cash0,, uint256 supply) = ch.backstopNav(L);
        assertEq(supply, 0);
        assertEq(cash0, 0);
        assertEq(ch.backstopReceivable(L), 0, "forgiven");

        // the loser closes: nothing lands in the share-less pool
        _closeAll(x, SOL);
        (, int256 cash,,) = ch.backstopNav(L);
        assertEq(cash, 0, "no orphaned cash");

        // the next depositor gets back what it put in
        uint256 sA = _lpDeposit(attacker, L, 1e6);
        uint256 out = _lpWithdraw(attacker, L, sA);
        emit log_named_decimal_uint("receivable when the last LP left", recNow, 6);
        emit log_named_decimal_uint("1 AUSD depositor withdraws", out, 6);
        assertLe(out, 1e6);
        assertSolvent();
    }
}
