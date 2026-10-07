// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R4-05: `depositWithPrice` fee handling (sound) and the `_orderCurrentPrice` window
///        (residual, Info).
contract R4_05_DepositWithPriceAndCurrentWindowTest is ReviewBase {
    uint8 internal constant L = 5;

    /// @notice Sound: with a non-zero Pyth fee, `depositWithPrice` spends exactly the fee for a
    ///         holder, refunds the rest, never touches escrowed MON, and refunds everything for an
    ///         account without positions (the update is ignored).
    function test_R4_05a_DepositWithPriceFeesAndRefunds() public {
        _betaCaps();
        address u = laneAddr(L, 1);
        fund(u, 50e6);
        _open(u, MON, true, 450e6, 45e6);
        _commit(u, SOL, int256(_sizeFor(20e6, SOL)), 2e6, type(uint128).max); // escrows 0.1 MON
        pyth.setFees(0.01 ether, 0);
        _store(FEED_MON, 2.8e8, block.timestamp);
        vm.warp(block.timestamp + 20); // storage stale
        bytes[] memory upd = _upd1(FEED_MON, 2.8e8, block.timestamp, block.timestamp - 1);
        vm.prank(admin);
        ausd.ownerMint(u, 100e6);
        vm.prank(u);
        ausd.approve(address(ch), type(uint256).max);
        uint256 chBal = address(ch).balance;
        uint256 uBal = u.balance;
        vm.prank(u);
        ch.depositWithPrice{value: 1 ether}(20e6, upd);
        assertEq(uBal - u.balance, 0.01 ether, "exactly the Pyth fee");
        assertEq(address(ch).balance, chBal, "escrow untouched");
        vm.prank(u);
        vm.expectRevert(); // fee not covered: reverts, nothing taken from escrow
        ch.depositWithPrice{value: 0}(1e6, upd);

        address f = laneAddr(L, 2); // no positions
        vm.prank(admin);
        ausd.ownerMint(f, 10e6);
        vm.deal(f, 1 ether);
        vm.startPrank(f);
        ausd.approve(address(ch), type(uint256).max);
        ch.depositWithPrice{value: 0.5 ether}(10e6, upd);
        vm.stopPrank();
        assertEq(f.balance, 1 ether, "update ignored, everything refunded");
        assertSolvent();
    }

    /// @notice Residual (Info): inside the 15 s window, the executor still chooses WHICH newer
    ///         price is "current" (first in-range message in its blob). This is the accepted R2-06
    ///         class, now bounded to prices newer than execAfter and at most 15 s old.
    function test_R4_05b_ExecutorPicksAmongNewerCurrentPrices() public {
        address v = laneAddr(L, 1);
        fund(v, 100e6);
        _open(v, MON, true, 1_900e6, 95e6);
        vm.warp(block.timestamp + 1);
        assertEq(ch.startAuctions(L, _one(v), _updMon(2.88e8, block.timestamp)), 1);
        uint256 id = _commit(v, MON, -int256(ch.getPosition(v, MON).size / 2), 0, 1);
        CH.Order memory o = ch.getOrder(id);
        vm.warp(o.execAfter + 8);
        vm.roll(block.number + 1);
        bytes[] memory uniq = _upd1(FEED_MON, 2.95e8, o.execAfter, o.execAfter - 1);
        bytes[] memory low = _updMon(2.8e8, o.execAfter + 2); // a real print, newer than execAfter
        bytes[] memory high = _updMon(2.95e8, o.execAfter + 6); // another real print
        bytes[] memory a = new bytes[](2);
        a[0] = low[0];
        a[1] = uniq[0];
        bytes[] memory b = new bytes[](2);
        b[0] = high[0];
        b[1] = uniq[0];
        uint256 snap = vm.snapshotState();
        vm.prank(keeper);
        ch.executeOrder(id, a);
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Failed), "current = 2.80: fails");
        vm.revertToState(snap);
        vm.prank(v);
        ch.executeOrder(id, b);
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Executed), "current = 2.95: escapes");
    }
}
