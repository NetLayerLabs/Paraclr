// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R3-05 (Low): the in-auction reduce's "current price" check could be collapsed onto the
///        stale fill price by the executor's blob order. **FLIPPED INTO A REGRESSION (v4).**
/// @notice FLIPPED 2026-10-07 after the v4 fix: blob order no longer decides the check.
///         Original finding (v3): the order market's "current" price was resolved through
///         `_beginPricing` from the executor's blob, where Pyth takes the FIRST in-range message;
///         a trader self-executing with [unique fill message, latest] made "current" == the fill
///         price and escaped the auction while below maintenance at the real price.
///         Fix (v4): `_orderCurrentPrice` parses the order market on its own with publishTime >=
///         minT = max(execAfter + 1, now - maxStoredPriceAge) and requires the resolved price
///         (newest of supplied, stored, lane) to be >= minT as well: strictly newer than the fill
///         message and no older than `maxStoredPriceAge`, whatever the blob order, and even if the
///         fill message is pushed into Pyth storage. No such price: the call reverts, the order
///         stays pending. Residual (documented): the executor still chooses WHICH real price in
///         that <= 15 s window to include.
contract R3_05_ReduceInAuctionCurrentPriceTest is ReviewBase {
    uint8 internal constant L = 5;
    address internal v;
    uint256 internal id;
    CH.Order internal o;

    function _blob2(bytes[] memory a, bytes[] memory b) internal pure returns (bytes[] memory u) {
        u = new bytes[](2);
        u[0] = a[0];
        u[1] = b[0];
    }

    /// @dev 19x MON long put in auction at 2.88; a reduce-only half close committed in auction.
    function _setUpAuctionReduce() internal {
        v = laneAddr(L, 1);
        fund(v, 100e6);
        _open(v, MON, true, 1_900e6, 95e6); // 19x at 3.00; storage pushed now (t0)
        vm.warp(block.timestamp + 1);
        assertEq(ch.startAuctions(L, _one(v), _updMon(2.88e8, block.timestamp)), 1);
        id = _commit(v, MON, -int256(ch.getPosition(v, MON).size / 2), 0, 1);
        o = ch.getOrder(id);
    }

    function test_R3_05_BlobOrderNoLongerDecidesTheCurrentPriceCheck() public {
        _setUpAuctionReduce();
        // Pyth: 2.95 at execAfter (the unique fill), then 2.80 at execution time (+7 s)
        vm.warp(o.execAfter + 7);
        vm.roll(block.number + 1);
        bytes[] memory uniq = _upd1(FEED_MON, 2.95e8, o.execAfter, o.execAfter - 1);
        bytes[] memory latest = _updMon(2.8e8, block.timestamp);

        uint256 snap = vm.snapshotState();
        vm.prank(keeper); // recommended order: [latest, unique] → current = 2.80
        ch.executeOrder(id, _blob2(latest, uniq));
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Failed), "below MM at the real price");
        vm.revertToState(snap);

        vm.prank(v); // the trader self-executes with [unique, latest] → current is STILL 2.80
        ch.executeOrder(id, _blob2(uniq, latest));
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Failed), "no escape via blob order");
        (bool active,,) = ch.auctionOf(v);
        assertTrue(active, "still in auction");
    }

    function test_R3_05c_FillMessageInStorageIsNotACurrentPrice() public {
        _setUpAuctionReduce();
        vm.warp(o.execAfter + 7);
        vm.roll(block.number + 1);
        bytes[] memory uniq = _upd1(FEED_MON, 2.95e8, o.execAfter, o.execAfter - 1);
        pyth.updatePriceFeeds(uniq); // the trader pushes the fill message into Pyth storage
        vm.prank(v);
        vm.expectRevert(abi.encodeWithSelector(CH.StalePrice.selector, MON, uint256(o.execAfter)));
        ch.executeOrder(id, uniq); // "current" would be the fill message itself
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Pending), "order stays pending");
    }

    function test_R3_05d_CurrentPriceMustBeWithinMaxStoredPriceAge() public {
        _setUpAuctionReduce();
        uint256 t = uint256(o.execAfter) + 25; // inside the order window (deadline +60)
        assertLe(t, o.deadline);
        vm.warp(t);
        vm.roll(block.number + 1);
        bytes[] memory uniq = _upd1(FEED_MON, 2.95e8, o.execAfter, o.execAfter - 1);
        // 2.95 published 20 s ago: within maxPriceAge (30 s) but older than maxStoredPriceAge
        bytes[] memory older = _updMon(2.95e8, t - 20);
        assertGt(20, ch.maxStoredPriceAge());
        vm.prank(v);
        vm.expectPartialRevert(CH.StalePrice.selector);
        ch.executeOrder(id, _blob2(uniq, older));
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Pending));
    }

    /// @notice Sound: an honest cure still works when the market really is at 2.95 now.
    function test_R3_05e_HonestCureAtRealCurrentPrice() public {
        _setUpAuctionReduce();
        vm.warp(o.execAfter + 7);
        vm.roll(block.number + 1);
        bytes[] memory uniq = _upd1(FEED_MON, 2.95e8, o.execAfter, o.execAfter - 1);
        bytes[] memory latest = _updMon(2.95e8, block.timestamp);
        vm.prank(v);
        ch.executeOrder(id, _blob2(uniq, latest)); // any order works
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Executed));
        (bool active,,) = ch.auctionOf(v);
        assertFalse(active, "cured");
        assertSolvent();
    }

    /// @notice Sound: a bankrupt account in auction cannot escape with a full close.
    function test_R3_05b_BankruptFullCloseInAuctionFails() public {
        address b = laneAddr(L, 2);
        fund(b, 100e6);
        _open(b, MON, true, 1_900e6, 95e6);
        _setSpot(FEED_MON, 2.88e8);
        assertEq(ch.startAuctions(L, _one(b), _none()), 1);
        uint256 oid = _commit(b, MON, -int256(ch.getPosition(b, MON).size), 0, 1);
        _setSpot(FEED_MON, 2.8e8); // equity < 0 at the fill price
        _execute(oid);
        assertEq(uint8(ch.getOrder(oid).status), uint8(CH.OrderStatus.Failed));
        (bool active,,) = ch.auctionOf(b);
        assertTrue(active, "still in auction");
    }
}
