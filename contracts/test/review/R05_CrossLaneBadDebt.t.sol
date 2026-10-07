// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R-05 (Medium): lane bad debt is paid with other lanes' deposits; `solvency()` stays true.
///        **FLIPPED INTO A REGRESSION.**
/// @notice FLIPPED 2026-10-07 after the fix: the test now asserts real lane isolation.
///         Fix: AUSD is accounted per lane (`held`). A lane's losses stay inside the lane:
///         insurance → the lane's backstop pool cash → bad debt, and bad debt is borne by the
///         lane's claimants through a pro-rata haircut on their withdrawals
///         (`held / (held + badDebt)`, which also retires the matching bad debt). A lane can never
///         pay out more than it holds. `laneSolvency(lane)` exposes `surplus = insurance − badDebt`
///         per lane, so the keeper alert sees trading losses.
contract R05_CrossLaneBadDebtTest is ReviewBase {
    function setUp() public override {
        super.setUp();
        uint256[8] memory seed;
        seed[3] = 100e6;
        _bareClearinghouse(seed);
    }

    function test_R05_LaneBadDebtStaysInLane_OtherLaneWithdrawsInFull() public {
        address x = laneAddr(3, 1);
        address y = laneAddr(5, 2);
        fund(x, 1_000e6);
        fund(y, 1_000e6);
        _open(x, MON, true, 500e6, 50e6);
        _setSpot(FEED_MON, 3.9e8); // +30%
        _closeAll(x, MON);
        uint256 debt = _badDebt(3);
        assertGt(debt, 45e6, "lane 3 owes ~49 AUSD it does not have");

        // fresh money is not drawn into the deficit lane (trader or LP); funding it is allowed
        address z = laneAddr(3, 9);
        vm.prank(admin);
        ausd.ownerMint(z, 10e6);
        vm.startPrank(z);
        ausd.approve(address(ch), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(CH.LaneInDeficit.selector, uint8(3)));
        ch.deposit(10e6);
        vm.expectRevert(abi.encodeWithSelector(CH.LaneInDeficit.selector, uint8(3)));
        ch.backstopDeposit(3, 10e6, _none());
        vm.stopPrank();

        // the per-lane view sees it
        (uint256 held3,, int256 surplus3,,, uint256 haircut) = ch.laneSolvency(3);
        assertEq(surplus3, -int256(debt), "lane surplus = insurance - bad debt < 0");
        assertGt(haircut, 0);
        (,, int256 surplus5,,,) = ch.laneSolvency(5);
        assertEq(surplus5, 0, "lane 5 unaffected");

        // x is paid pro rata from LANE 3's AUSD only
        uint256 xFree = ch.freeCollateral(x);
        uint256 preview = ch.previewWithdraw(x, xFree);
        assertLt(preview, xFree, "haircut");
        vm.prank(x);
        ch.withdraw(xFree, _none());
        assertEq(ausd.balanceOf(x), preview);
        assertLe(preview, held3, "never more than lane 3 holds");

        // y (lane 5) withdraws everything
        vm.prank(y);
        ch.withdraw(1_000e6, _none());
        assertEq(ausd.balanceOf(y), 1_000e6, "lane 5 made whole");
        assertSolvent();
        // the haircut retired lane 3's bad debt in proportion: nothing owed beyond what it holds
        (uint256 heldAfter, int256 claimsAfter,,,,) = ch.laneSolvency(3);
        assertGe(int256(heldAfter) + 1, claimsAfter, "lane 3 claims covered (to rounding)");
    }
}
