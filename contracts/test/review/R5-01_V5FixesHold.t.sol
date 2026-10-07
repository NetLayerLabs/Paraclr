// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R5-01: v5 fixes hold under variants of the R4 PoCs (regressions; keep).
contract R5_01_V5FixesHoldTest is ReviewBase {
    uint8 internal constant L = 5;
    address internal lpA = makeAddr("lpA");
    address internal lpB = makeAddr("lpB");

    function _poolWithGain() internal {
        uint256[8] memory seed;
        seed[L] = 100e6;
        _bareClearinghouse(seed);
        _lpDeposit(lpA, L, 1_000e6);
        _lpDeposit(lpB, L, 1_000e6);
        address v = laneAddr(L, 3);
        fund(v, 50e6);
        _open(v, MON, true, 400e6, 40e6);
        _setSpot(FEED_MON, 2.65e8);
        ch.startAuctions(L, _one(v), _none());
        vm.roll(block.number + 3);
        assertEq(ch.backstopTakeBatch(L, _one(v), _none()), 1);
    }

    /// R4-01 variant: the loser-first insurance lift no longer moves the exit NAV.
    function test_R5_01a_InsuranceLiftDoesNotMoveExitNav() public {
        _poolWithGain();
        uint256 sA = ch.backstopSharesOf(L, lpA);
        vm.prank(lpA);
        ch.backstopRequestWithdraw(L, sA);
        address w = laneAddr(L, 1);
        address x = laneAddr(L, 2);
        fund(w, 100e6);
        fund(x, 100e6);
        _open(w, SOL, false, 700e6, 70e6);
        _open(x, SOL, true, 700e6, 70e6);
        vm.warp(block.timestamp + 1 hours);
        _setSpot(FEED_MON, 4.2e8);
        _setSpot(FEED_SOL, 162e8);
        (int256 nav0, int256 cash0,,) = ch.backstopNav(L);
        assertEq(nav0, cash0, "gain counts 0 on exit");
        _closeAll(x, SOL); // insurance lifted
        (int256 nav1,,,) = ch.backstopNav(L);
        assertEq(nav1, nav0, "exit NAV independent of insurance");
        vm.prank(lpA);
        uint256 out = ch.backstopWithdraw(L, sA, _none());
        assertEq(out, uint256(nav0) / 2, "paid exactly half the cash");
    }

    /// R4-02: the last shares cannot leave a pool holding dust; once flat, the sweep forgives.
    function test_R5_01b_LastShareBlockedWhileDustHeld_ThenSwept() public {
        _poolWithGain();
        (, int256[] memory sz,) = ch.backstopPositions(L);
        vm.prank(admin);
        ch.backstopReduce(L, MON, uint256(sz[0]) - 1e11, _none()); // dust left
        uint256 sB = ch.backstopSharesOf(L, lpB);
        _lpWithdraw(lpB, L, sB); // not the last: fine
        uint256 sA = ch.backstopSharesOf(L, lpA);
        _requestAndWait(lpA, L, sA);
        vm.prank(lpA);
        vm.expectRevert(abi.encodeWithSelector(CH.BackstopPositionsOpen.selector, L));
        ch.backstopWithdraw(L, sA, _none());
        vm.prank(admin); // the lane keeper's pool-exit helper does this when the request is ripe
        ch.backstopReduce(L, MON, type(uint256).max, _none());
        vm.prank(lpA);
        ch.backstopWithdraw(L, sA, _none());
        (, int256 cash,, uint256 supply) = ch.backstopNav(L);
        assertEq(supply, 0);
        assertEq(cash, 0);
        assertEq(ch.backstopReceivable(L), 0);
        assertSolvent();
    }

    /// R4-04: a zombie (wide-confidence) feed is dead, so the 50% bound applies and recovery works.
    function test_R5_01c_ZombieFeedRecoverable() public {
        address a = laneAddr(3, 1);
        fund(a, 1_000e6);
        _open(a, MON, true, 500e6, 50e6);
        _open(a, SOL, true, 500e6, 50e6);
        vm.warp(block.timestamp + 3 days);
        _store(FEED_SOL, spot[FEED_SOL], block.timestamp);
        pyth.setStoredPrice(FEED_MON, 3.4e8, uint64(17_000_000), EXPO, block.timestamp); // conf 5%
        bytes32 newFeed = keccak256("MON/USD v2 feed");
        pyth.setStoredPrice(newFeed, 3.4e8, 3e4, EXPO, block.timestamp);
        vm.prank(admin);
        ch.replaceMarketFeed(MON, newFeed, 5_000);
        vm.prank(a);
        ch.withdraw(1e6, _none());
    }
}
