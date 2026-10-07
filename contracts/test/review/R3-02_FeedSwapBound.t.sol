// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R3-02 (Medium): the R2-02 recovery path closed for good once the market had moved > 10%.
///        **FLIPPED INTO A REGRESSION (v4).**
/// @notice FLIPPED 2026-10-07 after the v4 fix: a +13% move after the feed died is now recoverable.
///         Original finding (v3): `replaceMarketFeed` checked the new feed against the dead feed's
///         FROZEN reference with `maxDeviationBps` hard-capped at 10%; MON moving > 10% during
///         detection + 24 h timelock + signing made the deadlock permanent.
///         Fix (v4): while the old feed is LIVE the bound stays <= 10%
///         (`MAX_FEED_SWAP_DEVIATION_BPS`); once it is provably dead ON CHAIN (Pyth has no stored
///         price for it, or the stored one is older than `DEAD_FEED_AGE` = 1 h) the timelock may
///         pass up to 50% (`MAX_DEAD_FEED_SWAP_DEVIATION_BPS`). Anyone can refute a false "dead"
///         during the 24 h timelock delay by pushing a fresh update of the old feed to Pyth.
contract R3_02_FeedSwapBoundTest is ReviewBase {
    address internal a;
    bytes32 internal newFeed = keccak256("MON/USD v2 feed");

    function setUp() public override {
        super.setUp();
        a = laneAddr(3, 1);
        fund(a, 1_000e6);
        _open(a, MON, true, 500e6, 50e6);
        _open(a, SOL, true, 500e6, 50e6); // lane 3 records MON = 3.00
    }

    function test_R3_02_DeadFeedRecoversAfterThirteenPercentMove() public {
        assertEq(ch.MAX_FEED_SWAP_DEVIATION_BPS(), 1_000);
        assertEq(ch.MAX_DEAD_FEED_SWAP_DEVIATION_BPS(), 5_000);
        assertEq(ch.DEAD_FEED_AGE(), 1 hours);
        // MON's feed dies at 3.00. Three days later MON trades at 3.40 (+13%) on the new feed.
        vm.warp(block.timestamp + 3 days);
        _store(FEED_SOL, spot[FEED_SOL], block.timestamp);
        pyth.setStoredPrice(newFeed, 3.4e8, 3e4, EXPO, block.timestamp);
        (,, uint256 monT) = ch.latestPrice(MON);
        vm.prank(a);
        vm.expectRevert(abi.encodeWithSelector(CH.StalePrice.selector, MON, monT));
        ch.withdraw(1e6, _none());

        vm.startPrank(admin); // = the timelock in production, after its 24 h delay
        // the deviation check itself is intact: 10% does not cover +13%
        vm.expectRevert(abi.encodeWithSelector(CH.FeedSwapDeviation.selector, uint8(3), 3e18, 3.4e18));
        ch.replaceMarketFeed(MON, newFeed, 1_000);
        vm.expectRevert(CH.InvalidParam.selector);
        ch.replaceMarketFeed(MON, newFeed, 5_001); // hard bound 50% even for a dead feed
        ch.replaceMarketFeed(MON, newFeed, 1_500); // dead old feed: up to 50% allowed
        vm.stopPrank();
        (,, bytes32 feedNow,,,) = ch.getMarket(MON);
        assertEq(feedNow, newFeed);

        // the account is live again: withdraw, liquidation checks, close
        vm.prank(a);
        ch.withdraw(1e6, _none());
        assertEq(ch.startAuctions(3, _one(a), _none()), 0, "healthy at 3.40: nothing to liquidate");
        uint256 monClose = _commit(a, MON, -int256(ch.getPosition(a, MON).size), 0, 1);
        CH.Order memory o = ch.getOrder(monClose);
        vm.warp(o.execAfter + 1);
        _store(FEED_SOL, spot[FEED_SOL], block.timestamp);
        pyth.setStoredPrice(newFeed, 3.4e8, 3e4, EXPO, block.timestamp);
        vm.prank(keeper);
        ch.executeOrder(monClose, _upd1(newFeed, 3.4e8, o.execAfter, o.execAfter - 1));
        assertEq(uint8(ch.getOrder(monClose).status), uint8(CH.OrderStatus.Executed), "MON closed on the new feed");
        assertSolvent();
    }

    /// @notice A LIVE old feed keeps the 10% bound, up to and including exactly `DEAD_FEED_AGE`.
    function test_R3_02b_LiveFeedKeepsTenPercentBound() public {
        uint256 t0 = block.timestamp;
        _store(FEED_MON, spot[FEED_MON], t0); // the old feed's last stored update
        vm.warp(t0 + 1 hours); // exactly DEAD_FEED_AGE old: still counts as live
        _store(FEED_SOL, spot[FEED_SOL], block.timestamp);
        pyth.setStoredPrice(newFeed, 3.05e8, 3e4, EXPO, block.timestamp);
        vm.prank(admin);
        vm.expectRevert(CH.InvalidParam.selector);
        ch.replaceMarketFeed(MON, newFeed, 1_001);
        // someone pushes a fresh update of the old feed: it is live, whatever its age was
        vm.warp(t0 + 2 hours);
        _store(FEED_MON, spot[FEED_MON], block.timestamp);
        pyth.setStoredPrice(newFeed, 3.05e8, 3e4, EXPO, block.timestamp);
        vm.prank(admin);
        vm.expectRevert(CH.InvalidParam.selector);
        ch.replaceMarketFeed(MON, newFeed, 1_001);
        // one second past DEAD_FEED_AGE without a push: dead, the wider bound applies
        vm.warp(block.timestamp + 1 hours + 1);
        _store(FEED_SOL, spot[FEED_SOL], block.timestamp);
        pyth.setStoredPrice(newFeed, 3.05e8, 3e4, EXPO, block.timestamp);
        vm.prank(admin);
        ch.replaceMarketFeed(MON, newFeed, 1_001);
        (,, bytes32 feedNow,,,) = ch.getMarket(MON);
        assertEq(feedNow, newFeed);
    }

    /// @notice A feed Pyth has no stored price for at all counts as dead.
    function test_R3_02c_MissingOldFeedCountsAsDead() public {
        bytes32 ghostFeed = keccak256("GHOST/USD");
        pyth.setStoredPrice(ghostFeed, 3e8, 3e4, EXPO, block.timestamp);
        // list a market on a feed, then let Pyth lose it (mock: publishTime 0 = PriceFeedNotFound)
        vm.prank(admin);
        bytes32 newMkt = ch.listMarket("GHOST", ghostFeed, 100_000e6, 1_000_000e6, 100);
        pyth.setStoredPrice(ghostFeed, 0, 0, EXPO, 0);
        bytes32 repl = keccak256("GHOST v2");
        pyth.setStoredPrice(repl, 4.4e8, 3e4, EXPO, block.timestamp);
        vm.prank(admin);
        ch.replaceMarketFeed(newMkt, repl, 5_000); // no OI: only the parameter bound applies
        (,, bytes32 feedNow,,,) = ch.getMarket(newMkt);
        assertEq(feedNow, repl);
    }
}
