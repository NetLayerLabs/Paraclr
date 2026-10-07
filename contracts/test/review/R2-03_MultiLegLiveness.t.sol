// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R2-03 (Low): multi-leg executions needed a separate global Pyth push; steering.
///        **FLIPPED INTO A REGRESSION (v3).**
/// @notice FLIPPED 2026-10-07 after the v3 fix.
///         Fix: other legs are priced from the executor's `priceUpdate` through the normal
///         per-lane monotonic path (newest of supplied / Pyth-stored / the lane's last price).
///         a) the keeper's data shape fills a multi-leg close with NO separate Pyth push;
///         b) the executor cannot select an other-leg price OLDER than the lane price. Choosing
///            among real prices NEWER than the lane price remains possible (bounded, the same
///            window as R2-06; documented in SECURITY_NOTES §4).
contract R2_03_MultiLegLivenessTest is ReviewBase {
    function test_R2_03a_MultiLegCloseFillsWithKeeperDataShape_NoPushNeeded() public {
        address a = laneAddr(3, 1);
        fund(a, 1_000e6);
        _open(a, BTC, true, 1_000e6, 100e6);
        _open(a, MON, true, 500e6, 50e6);
        vm.warp(block.timestamp + 20); // storage now older than 15 s, no push follows
        uint256 id = _commit(a, MON, -int256(ch.getPosition(a, MON).size), 0, 1);
        CH.Order memory o = ch.getOrder(id);
        vm.warp(o.execAfter);
        bytes[] memory first = _upd1(FEED_MON, spot[FEED_MON], o.execAfter, o.execAfter - 1);
        bytes[] memory latest = _updAll(block.timestamp);
        bytes[] memory data = new bytes[](2);
        data[0] = first[0];
        data[1] = latest[0];
        vm.prank(keeper);
        ch.executeOrder(id, data); // first try
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Executed), "fills without a push");
        assertEq(ch.getPosition(a, MON).size, 0, "closed");
    }

    function test_R2_03b_ExecutorCannotSelectOlderOtherLegPrices() public {
        address a = laneAddr(3, 1);
        fund(a, 200e6);
        _open(a, BTC, true, 1_000e6, 100e6);
        uint256 id = _commit(a, MON, int256(_sizeFor(900e6, MON)), 90e6, type(uint128).max);
        CH.Order memory o = ch.getOrder(id);
        vm.warp(o.execAfter + 1);
        _refreshStored(); // BTC 100,000 at now
        bytes[] memory fill = _upd1(FEED_MON, spot[FEED_MON], o.execAfter, o.execAfter - 1);
        // a griefer's OLDER BTC print (98,800, published before the stored push) is ignored
        bytes[] memory olderBtc = new bytes[](2);
        olderBtc[0] = fill[0];
        olderBtc[1] = _upd3(spot[FEED_MON], spot[FEED_SOL], 98_800e8, block.timestamp - 1)[0];
        address griefer = makeAddr("griefer");
        vm.prank(griefer);
        ch.executeOrder(id, olderBtc);
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Executed), "older BTC cannot fail it");
        (uint256 btcLane,) = ch.lanePrice(3, BTC);
        assertEq(btcLane, 100_000e18, "the newest (stored) BTC price was used");
    }
}
