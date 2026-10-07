// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R-10 (Low) executor decides multi-leg outcomes; R-11 (Low) a stale reduce order
///        increases an inherited position. **FLIPPED INTO REGRESSIONS.**
/// @notice FLIPPED 2026-10-07 after the fix.
///         R-10 fix (v2): other legs priced deterministically from storage / lane price. v3 (decision
///         R2-03): other legs are priced from the executor's update through the monotonic lane path;
///         prices older than the lane's newest cannot be used, so they cannot steer the outcome.
///         R-11 fix: an order records `reduceOnly` and the id of the position it applies to; if the
///         position changed (taken, inherited, re-opened) the fill fails (`PositionChanged`). A
///         reduce order can never increase anything.
contract R10_R11_OrderEdgesTest is ReviewBase {
    uint8 internal constant L = 5;

    /// @notice v3 note: by decision R2-03 the executor's update now prices the other legs too,
    ///         through the per-lane monotonic path. What R-10 still guarantees: the outcome cannot
    ///         be steered with prices OLDER than the newest one the lane has used (stored push or
    ///         lane price). Steering with a NEWER real price is the bounded R2-06 residual.
    function test_R10_ExecutorCannotChooseOutcomeViaOlderOtherLegPrices() public {
        address a = laneAddr(3, 1);
        fund(a, 200e6);
        _open(a, BTC, true, 1_000e6, 100e6);
        uint256 id = _commit(a, MON, int256(_sizeFor(900e6, MON)), 90e6, type(uint128).max);
        CH.Order memory o = ch.getOrder(id);
        vm.warp(o.execAfter + 1);
        _refreshStored();
        bytes[] memory first = _upd1(FEED_MON, spot[FEED_MON], o.execAfter, o.execAfter - 1);
        // a griefer's BTC print 1.2% lower but OLDER than the stored push
        bytes[] memory older = _upd3(spot[FEED_MON], spot[FEED_SOL], 98_800e8, block.timestamp - 1);
        bytes[] memory withOlder = new bytes[](2);
        withOlder[0] = first[0];
        withOlder[1] = older[0];

        uint256 snap = vm.snapshotState();
        vm.prank(keeper);
        ch.executeOrder(id, first);
        CH.OrderStatus s1 = ch.getOrder(id).status;
        vm.revertToState(snap);
        address griefer = makeAddr("griefer");
        vm.prank(griefer);
        ch.executeOrder(id, withOlder);
        CH.OrderStatus s2 = ch.getOrder(id).status;
        assertEq(uint8(s1), uint8(s2), "same outcome: older prices cannot steer");
        assertEq(uint8(s2), uint8(CH.OrderStatus.Executed));
    }

    function test_R11_StaleReduceOrderFailsOnInheritedPosition() public {
        _lpDeposit(makeAddr("lp"), L, 50_000e6);
        address a = laneAddr(L, 1);
        fund(a, 100e6);
        _open(a, MON, true, 1_900e6, 95e6);
        uint256 longId = ch.getPosition(a, MON).id;
        uint256 sellSize = ch.getPosition(a, MON).size / 3;
        uint256 id = _commit(a, MON, -int256(sellSize), 0, 1);
        CH.Order memory o = ch.getOrder(id);
        assertTrue(o.reduceOnly);
        assertEq(o.positionId, longId);

        vm.warp(block.timestamp + 1);
        _setSpot(FEED_MON, 2.88e8);
        ch.startAuctions(L, _one(a), _none());
        vm.roll(block.number + 3);
        assertEq(ch.backstopTakeBatch(L, _one(a), _none()), 1);
        vm.prank(admin);
        ausd.ownerMint(a, 300e6);
        vm.prank(a);
        ch.deposit(300e6);
        address b = laneAddr(L, 2);
        fund(b, 110e6);
        _open(b, MON, false, 1_000e6, 100e6);
        _setSpot(FEED_MON, 3.14e8);
        ch.startAuctions(L, _one(b), _none());
        vm.prank(a);
        ch.take(b, _none());
        CH.Position memory inherited = ch.getPosition(a, MON);
        assertFalse(inherited.isLong);
        assertTrue(inherited.id != longId, "inherited position has a new id");

        assertLe(block.timestamp, o.deadline);
        vm.prank(keeper);
        ch.executeOrder(id, _updMon(3e8, o.execAfter));
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Failed), "stale reduce fails");
        CH.Position memory p = ch.getPosition(a, MON);
        assertEq(p.size, inherited.size, "short untouched");
        assertEq(p.margin, inherited.margin);
    }

    /// @notice R-11 variant (same side): the long a stale reduce was meant for is taken, and the
    ///         account then inherits ANOTHER long in the same market. The order must not reduce the
    ///         inherited position: it applies only to the position id recorded at commit.
    function test_R11b_StaleReduceDoesNotTouchInheritedSameSidePosition() public {
        _lpDeposit(makeAddr("lp"), L, 50_000e6);
        address a = laneAddr(L, 1);
        address b = laneAddr(L, 2);
        fund(a, 100e6);
        fund(b, 100e6);
        _open(a, MON, true, 1_900e6, 95e6);
        _open(b, MON, true, 1_900e6, 95e6);
        uint256 sellSize = ch.getPosition(a, MON).size / 3;
        uint256 id = _commit(a, MON, -int256(sellSize), 0, 1);
        CH.Order memory o = ch.getOrder(id);
        vm.warp(block.timestamp + 1);
        _setSpot(FEED_MON, 2.88e8);
        address[] memory both = new address[](2);
        both[0] = a;
        both[1] = b;
        assertEq(ch.startAuctions(L, both, _none()), 2);
        vm.roll(block.number + 3);
        assertEq(ch.backstopTakeBatch(L, _one(a), _none()), 1, "a's long goes to the pool");
        vm.prank(admin);
        ausd.ownerMint(a, 500e6);
        vm.prank(a);
        ch.deposit(500e6);
        vm.prank(a);
        ch.take(b, _none()); // a inherits b's LONG
        CH.Position memory inherited = ch.getPosition(a, MON);
        assertTrue(inherited.isLong);
        assertTrue(inherited.id != o.positionId);
        vm.warp(o.execAfter + 1);
        _refreshStored();
        assertLe(block.timestamp, o.deadline);
        vm.prank(keeper);
        ch.executeOrder(id, _updMon(2.88e8, o.execAfter));
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Failed), "position changed since commit");
        assertEq(ch.getPosition(a, MON).size, inherited.size, "inherited long untouched");
    }
}
