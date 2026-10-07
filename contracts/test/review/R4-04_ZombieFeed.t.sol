// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R4-04 (Low): a "zombie" feed (still publishing, never usable) was classified live, so the
///        R3-02 widening never applied. **FLIPPED INTO A REGRESSION (v5).**
/// @notice FLIPPED 2026-10-07 after the v5 fix: a zombie feed now counts as dead and is recoverable.
///         Original finding (v4): `_feedIsDead` looked only at the stored publish time, so a feed that
///         keeps publishing with a confidence wider than `maxConfBps` (or a non-positive price)
///         froze every position in it while `replaceMarketFeed` stayed limited to 10%.
///         Fix (v5): a feed is also dead when its newest stored price fails `_check` (non-positive
///         price, bad exponent, confidence too wide). Pushing such a message cannot refute it; a
///         usable fresh message still does (by design). A lane with OI but no recorded price
///         (single-leg accounts never record one: fills are historical) is checked against the
///         zombie's stored price with its confidence ignored, else the market's newest marker in
///         any lane (found while flipping: without it the swap reverted `NoReferencePrice`).
contract R4_04_ZombieFeedTest is ReviewBase {
    address internal a;
    bytes32 internal newFeed = keccak256("MON/USD v2 feed");

    function setUp() public override {
        super.setUp();
        a = laneAddr(3, 1);
        fund(a, 1_000e6);
        _open(a, MON, true, 500e6, 50e6);
        _open(a, SOL, true, 500e6, 50e6); // lane 3 records MON = 3.00
        vm.warp(block.timestamp + 3 days);
        _store(FEED_SOL, spot[FEED_SOL], block.timestamp);
    }

    function _recoverAt(uint256 bps) internal {
        pyth.setStoredPrice(newFeed, 3.4e8, 3e4, EXPO, block.timestamp); // +13% vs the 3.00 marker
        vm.startPrank(admin); // = the timelock
        vm.expectRevert(CH.InvalidParam.selector);
        ch.replaceMarketFeed(MON, newFeed, 5_001); // the hard bound stays
        ch.replaceMarketFeed(MON, newFeed, bps);
        vm.stopPrank();
        (,, bytes32 feedNow,,,) = ch.getMarket(MON);
        assertEq(feedNow, newFeed);
        vm.prank(a);
        ch.withdraw(1e6, _none()); // unfrozen
        assertSolvent();
    }

    function test_R4_04_WideConfidenceZombieFeedIsDead_Recovered() public {
        // MON's feed keeps publishing, but always with a 5% confidence (maxConfBps = 2%)
        pyth.setStoredPrice(FEED_MON, 3.4e8, uint64(17_000_000), EXPO, block.timestamp);
        vm.prank(a);
        vm.expectPartialRevert(CH.PriceConfidenceTooWide.selector);
        ch.withdraw(1e6, _none());
        _recoverAt(1_500);
    }

    function test_R4_04b_NonPositivePriceZombieFeedIsDead_Recovered() public {
        pyth.setStoredPrice(FEED_MON, 0, 0, EXPO, block.timestamp - 1); // fresh, but price 0
        pyth.setStoredPrice(FEED_MON, -1, 0, EXPO, block.timestamp); // and then negative
        _recoverAt(1_500);
    }

    /// @notice A feed whose newest stored price is USABLE stays live (10% bound), even if a wide
    ///         print was published earlier.
    function test_R4_04c_UsableFeedStaysLive() public {
        pyth.setStoredPrice(FEED_MON, 3.4e8, uint64(17_000_000), EXPO, block.timestamp - 10);
        pyth.setStoredPrice(FEED_MON, 3.05e8, 3e4, EXPO, block.timestamp); // a good print now
        pyth.setStoredPrice(newFeed, 3.05e8, 3e4, EXPO, block.timestamp);
        vm.startPrank(admin);
        vm.expectRevert(CH.InvalidParam.selector);
        ch.replaceMarketFeed(MON, newFeed, 1_001);
        ch.replaceMarketFeed(MON, newFeed, 1_000);
        vm.stopPrank();
    }

    /// @notice A lane with OI but NO recorded price (a single-leg account: fills do not record one)
    ///         is checked against the zombie's last stored price, confidence ignored. Here no lane
    ///         recorded a BTC price at all, so there is no marker to fall back on either.
    function test_R4_04d_ZombieWithoutAnyMarker_UsesStoredPriceIgnoringConf() public {
        address b = laneAddr(4, 1);
        fund(b, 1_000e6);
        _store(FEED_BTC, spot[FEED_BTC], block.timestamp);
        _open(b, BTC, true, 500e6, 50e6); // lane 4: single leg, no BTC marker anywhere
        for (uint8 k; k < 8; ++k) {
            (uint256 m,) = ch.lanePrice(k, BTC);
            assertEq(m, 0, "no BTC marker in any lane");
        }
        int64 px = spot[FEED_BTC];
        pyth.setStoredPrice(FEED_BTC, px, uint64(uint256(int256(px)) / 20), EXPO, block.timestamp); // 5% conf
        bytes32 btc2 = keccak256("BTC/USD v2 feed");
        pyth.setStoredPrice(btc2, px, uint64(uint256(int256(px)) / 10_000), EXPO, block.timestamp);
        vm.prank(admin);
        ch.replaceMarketFeed(BTC, btc2, 500); // reference: the zombie's price, conf ignored
        (,, bytes32 feedNow,,,) = ch.getMarket(BTC);
        assertEq(feedNow, btc2);
    }

    /// @notice A non-positive zombie gives no stored reference: a lane without a marker is checked
    ///         against the market's newest marker in any lane instead.
    function test_R4_04e_NonPositiveZombieWithoutLaneMarker_UsesNewestMarker() public {
        address b = laneAddr(4, 1);
        fund(b, 1_000e6);
        _open(b, MON, true, 500e6, 50e6); // lane 4: no MON marker
        pyth.setStoredPrice(FEED_MON, -1, 0, EXPO, block.timestamp);
        pyth.setStoredPrice(newFeed, 4.6e8, 3e4, EXPO, block.timestamp); // +53% vs lane 3's 3.00
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(CH.FeedSwapDeviation.selector, uint8(3), 3e18, 4.6e18));
        ch.replaceMarketFeed(MON, newFeed, 5_000);
        vm.stopPrank();
        pyth.setStoredPrice(newFeed, 3.4e8, 3e4, EXPO, block.timestamp);
        vm.prank(admin);
        ch.replaceMarketFeed(MON, newFeed, 1_500); // lanes 3 and 4 both vs the 3.00 marker
        (,, bytes32 feedNow,,,) = ch.getMarket(MON);
        assertEq(feedNow, newFeed);
    }
}
