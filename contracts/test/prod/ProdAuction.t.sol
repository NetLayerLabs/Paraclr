// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ProdTestBase} from "./ProdTestBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @notice Fair-liquidation path ported from the demo, with verified Pyth prices: start, pool
///         take, external take (payment capped at trader equity), cure, expiry; backstop pool
///         deposit / withdraw / reduce with NAV, margin guard and roles.
contract ProdAuctionTest is ProdTestBase {
    address internal lp = makeAddr("lp");
    uint8 internal constant L = 5;

    function setUp() public override {
        super.setUp();
        vm.prank(admin);
        ausd.ownerMint(lp, 1_000_000e6);
        vm.prank(lp);
        ausd.approve(address(ch), type(uint256).max);
        vm.prank(lp);
        ch.backstopDeposit(L, 50_000e6, _none());
    }

    /// @dev An account in lane L with 100 collateral and a 19x MON long (1,900 notional).
    function _victim(uint256 salt) internal returns (address v) {
        v = laneAddr(L, salt);
        fund(v, 100e6);
        _open(v, MON, true, 1_900e6, 95e6);
    }

    function _one(address a) internal pure returns (address[] memory l) {
        l = new address[](1);
        l[0] = a;
    }

    function test_StartAuctions_SkipsHealthy_RevertsOutOfLane() public {
        address v = _victim(1);
        address healthy = laneAddr(L, 2);
        fund(healthy, 1_000e6);
        _open(healthy, MON, true, 1_000e6, 100e6);
        _setSpot(FEED_MON, 2.88e8); // −4%: v under maintenance, healthy not
        address[] memory l = new address[](2);
        l[0] = v;
        l[1] = healthy;
        assertEq(ch.startAuctions(L, l, _none()), 1);
        (bool a1,,) = ch.auctionOf(v);
        (bool a2,,) = ch.auctionOf(healthy);
        assertTrue(a1);
        assertFalse(a2);
        assertEq(ch.freeCollateral(v), 0, "frozen");
        address out = laneAddr(2, 3);
        vm.expectRevert(abi.encodeWithSelector(CH.AccountNotInLane.selector, out, L));
        ch.startAuctions(L, _one(out), _none());
        // frozen: no withdraw, no new orders
        vm.prank(v);
        vm.expectRevert(abi.encodeWithSelector(CH.AccountInAuction.selector, v));
        ch.withdraw(1, _none());
        vm.prank(v);
        vm.expectRevert(abi.encodeWithSelector(CH.AccountInAuction.selector, v));
        ch.commitOrder{value: EXEC_FEE}(SOL, 1e18, 10e6, type(uint128).max);
    }

    function test_BackstopTake_TraderKeepsEquityMinusDiscount() public {
        address v = _victim(1);
        _setSpot(FEED_MON, 2.88e8);
        ch.startAuctions(L, _one(v), _none());
        (int256 e0,,, uint256 n0) = ch.accountHealth(v);
        vm.roll(block.number + 2);
        assertEq(ch.backstopTakeBatch(L, _one(v), _none()), 0, "below the pool threshold (75 bps)");
        vm.roll(block.number + 1);
        (int256 e,,, uint256 n) = ch.accountHealth(v);
        assertEq(e, e0);
        assertEq(n, n0);
        uint256 p = (n * 75) / 10_000;
        assertEq(ch.backstopTakeBatch(L, _one(v), _none()), 1);
        int256 expected = e > int256(p) ? e - int256(p) : int256(0);
        assertEq(collateralOf(v), expected, "trader keeps max(0, E - P)");
        (,,, bytes32[] memory open,,) = ch.getAccount(v);
        assertEq(open.length, 0);
        (bytes32[] memory pm, int256[] memory sz,) = ch.backstopPositions(L);
        assertEq(pm.length, 1);
        assertGt(sz[0], 0, "pool inherited the long");
        assertSolvent();
    }

    function test_ExternalTake_PaymentCappedAtEquity_SameLaneOnly() public {
        address v = _victim(1);
        address taker = laneAddr(L, 7);
        fund(taker, 5_000e6);
        address outsider = laneAddr(2, 7);
        fund(outsider, 5_000e6);
        _setSpot(FEED_MON, 2.88e8);
        ch.startAuctions(L, _one(v), _none());
        vm.roll(block.number + 10);
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(CH.AccountNotInLane.selector, outsider, L));
        ch.take(v, _none());
        (int256 e,,, uint256 n) = ch.accountHealth(v);
        uint256 p = (n * 250) / 10_000;
        int256 takerBefore = collateralOf(taker);
        vm.prank(taker);
        uint256 paid = ch.take(v, _none());
        uint256 cap = e <= 0 ? 0 : (uint256(e) < p ? uint256(e) : p);
        assertEq(paid, cap, "min(P, max(E, 0))");
        assertEq(collateralOf(taker) - takerBefore, int256(paid));
        CH.Position memory tp = ch.getPosition(taker, MON);
        assertTrue(tp.isLong);
        assertEq(tp.entryPrice, 2.88e18, "taker enters at mark");
        assertSolvent();
    }

    function test_ExternalTake_SelfTakeAndUnregisteredRejected() public {
        address v = _victim(1);
        _setSpot(FEED_MON, 2.88e8);
        ch.startAuctions(L, _one(v), _none());
        vm.prank(v);
        vm.expectRevert(CH.SelfTake.selector);
        ch.take(v, _none());
        address nobody = laneAddr(L, 99);
        vm.prank(nobody);
        vm.expectRevert(abi.encodeWithSelector(CH.NotRegistered.selector, nobody));
        ch.take(v, _none());
    }

    function test_Cure_ByTopUpEvenWhilePaused() public {
        address v = _victim(1);
        _setSpot(FEED_MON, 2.88e8);
        ch.startAuctions(L, _one(v), _none());
        vm.prank(guardian);
        ch.pause();
        vm.roll(block.number + 1); // never curable in the auction's start block
        assertFalse(ch.cancelAuction(v, _none()), "still underwater");
        vm.prank(admin);
        ausd.ownerMint(v, 100e6);
        vm.startPrank(v);
        ausd.approve(address(ch), type(uint256).max);
        ch.deposit(100e6); // allowed: holds positions
        vm.stopPrank();
        assertTrue(ch.cancelAuction(v, _none()));
        (bool active,,) = ch.auctionOf(v);
        assertFalse(active);
    }

    function test_Expire_AtMaxDiscount_PenaltyHalfToCaller() public {
        // empty the pool so nobody takes
        _lpWithdraw(lp, L, ch.backstopSharesOf(L, lp));
        address v = _victim(1);
        _setSpot(FEED_MON, 2.88e8);
        ch.startAuctions(L, _one(v), _none());
        vm.roll(block.number + 19);
        _refreshStored();
        assertEq(ch.expireBatch(L, _one(v), _none()), 0, "not yet at max");
        vm.roll(block.number + 1);
        (int256 e,,, uint256 n) = ch.accountHealth(v);
        address k = makeAddr("sweeper");
        vm.prank(k);
        assertEq(ch.expireBatch(L, _one(v), _none()), 1);
        uint256 penalty = (n * 100) / 10_000;
        if (e > 0 && penalty > uint256(e)) penalty = uint256(e);
        assertEq(ch.keeperRewards(k), (penalty * 5_000) / 10_000);
        vm.prank(k);
        ch.claimKeeperRewards();
        assertSolvent();
    }

    function test_BackstopPool_DepositWithdrawReduce_Roles() public {
        address v = _victim(1);
        _setSpot(FEED_MON, 2.88e8);
        ch.startAuctions(L, _one(v), _none());
        vm.roll(block.number + 3);
        ch.backstopTakeBatch(L, _one(v), _none());
        (bytes32[] memory pm, int256[] memory sz,) = ch.backstopPositions(L);
        vm.prank(keeper);
        vm.expectRevert(CH.Unauthorized.selector);
        ch.backstopReduce(L, pm[0], uint256(sz[0]), _none());
        vm.prank(admin);
        ch.setBackstopOperator(keeper, L, true);
        // operators are per lane (review I-7): the lane-L key cannot act on another lane's pool
        vm.prank(keeper);
        vm.expectRevert(CH.Unauthorized.selector);
        ch.backstopReduce(L - 1, pm[0], 1, _none());
        vm.prank(keeper);
        ch.backstopReduce(L, pm[0], uint256(sz[0]) * 2, _none()); // capped at the exposure
        (pm,,) = ch.backstopPositions(L);
        assertEq(pm.length, 0);
        // second LP enters at NAV
        address lp2 = makeAddr("lp2");
        vm.prank(admin);
        ausd.ownerMint(lp2, 1_000e6);
        vm.startPrank(lp2);
        ausd.approve(address(ch), type(uint256).max);
        vm.expectRevert(CH.ZeroAmount.selector);
        ch.backstopDeposit(L, 1e6 - 1, _none());
        uint256 s2 = ch.backstopDeposit(L, 1_000e6, _none());
        vm.stopPrank();
        (int256 eq,,, uint256 supply) = ch.backstopNav(L);
        assertEq(s2, (1_000e6 * (supply - s2)) / uint256(eq - 1_000e6));
        uint256 out = _lpWithdraw(lp2, L, s2);
        assertLe(out, 1_000e6, "no free value from rounding");
        assertSolvent();
    }

    function test_BackstopFunding_PoolPaysWhenLongSkewed() public {
        address v = _victim(1);
        _setSpot(FEED_MON, 2.88e8);
        ch.startAuctions(L, _one(v), _none());
        vm.roll(block.number + 3);
        ch.backstopTakeBatch(L, _one(v), _none());
        vm.warp(block.timestamp + 61);
        _refreshStored();
        ch.updateFunding(MON);
        (int256 navBefore,,,) = ch.backstopNav(L);
        vm.warp(block.timestamp + 1 days);
        _refreshStored();
        (int256 navAfter,,,) = ch.backstopNav(L);
        assertLt(navAfter, navBefore, "pool long pays funding under long skew");
        (bytes32[] memory pm, int256[] memory sz,) = ch.backstopPositions(L);
        vm.prank(admin);
        ch.backstopReduce(L, pm[0], uint256(sz[0]), _none());
        (int256 navFlat, int256 cash,,) = ch.backstopNav(L);
        assertEq(navFlat, cash);
        assertEq(navFlat, navAfter, "reduce at the same mark realizes exactly the NAV");
        assertSolvent();
    }
}
