// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R2-05 (Medium): the cure buffer created a "zombie auction" band with a running clock.
///        **FLIPPED INTO A REGRESSION (v3).**
/// @notice FLIPPED 2026-10-07 after the v3 fix: the recovered account is CURED.
///         Fix: cure at maintenance (prices are monotonic per lane, so the flip-flop the buffer
///         guarded against is gone); the >= 1-block rule stays. An account in auction may also
///         commit reduce-only orders: they fill if they leave it at/above maintenance at both the
///         fill price and the current price, which ends the auction.
contract R2_05_CureBandTrapTest is ReviewBase {
    uint8 internal constant L = 5;

    function test_R2_05_RecoveredAccountIsCured_NotTakenAtMaxDiscount() public {
        address v = laneAddr(L, 1);
        fund(v, 100e6);
        _open(v, MON, true, 1_900e6, 95e6);
        address taker = laneAddr(L, 9);
        fund(taker, 5_000e6);
        _setSpot(FEED_MON, 2.88e8);
        assertEq(ch.startAuctions(L, _one(v), _none()), 1);
        _setSpot(FEED_MON, 2.92e8); // equity 48.4 >= MM 46.2 (inside the old 110% band)
        (int256 e, uint256 mm,,) = ch.accountHealth(v);
        assertGe(e, int256(mm));
        assertFalse(ch.cancelAuction(v, _none()), "not in the start block");
        vm.roll(block.number + 1);
        assertTrue(ch.cancelAuction(v, _none()), "cured at maintenance");
        (bool active,,) = ch.auctionOf(v);
        assertFalse(active);
        // the later -0.14% wiggle starts a FRESH auction at 0 bps instead of a 5% take
        _setSpot(FEED_MON, 2.916e8);
        assertEq(ch.startAuctions(L, _one(v), _none()), 1);
        (,, uint16 d) = ch.auctionOf(v);
        assertEq(d, 0, "fresh clock");
        vm.prank(taker);
        uint256 paid = ch.take(v, _none());
        assertEq(paid, 0, "taken at 0 bps in the start block: the trader keeps its equity");
        assertGt(collateralOf(v), 40e6);
    }

    function test_R2_05b_ReduceOnlyOrderInAuction_DeRisksAndEndsAuction() public {
        address v = laneAddr(L, 2);
        fund(v, 100e6);
        _open(v, MON, true, 1_900e6, 95e6);
        _setSpot(FEED_MON, 2.88e8);
        assertEq(ch.startAuctions(L, _one(v), _none()), 1);
        // in auction: increases are refused, reduce-only orders are accepted
        vm.prank(v);
        vm.expectRevert(abi.encodeWithSelector(CH.AccountInAuction.selector, v));
        ch.commitOrder{value: EXEC_FEE}(SOL, 1e18, 10e6, type(uint128).max);
        uint256 size = ch.getPosition(v, MON).size;
        // selling half would leave equity ~22.6 < MM ~22.8: the fill fails, the auction keeps running
        uint256 id = _commit(v, MON, -int256(size / 2), 0, 1);
        _execute(id);
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Failed), "would stay below MM");
        (bool on,,) = ch.auctionOf(v);
        assertTrue(on);
        // selling 3/4 leaves equity ~22.4 >= MM ~11.4: fills and ends the auction
        uint256 id2 = _commit(v, MON, -int256((size * 3) / 4), 0, 1);
        _execute(id2);
        assertEq(uint8(ch.getOrder(id2).status), uint8(CH.OrderStatus.Executed), "de-risked in auction");
        assertGt(ch.getPosition(v, MON).size, 0, "a quarter of the position remains");
        assertFalse(ch.isLiquidatable(v));
        (bool active,,) = ch.auctionOf(v);
        assertFalse(active, "auction ended by the de-risking fill");
        assertGt(collateralOf(v), 0, "trader keeps its equity minus fees, no discount paid");
        assertSolvent();
    }
}
