// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ProdTestBase} from "./ProdTestBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";
import {MockPyth} from "./mocks/MockPyth.sol";

/// @notice Pyth price handling: staleness, confidence, expo normalisation, non-positive
///         prices, newest-of(update, stored), malformed / out-of-range updates, listing checks.
contract ProdOracleTest is ProdTestBase {
    address internal alice = laneAddr(3, 1);

    function setUp() public override {
        super.setUp();
        fund(alice, 10_000e6);
        _open(alice, MON, true, 1_000e6, 100e6);
    }

    function _withdrawWith(bytes[] memory u) internal {
        vm.prank(alice);
        ch.withdraw(1e6, u);
    }

    // ------------------------------------------------------------------ staleness

    function test_StaleStoredPrice_Reverts_FreshUpdateWorks() public {
        vm.warp(block.timestamp + 16); // stored prices now 16 s old > maxStoredPriceAge 15 (R-01)
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CH.StalePrice.selector, MON, block.timestamp - 16));
        ch.withdraw(1e6, _none());
        vm.expectRevert(abi.encodeWithSelector(CH.StalePrice.selector, MON, block.timestamp - 16));
        ch.markPrice(MON);
        _withdrawWith(_updAll(block.timestamp - 1));
        assertSolvent();
    }

    function test_StalenessBoundaryIsInclusive() public {
        uint256 t0 = block.timestamp;
        uint256 snap = vm.snapshotState();
        vm.warp(t0 + 15); // exactly maxStoredPriceAge old: accepted
        assertEq(ch.markPrice(MON), 3e18);
        _withdrawWith(_none());
        vm.warp(t0 + 16);
        vm.expectRevert(abi.encodeWithSelector(CH.StalePrice.selector, MON, t0));
        ch.markPrice(MON);
        vm.revertToState(snap);
        // a supplied update may be up to maxPriceAge (30 s) old (newer than the stored push)
        vm.warp(t0 + 45);
        _withdrawWith(_updAll(block.timestamp - 30));
        vm.warp(block.timestamp + 1);
        bytes[] memory tooOld = _updAll(block.timestamp - 31);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CH.StalePrice.selector, MON, t0 + 15));
        ch.withdraw(1e6, tooOld); // falls back to the lane's last price (16 s old): stale
    }

    function test_UpdateOlderThanMaxAge_FallsBackToStored() public {
        vm.warp(block.timestamp + 100);
        // update published 31 s ago: out of [now − 30, now + 5] → Pyth reverts inside the try →
        // stored price (100 s old) is used → stale
        bytes[] memory u = _updAll(block.timestamp - 31);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CH.StalePrice.selector, MON, block.timestamp - 100));
        ch.withdraw(1e6, u);
    }

    function test_FuturePublishTime_WithinSkewAccepted_BeyondIgnored() public {
        vm.warp(block.timestamp + 100);
        _withdrawWith(_updAll(block.timestamp + 5)); // accepted (MAX_FUTURE_PUBLISH_SKEW = 5)
        vm.warp(block.timestamp + 100);
        bytes[] memory u = _updAll(block.timestamp + 6); // beyond skew → ignored → stored stale
        vm.prank(alice);
        vm.expectRevert();
        ch.withdraw(1e6, u);
    }

    // ------------------------------------------------------------------ confidence

    function test_Confidence_BoundaryAndTooWide() public {
        // maxConfBps = 200: conf/price = 2% exactly passes, 2% + 1 unit fails
        pyth.setStoredPrice(FEED_MON, 3e8, 6e6, -8, block.timestamp);
        assertEq(ch.markPrice(MON), 3e18);
        pyth.setStoredPrice(FEED_MON, 3e8, 6e6 + 1, -8, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(CH.PriceConfidenceTooWide.selector, MON, 6e6 + 1, 3e8));
        ch.markPrice(MON);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CH.PriceConfidenceTooWide.selector, MON, 6e6 + 1, 3e8));
        ch.withdraw(1e6, _none());
    }

    function test_WideConfidenceAtFill_RevertsExecution_OrderStaysPending() public {
        address bob = laneAddr(5, 2);
        fund(bob, 1_000e6);
        uint256 id = _commit(bob, MON, int256(_sizeFor(500e6, MON)), 50e6, type(uint128).max);
        CH.Order memory o = ch.getOrder(id);
        vm.warp(o.execAfter + 1);
        MockPyth.Msg[] memory msgs = new MockPyth.Msg[](1);
        msgs[0] = MockPyth.Msg(FEED_MON, 3e8, 1e7, -8, o.execAfter, o.execAfter - 1); // 3.3% conf
        bytes[] memory u = new bytes[](1);
        u[0] = abi.encode(PYTH_MAGIC, msgs);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CH.PriceConfidenceTooWide.selector, MON, 1e7, 3e8));
        ch.executeOrder(id, u);
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Pending));
    }

    // ------------------------------------------------------------------ price / expo

    function test_NonPositivePrice_Reverts() public {
        pyth.setStoredPrice(FEED_MON, 0, 0, -8, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(CH.InvalidPrice.selector, MON));
        ch.markPrice(MON);
        pyth.setStoredPrice(FEED_MON, -3e8, 0, -8, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(CH.InvalidPrice.selector, MON));
        ch.markPrice(MON);
        // a negative price inside an update: reverts (not silently ignored)
        vm.warp(block.timestamp + 100);
        MockPyth.Msg[] memory msgs = new MockPyth.Msg[](3);
        msgs[0] = MockPyth.Msg(FEED_MON, -1, 0, -8, uint64(block.timestamp), uint64(block.timestamp - 1));
        msgs[1] = MockPyth.Msg(FEED_SOL, 180e8, 1, -8, uint64(block.timestamp), uint64(block.timestamp - 1));
        msgs[2] = MockPyth.Msg(FEED_BTC, 100_000e8, 1, -8, uint64(block.timestamp), uint64(block.timestamp - 1));
        bytes[] memory u = new bytes[](1);
        u[0] = abi.encode(PYTH_MAGIC, msgs);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CH.InvalidPrice.selector, MON));
        ch.withdraw(1e6, u);
    }

    function test_ExpoNormalisation() public {
        // −8 (normal), −18, 0, +2, −30 all map to 1e18 fixed point
        pyth.setStoredPrice(FEED_MON, 3e8, 0, -8, block.timestamp);
        assertEq(ch.markPrice(MON), 3e18);
        pyth.setStoredPrice(FEED_MON, 3e18, 0, -18, block.timestamp);
        assertEq(ch.markPrice(MON), 3e18);
        pyth.setStoredPrice(FEED_MON, 3, 0, 0, block.timestamp);
        assertEq(ch.markPrice(MON), 3e18);
        pyth.setStoredPrice(FEED_MON, 3, 0, 2, block.timestamp);
        assertEq(ch.markPrice(MON), 300e18);
        pyth.setStoredPrice(FEED_MON, 3e18, 0, -30, block.timestamp);
        assertEq(ch.markPrice(MON), 3e6); // 3e-12 AUSD
        // floors to zero → invalid
        pyth.setStoredPrice(FEED_MON, 1, 0, -30, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(CH.InvalidPrice.selector, MON));
        ch.markPrice(MON);
        // out-of-range exponents
        pyth.setStoredPrice(FEED_MON, 3, 0, -31, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(CH.InvalidPriceExpo.selector, int32(-31)));
        ch.markPrice(MON);
        pyth.setStoredPrice(FEED_MON, 3, 0, 13, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(CH.InvalidPriceExpo.selector, int32(13)));
        ch.markPrice(MON);
        // too large for uint128 after scaling
        pyth.setStoredPrice(FEED_MON, type(int64).max, 0, 12, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(CH.InvalidPrice.selector, MON));
        ch.markPrice(MON);
    }

    function testFuzz_ExpoNormalisation(int64 price, int32 expo) public {
        price = int64(bound(price, 1, type(int64).max));
        expo = int32(bound(expo, -30, 12));
        pyth.setStoredPrice(FEED_MON, price, 0, expo, block.timestamp);
        int256 e = int256(expo) + 18;
        uint256 expected = e >= 0 ? uint256(int256(price)) * 10 ** uint256(e) : uint256(int256(price)) / 10 ** uint256(-e);
        if (expected == 0 || expected > type(uint128).max) {
            vm.expectRevert(abi.encodeWithSelector(CH.InvalidPrice.selector, MON));
            ch.markPrice(MON);
        } else {
            assertEq(ch.markPrice(MON), expected);
        }
    }

    // ------------------------------------------------------------------ newest wins / malformed

    function test_NewestOfUpdateAndStoredWins() public {
        address bob = laneAddr(3, 5);
        fund(bob, 1_000e6);
        // stored is newer (t) and at 3.00; an older update (t − 5) claims 6.00 → stored wins
        uint256 t = block.timestamp;
        MockPyth.Msg[] memory msgs = new MockPyth.Msg[](3);
        msgs[0] = MockPyth.Msg(FEED_MON, 6e8, 1, -8, uint64(t - 5), uint64(t - 6));
        msgs[1] = MockPyth.Msg(FEED_SOL, 180e8, 1, -8, uint64(t - 5), uint64(t - 6));
        msgs[2] = MockPyth.Msg(FEED_BTC, 100_000e8, 1, -8, uint64(t - 5), uint64(t - 6));
        bytes[] memory u = new bytes[](1);
        u[0] = abi.encode(PYTH_MAGIC, msgs);
        // alice's long would look hugely profitable at 6.00; at 3.00 her free collateral is ~9,899
        uint256 freeAtStored = ch.freeCollateral(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CH.InsufficientFreeCollateral.selector, freeAtStored + 1, freeAtStored));
        ch.withdraw(freeAtStored + 1, u);
        // a newer update wins over the stored price
        vm.warp(t + 1);
        msgs[0] = MockPyth.Msg(FEED_MON, 33e7, 1, -8, uint64(t + 1), uint64(t));
        u[0] = abi.encode(PYTH_MAGIC, msgs);
        vm.prank(alice);
        ch.withdraw(freeAtStored + 1, u); // +10% → more free collateral
    }

    function test_MalformedOrPartialUpdate_FallsBackToStored_NoFeeKept() public {
        pyth.setFees(5, 0);
        bytes[] memory bad = new bytes[](1);
        bad[0] = hex"deadbeef00";
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(); // getUpdateFee itself rejects the malformed blob
        ch.withdraw{value: 1 ether}(1e6, bad);
        // a blob without the touched market (alice holds MON; SOL-only blob): Pyth's parse
        // reverts (missing id) → stored prices used, fee refunded
        bytes[] memory other = _upd1(FEED_SOL, 180e8, block.timestamp, block.timestamp - 1);
        uint256 bal = alice.balance;
        vm.prank(alice);
        ch.withdraw{value: 1 ether}(1e6, other);
        assertEq(alice.balance, bal, "nothing spent when Pyth rejects the update");
        assertEq(address(pyth).balance, 0);
        // R-02: a PARTIAL blob carrying just the touched market is accepted (and charged)
        vm.warp(block.timestamp + 1);
        bytes[] memory monOnly = _upd1(FEED_MON, 3e8, block.timestamp, block.timestamp - 1);
        vm.prank(alice);
        ch.withdraw{value: 1 ether}(1e6, monOnly);
        assertEq(alice.balance, bal - 5, "one message x 5 wei");
        (, uint256 t) = ch.lanePrice(3, MON);
        assertEq(t, block.timestamp, "lane price advanced to the supplied update");
    }

    function test_NoPositions_WithdrawNeedsNoPrice() public {
        address bob = laneAddr(5, 9);
        fund(bob, 100e6);
        vm.warp(block.timestamp + 10_000); // everything stale
        vm.prank(bob);
        ch.withdraw(100e6, _none());
        assertEq(ausd.balanceOf(bob), 100e6);
    }

    // ------------------------------------------------------------------ listing

    function test_Listing_FeedChecks() public {
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(CH.FeedNotOnPyth.selector, bytes32(uint256(42))));
        ch.listMarket("ETH/AUSD", bytes32(uint256(42)), 1e6, 1e6, 100);
        vm.expectRevert(abi.encodeWithSelector(CH.FeedAlreadyUsed.selector, FEED_MON));
        ch.listMarket("ETH/AUSD", FEED_MON, 1e6, 1e6, 100);
        vm.expectRevert(abi.encodeWithSelector(CH.MarketAlreadyListed.selector, MON));
        ch.listMarket("MON/AUSD", FEED_MON, 1e6, 1e6, 100);
        vm.expectRevert(CH.InvalidParam.selector);
        ch.listMarket("ETH/AUSD", bytes32(uint256(43)), 0, 1e6, 100);
        vm.expectRevert(CH.InvalidParam.selector);
        ch.listMarket("ETH/AUSD", bytes32(uint256(43)), 1e6, 1e6, 10_001);
        vm.stopPrank();
    }

    function test_LatestPrice_RawForDisplay() public {
        vm.warp(block.timestamp + 1_000);
        (uint256 p, uint256 c, uint256 t) = ch.latestPrice(MON);
        assertEq(p, 3e18);
        assertEq(c, 3e14); // 1 bps conf
        assertEq(t, block.timestamp - 1_000);
    }
}
