// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R2-10: v2 properties checked and found SOUND (regressions; keep after fixes).
contract R2_10_SoundV2Test is ReviewBase {
    uint8 internal constant L = 5;

    /// @notice Pool epochs: a ripe request from a retired epoch is dead; old LPs hold 0 shares in
    ///         the new epoch and cannot touch new LPs' money; new deposits start at 1:1.
    function test_R2_10a_StaleRequestAcrossEpochIsDead() public {
        address lp1 = makeAddr("lp1");
        uint256 s1 = _lpDeposit(lp1, L, 300e6);
        vm.prank(lp1);
        ch.backstopRequestWithdraw(L, s1);
        address v = laneAddr(L, 1);
        fund(v, 100e6);
        _open(v, MON, true, 1_900e6, 95e6);
        _setSpot(FEED_MON, 2.88e8);
        ch.startAuctions(L, _one(v), _none());
        vm.roll(block.number + 3);
        assertEq(ch.backstopTakeBatch(L, _one(v), _none()), 1);
        _setSpot(FEED_MON, 2.3e8); // pool insolvent
        vm.prank(admin);
        ch.backstopReduce(L, MON, type(uint256).max, _none()); // flat, negative → reset
        assertEq(ch.backstopEpoch(L), 1);
        assertEq(ch.backstopSharesOf(L, lp1), 0);
        address lp2 = makeAddr("lp2");
        uint256 s2 = _lpDeposit(lp2, L, 500e6);
        assertEq(s2, 500e6, "fresh 1:1");
        vm.warp(block.timestamp + 2 hours); // lp1's old request would be ripe
        _refreshStored();
        vm.prank(lp1);
        vm.expectRevert(abi.encodeWithSelector(CH.NoWithdrawRequest.selector, L, lp1));
        ch.backstopWithdraw(L, 1, _none());
        vm.prank(lp1);
        vm.expectRevert(abi.encodeWithSelector(CH.InsufficientShares.selector, 1, 0));
        ch.backstopRequestWithdraw(L, 1);
        assertEq(_lpWithdraw(lp2, L, s2), 500e6, "new LP whole");
        assertSolvent();
    }

    /// forge-config: default.fuzz.runs = 128
    /// @notice v2 replacement for R99's pool round trip (which is vacuous under v2: its one-step
    ///         withdraw always reverts inside try/catch). Deposit, request, wait, withdraw at an
    ///         unchanged price never returns more than was paid in.
    function testFuzz_R2_10c_PoolRoundTripNeverProfits(uint256 amount, int256 moveBps) public {
        amount = bound(amount, 1e6, 20_000e6);
        moveBps = bound(moveBps, -500, 500);
        _lpDeposit(makeAddr("lp1"), L, 1_000e6);
        address v = laneAddr(L, 1);
        fund(v, 100e6);
        _open(v, MON, true, 1_900e6, 95e6);
        _setSpot(FEED_MON, 2.88e8);
        ch.startAuctions(L, _one(v), _none());
        vm.roll(block.number + 3);
        ch.backstopTakeBatch(L, _one(v), _none());
        _setSpot(FEED_MON, int64(int256(2.88e8) * (10_000 + moveBps) / 10_000));
        address lp2 = makeAddr("lp2");
        uint256 shares = _lpDeposit(lp2, L, amount);
        uint256 out = _lpWithdraw(lp2, L, shares); // must succeed (no try/catch)
        assertLe(out, amount, "no free value");
        assertSolvent();
    }

    /// @notice The haircut is pro rata and order-independent (to rounding), and it never lets a
    ///         lane pay more than it holds.
    function test_R2_10b_HaircutIsOrderIndependent() public {
        uint256[8] memory seed;
        seed[3] = 100e6;
        _bareClearinghouse(seed);
        address w = laneAddr(3, 1);
        address y = laneAddr(3, 3);
        address z = laneAddr(3, 4);
        fund(w, 100e6);
        fund(y, 700e6);
        fund(z, 300e6);
        _open(w, MON, false, 500e6, 50e6);
        _setSpot(FEED_MON, 1.8e8);
        _closeAll(w, MON); // winner realises 200 against 100 of insurance: bad debt ~100
        (,,,, uint256 debt,) = ch.laneSolvency(3);
        assertGt(debt, 90e6);
        uint256 snap = vm.snapshotState();
        vm.prank(y);
        ch.withdraw(700e6, _none());
        vm.prank(z);
        ch.withdraw(300e6, _none());
        uint256 y1 = ausd.balanceOf(y);
        uint256 z1 = ausd.balanceOf(z);
        vm.revertToState(snap);
        vm.prank(z);
        ch.withdraw(300e6, _none());
        vm.prank(y);
        ch.withdraw(700e6, _none());
        assertApproxEqAbs(ausd.balanceOf(y), y1, 1, "same payout either order");
        assertApproxEqAbs(ausd.balanceOf(z), z1, 1);
        assertApproxEqAbs(y1 * 3, z1 * 7, 10, "pro rata");
        assertSolvent();
    }
}
