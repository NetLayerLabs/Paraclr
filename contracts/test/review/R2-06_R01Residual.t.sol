// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R2-06 (Low): R-01 residual. A dip print NEWER than the lane price can still start an
///        auction on an account that is healthy at the live price.
///        **ACCEPTED (v3, by decision) — NOT FLIPPED.** Kept as a regression of the BOUND: the loss
///        is limited to the dip-to-live difference (SECURITY_NOTES §4). With v3's cure at
///        maintenance (R2-05) the victim can also no longer be trapped in a running auction.
/// @notice Monotonic lane prices stop anyone from going BACK in time. But the first caller after a
///         quiet period still picks any Pyth message in (lane/stored publish time, now] (supplied
///         updates up to `maxPriceAge` = 30 s old). A same-lane bot that sees a one-second dip on
///         Hermes starts the auction and takes in the same block (discount 0, payment 0). The
///         victim loses only the dip-to-live price difference, unless it lands in the R2-05 band,
///         where the clock keeps running. This is documented (SECURITY_NOTES §4.4); the PoC shows
///         the size.
contract R2_06_R01ResidualTest is ReviewBase {
    uint8 internal constant L = 5;

    function test_R2_06_DipPrintNewerThanLaneStillLiquidatesHealthyAccount() public {
        address v = laneAddr(L, 1);
        fund(v, 100e6);
        _open(v, MON, true, 1_900e6, 95e6); // 19x, liquidation price ~2.9165
        address bot = laneAddr(L, 9);
        fund(bot, 5_000e6);
        _store(FEED_MON, 2.92e8, block.timestamp); // last push: 2.92
        uint256 t0 = block.timestamp;
        vm.warp(t0 + 3);
        bytes[] memory dip = _updMon(2.91e8, t0 + 2); // a 1 s dip print
        bytes[] memory live = _updMon(2.92e8, t0 + 3); // back to 2.92
        uint256 snap = vm.snapshotState();
        assertEq(ch.startAuctions(L, _one(v), live), 0, "healthy at the live price");
        vm.revertToState(snap);

        vm.startPrank(bot);
        assertEq(ch.startAuctions(L, _one(v), dip), 1, "started on the newer-than-lane dip");
        ch.take(v, _none()); // same block, discount 0
        vm.stopPrank();
        pyth.updatePriceFeeds(live);
        (int256 upnl,) = ch.unrealizedPnl(bot, MON);
        emit log_named_decimal_int("bot's mark-to-live gain = victim's extra loss", upnl, 6);
        assertGt(upnl, 6e6);
        assertLt(upnl, 7e6, "bounded by the dip size");
    }
}
