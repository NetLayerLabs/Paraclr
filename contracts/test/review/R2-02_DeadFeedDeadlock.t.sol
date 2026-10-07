// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";
import {PythErrors} from "@pythnetwork/pyth-sdk-solidity/PythErrors.sol";

/// @title R2-02 (Medium): a dead Pyth feed with open interest froze funds forever.
///        **FLIPPED INTO A REGRESSION (v3).**
/// @notice FLIPPED 2026-10-07 after the v3 fix: the deadlocked account RECOVERS.
///         Fix: `replaceMarketFeed(market, newFeed, maxDeviationBps)` (timelock only) repoints a
///         market even with open interest, if the new feed's fresh stored price is within
///         `maxDeviationBps` (<= 10%) of the market's newest price in every lane with OI. The
///         lane price markers of the market are reset. `setMarketConfig` still refuses a feed
///         change with OI (`MarketHasOpenInterest`) and points to the checked path.
///         Procedure: SECURITY_NOTES §4 (dead feed).
contract R2_02_DeadFeedDeadlockTest is ReviewBase {
    function test_R2_02_DeadFeed_RecoveredByTimelockedFeedSwap() public {
        address a = laneAddr(3, 1);
        fund(a, 1_000e6);
        _open(a, MON, true, 500e6, 50e6);
        _open(a, SOL, true, 500e6, 50e6); // records MON's lane price (3.00) as the other leg
        (uint256 ref, uint256 refT) = ch.lanePrice(3, MON);
        assertEq(ref, 3e18);
        assertGt(refT, 0);

        // MON's feed dies; the deadlock of v2 is still there until governance acts
        vm.warp(block.timestamp + 1 days);
        _store(FEED_SOL, spot[FEED_SOL], block.timestamp);
        _store(FEED_BTC, spot[FEED_BTC], block.timestamp);
        (,, uint256 monT) = ch.latestPrice(MON);
        vm.prank(a);
        vm.expectRevert(abi.encodeWithSelector(CH.StalePrice.selector, MON, monT));
        ch.withdraw(1e6, _none());

        // governance (owner = timelock in production) repoints MON to the re-issued feed
        bytes32 newFeed = keccak256("MON/USD v2 feed");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(CH.MarketHasOpenInterest.selector, MON));
        ch.setMarketConfig(MON, newFeed, 100_000e6, 10_000_000e6, 100); // the unchecked path stays closed
        // the new feed must be live and close to the last price (here 3.00 -> 3.06, +2%)
        pyth.setStoredPrice(newFeed, 3.4e8, 3e4, EXPO, block.timestamp);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(CH.FeedSwapDeviation.selector, uint8(3), 3e18, 3.4e18));
        ch.replaceMarketFeed(MON, newFeed, 500); // +13% vs the lane price: refused at 5%
        pyth.setStoredPrice(newFeed, 3.06e8, 3e4, EXPO, block.timestamp);
        vm.prank(admin);
        vm.expectRevert(CH.InvalidParam.selector);
        ch.replaceMarketFeed(MON, newFeed, 5_001); // old feed dead (1 day): bound <= 50% (v4, R3-02)
        vm.prank(admin);
        ch.replaceMarketFeed(MON, newFeed, 500);
        (,, bytes32 feedNow,,,) = ch.getMarket(MON);
        assertEq(feedNow, newFeed);
        (uint256 p0, uint256 t0) = ch.lanePrice(3, MON);
        assertEq(p0 + t0, 0, "old feed's lane markers reset");

        // the account can withdraw and close both legs again
        vm.prank(a);
        ch.withdraw(1e6, _none());
        uint256 monClose = _commit(a, MON, -int256(ch.getPosition(a, MON).size), 0, 1);
        CH.Order memory o = ch.getOrder(monClose);
        vm.warp(o.execAfter + 1);
        _store(FEED_SOL, spot[FEED_SOL], block.timestamp);
        pyth.setStoredPrice(newFeed, 3.06e8, 3e4, EXPO, block.timestamp);
        vm.prank(keeper);
        ch.executeOrder(monClose, _upd1(newFeed, 3.06e8, o.execAfter, o.execAfter - 1));
        assertEq(uint8(ch.getOrder(monClose).status), uint8(CH.OrderStatus.Executed), "MON closed on the new feed");
        _closeAll(a, SOL);
        (,,, bytes32[] memory open,,) = ch.getAccount(a);
        assertEq(open.length, 0);
        uint256 free = ch.freeCollateral(a);
        vm.prank(a);
        ch.withdraw(free, _none());
        assertGt(ausd.balanceOf(a), 990e6, "funds recovered");
        assertSolvent();
    }
}
