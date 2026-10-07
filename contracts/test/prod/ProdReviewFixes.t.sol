// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {ProdTestBase} from "./ProdTestBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @notice Unit tests for the mechanisms added in response to the adversarial review
///         (contracts/REVIEW.md): per-lane monotonic prices, the in-lane loss waterfall and
///         haircut, delayed LP withdrawals, pool epochs, governance guards, dust registrations.
///         The PoC regressions themselves live in test/review/.
contract ProdReviewFixesTest is ProdTestBase {
    address internal alice = laneAddr(3, 1);
    address internal lp = makeAddr("lp");

    function setUp() public override {
        super.setUp();
        fund(alice, 5_000e6);
    }

    function _lp(uint8 lane, uint256 amount) internal returns (uint256 shares) {
        vm.prank(admin);
        ausd.ownerMint(lp, amount);
        vm.startPrank(lp);
        ausd.approve(address(ch), type(uint256).max);
        shares = ch.backstopDeposit(lane, amount, _none());
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ monotonic lane prices

    function test_LanePrice_NeverMovesBack_AndIsLaneLocal() public {
        _open(alice, MON, true, 1_000e6, 100e6);
        // a supplied update at T advances lane 3's MON price
        vm.warp(block.timestamp + 5);
        uint256 t = block.timestamp;
        _setSpot(FEED_MON, 3.1e8);
        bytes[] memory u = _updAll(t);
        vm.prank(alice);
        ch.withdraw(1e6, u);
        (uint256 p3, uint256 t3) = ch.lanePrice(3, MON);
        assertEq(p3, 3.1e18);
        assertEq(t3, t);
        // an older stored price is never used again in lane 3 ...
        pyth.setStoredPrice(FEED_MON, 2.5e8, 1, EXPO, t - 1);
        assertEq(ch.markPriceInLane(3, MON), 3.1e18, "lane 3 keeps its newer price");
        // ... but lane 5 has never used a price, so it reads storage
        assertEq(ch.markPriceInLane(5, MON), 2.5e18, "other lanes are independent");
        (, uint256 t5) = ch.lanePrice(5, MON);
        assertEq(t5, 0);
        // the lane price expires like a stored push (15 s)
        vm.warp(t + 16);
        vm.expectRevert(abi.encodeWithSelector(CH.StalePrice.selector, MON, t));
        ch.markPriceInLane(3, MON);
        // an equal-time newer source wins over the lane memory (ties prefer fresh data)
        vm.warp(t + 1);
        pyth.setStoredPrice(FEED_MON, 3.2e8, 1, EXPO, t + 1);
        assertEq(ch.markPriceInLane(3, MON), 3.2e18);
    }

    function test_LanePrice_FillPriceIsHistorical_DoesNotAdvanceLane() public {
        uint256 id = _commit(alice, MON, int256(_sizeFor(1_000e6, MON)), 100e6, type(uint128).max);
        _execute(id);
        (, uint256 t) = ch.lanePrice(3, MON);
        assertEq(t, 0, "the unique fill price is not recorded as the lane's price");
    }

    // ------------------------------------------------------------------ loss waterfall / haircut

    function test_Waterfall_InsuranceThenPoolThenBadDebt_HaircutRetiresDebt() public {
        // lane 6: 100k insurance (fixture) + a 500 AUSD pool; one big winner exceeds both
        vm.prank(admin);
        ch.setCaps(1_000_000e6, 100_000_000e6, 100_000); // OI cap = 10 x insurance = 1M
        _lp(6, 500e6);
        address y = laneAddr(6, 2);
        fund(y, 100_000e6);
        _open(y, BTC, true, 800_000e6, 80_000e6);
        _setSpot(FEED_BTC, 115_000e8); // +15% => +120k > 100k insurance + 500 pool cash
        vm.recordLogs();
        _closeAll(y, BTC);
        bool absorbed;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == CH.BackstopLossAbsorbed.selector) {
                absorbed = abi.decode(logs[i].data, (uint256)) == 500e6;
            }
        }
        assertTrue(absorbed, "BackstopLossAbsorbed(6, 500)");
        (uint256 ins, uint256 debt,,,) = ch.getLane(6);
        (,, int256 cash,,,,) = ch.laneLedger(6);
        assertEq(ins, 0, "insurance first");
        assertEq(cash, 0, "then the lane's pool cash");
        assertGt(debt, 15_000e6, "then bad debt");
        (uint256 held, int256 claims, int256 surplus,,, uint256 haircutBps) = ch.laneSolvency(6);
        assertEq(surplus, -int256(debt));
        assertEq(claims, int256(held + debt));
        assertGt(haircutBps, 0);
        // the winner is paid pro rata from lane 6's AUSD only; the haircut retires the debt
        uint256 free = ch.freeCollateral(y);
        uint256 preview = ch.previewWithdraw(y, free);
        assertEq(preview, (free * held) / (held + debt));
        vm.prank(y);
        ch.withdraw(free, _none());
        assertEq(ausd.balanceOf(y), preview);
        (, uint256 debtAfter,,,) = ch.getLane(6);
        assertEq(debtAfter, debt - (free - preview), "haircut retired its share of the debt");
        // other lanes are untouched and fully withdrawable
        vm.prank(alice);
        ch.withdraw(5_000e6, _none());
        assertEq(ausd.balanceOf(alice), 5_000e6);
        assertSolvent();
    }

    // ------------------------------------------------------------------ delayed LP withdrawals

    function test_BackstopWithdraw_RequestWindowAndCancel() public {
        uint256 shares = _lp(5, 1_000e6);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(CH.InsufficientShares.selector, shares + 1, shares));
        ch.backstopRequestWithdraw(5, shares + 1);
        vm.prank(lp);
        ch.backstopRequestWithdraw(5, shares);
        (uint256 req, uint256 readyAt, uint256 expiresAt) = ch.backstopWithdrawRequest(5, lp);
        assertEq(req, shares);
        assertEq(readyAt, block.timestamp + 1 hours);
        assertEq(expiresAt, readyAt + 1 hours, "v3: 1 h window (R2-04)");
        // cancel with 0
        vm.prank(lp);
        ch.backstopRequestWithdraw(5, 0);
        vm.warp(readyAt);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(CH.NoWithdrawRequest.selector, uint8(5), lp));
        ch.backstopWithdraw(5, 1, _none());
        // expiry after the 1 h window
        vm.prank(lp);
        ch.backstopRequestWithdraw(5, shares);
        vm.warp(block.timestamp + 1 hours + 1 hours + 1);
        _refreshStored();
        vm.prank(lp);
        vm.expectRevert();
        ch.backstopWithdraw(5, shares, _none());
        // single use: a partial withdrawal consumes the whole request (R2-04)
        _requestAndWait(lp, 5, shares);
        vm.prank(lp);
        ch.backstopWithdraw(5, shares / 2, _none());
        (req,,) = ch.backstopWithdrawRequest(5, lp);
        assertEq(req, 0, "request consumed");
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(CH.NoWithdrawRequest.selector, uint8(5), lp));
        ch.backstopWithdraw(5, 1, _none());
        assertSolvent();
    }

    // ------------------------------------------------------------------ governance / misc guards

    function test_SetMarketConfig_FeedFrozenWhileOpenInterest() public {
        _open(alice, MON, true, 1_000e6, 100e6);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(CH.MarketHasOpenInterest.selector, MON));
        ch.setMarketConfig(MON, bytes32(uint256(1)), 1, 1, 1);
        // other parameters may change
        vm.prank(admin);
        ch.setMarketConfig(MON, FEED_MON, 50_000e6, 5_000_000e6, 50);
    }

    function test_FirstDepositMinimum() public {
        address d = laneAddr(4, 77);
        vm.prank(admin);
        ausd.ownerMint(d, 10e6);
        vm.startPrank(d);
        ausd.approve(address(ch), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(CH.DepositTooSmall.selector, 1e6 - 1, 1e6));
        ch.deposit(1e6 - 1);
        ch.deposit(1e6);
        ch.deposit(1); // registered: any amount
        vm.stopPrank();
    }

    /// @notice R2-05 (v3): cure at maintenance (no buffer), never in the start block.
    function test_CureAtMaintenance_NotInStartBlock() public {
        address v = laneAddr(5, 3);
        fund(v, 100e6);
        _open(v, MON, true, 1_900e6, 95e6);
        _setSpot(FEED_MON, 2.88e8);
        ch.startAuctions(5, _oneAcct(v), _none());
        (int256 e, uint256 mm,,) = ch.accountHealth(v);
        uint256 topUp = uint256(int256(mm) - e); // equity exactly at MM after the top-up
        vm.prank(admin);
        ausd.ownerMint(v, topUp);
        vm.startPrank(v);
        ausd.approve(address(ch), type(uint256).max);
        ch.deposit(topUp);
        vm.stopPrank();
        assertFalse(ch.isLiquidatable(v));
        assertFalse(ch.cancelAuction(v, _none()), "not in the start block");
        vm.roll(block.number + 1);
        assertTrue(ch.cancelAuction(v, _none()), "cured exactly at maintenance");
    }

    /// @notice R2-05 (v3): an in-auction reduce must leave the account at/above maintenance at the
    ///         fill price AND at the order market's current price (no exit at a stale, better price).
    function test_InAuctionReduce_CheckedAtFillAndCurrentPrice() public {
        address v = laneAddr(5, 4);
        fund(v, 100e6);
        _open(v, MON, true, 1_900e6, 95e6);
        _setSpot(FEED_MON, 2.88e8);
        ch.startAuctions(5, _oneAcct(v), _none());
        uint256 size = ch.getPosition(v, MON).size;
        uint256 id = _commit(v, MON, -int256((size * 3) / 4), 0, 1); // OK at 2.88 (see R2-05b)
        CH.Order memory o = ch.getOrder(id);
        vm.warp(o.execAfter + 1);
        // the market falls to 2.70 after execAfter: at the current price the remaining quarter
        // leaves equity below maintenance
        _setSpot(FEED_MON, 2.7e8);
        bytes[] memory u = new bytes[](2);
        u[0] = _upd1(FEED_MON, 2.7e8, block.timestamp, block.timestamp - 1)[0]; // current
        u[1] = _upd1(FEED_MON, 2.88e8, o.execAfter, o.execAfter - 1)[0]; // the unique fill at 2.88
        vm.prank(keeper);
        ch.executeOrder(id, u);
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Failed), "below MM at the current price");
        (bool on,,) = ch.auctionOf(v);
        assertTrue(on, "auction continues");
        assertEq(ch.getPosition(v, MON).size, size, "nothing sold at the stale price");
    }

    function _oneAcct(address a) internal pure returns (address[] memory l) {
        l = new address[](1);
        l[0] = a;
    }
}
