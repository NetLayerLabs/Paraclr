// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ProdTestBase} from "./ProdTestBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";
import {PythErrors} from "@pythnetwork/pyth-sdk-solidity/PythErrors.sol";
import {MockPyth} from "./mocks/MockPyth.sol";

/// @notice Delayed orders: commit → execute at the first Pyth update at/after commit +
///         minExecDelay, within maxExecDelay; cancel only after the deadline; fills, fees,
///         escrow, failure handling.
contract ProdOrdersTest is ProdTestBase {
    address internal alice = laneAddr(3, 1);
    address internal bob = laneAddr(5, 2);

    function setUp() public override {
        super.setUp();
        fund(alice, 10_000e6);
        fund(bob, 10_000e6);
    }

    // ------------------------------------------------------------------ commit

    function test_Commit_EscrowsMarginAndFee() public {
        uint256 bal = address(ch).balance;
        uint256 id = _commit(alice, MON, int256(_sizeFor(1_000e6, MON)), 100e6, type(uint128).max);
        assertEq(id >> 96, uint256(uint160(alice)), "orderId encodes account");
        assertEq(id & type(uint96).max, 1, "nonce 1");
        CH.Order memory o = ch.getOrder(id);
        assertEq(o.account, alice);
        assertEq(uint8(o.status), uint8(CH.OrderStatus.Pending));
        assertEq(o.execAfter, block.timestamp + ch.minExecDelay());
        assertEq(ch.minExecDelay(), 3, "default 3 s (review I-4)");
        assertFalse(o.reduceOnly);
        assertEq(o.positionId, 0, "applies to a new position");
        assertEq(o.deadline, block.timestamp + 60);
        assertEq(o.executionFee, EXEC_FEE);
        (,,,, uint256 reserved,) = ch.getAccount(alice);
        assertEq(reserved, 100e6);
        assertEq(address(ch).balance, bal + EXEC_FEE);
        assertEq(ch.pendingOrderOf(alice, MON), id);
        // reserved margin is not withdrawable
        assertEq(ch.freeCollateral(alice), 9_900e6);
        assertSolvent();
    }

    function test_Commit_Validation() public {
        int256 sz = int256(_sizeFor(1_000e6, MON));
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(CH.ExecutionFeeTooLow.selector, EXEC_FEE - 1, EXEC_FEE));
        ch.commitOrder{value: EXEC_FEE - 1}(MON, sz, 100e6, 1);
        vm.expectRevert(CH.ZeroAmount.selector);
        ch.commitOrder{value: EXEC_FEE}(MON, 0, 100e6, 1);
        vm.expectRevert(CH.InvalidAcceptablePrice.selector);
        ch.commitOrder{value: EXEC_FEE}(MON, sz, 100e6, 0);
        vm.expectRevert(abi.encodeWithSelector(CH.MarketNotListed.selector, bytes32(uint256(1))));
        ch.commitOrder{value: EXEC_FEE}(bytes32(uint256(1)), sz, 100e6, 1);
        // escrow check: margin beyond collateral
        vm.expectRevert(abi.encodeWithSelector(CH.InsufficientCollateral.selector, 10_001e6, int256(10_000e6)));
        ch.commitOrder{value: EXEC_FEE}(MON, sz, 10_001e6, type(uint128).max);
        uint256 id = ch.commitOrder{value: EXEC_FEE}(MON, sz, 100e6, type(uint128).max);
        vm.expectRevert(abi.encodeWithSelector(CH.OrderAlreadyPending.selector, id));
        ch.commitOrder{value: EXEC_FEE}(MON, sz, 100e6, type(uint128).max);
        vm.stopPrank();

        address stranger = laneAddr(1, 77);
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CH.NotRegistered.selector, stranger));
        ch.commitOrder{value: EXEC_FEE}(MON, sz, 0, 1);
    }

    function test_Commit_ReduceRules() public {
        _open(alice, MON, true, 1_000e6, 100e6);
        CH.Position memory p = ch.getPosition(alice, MON);
        vm.startPrank(alice);
        vm.expectRevert(CH.MarginOnReduce.selector);
        ch.commitOrder{value: EXEC_FEE}(MON, -int256(p.size / 2), 1, 1);
        vm.expectRevert(CH.OrderWouldFlip.selector);
        ch.commitOrder{value: EXEC_FEE}(MON, -int256(p.size + 1), 0, 1);
        ch.commitOrder{value: EXEC_FEE}(MON, -int256(p.size), 0, 1); // exact close is fine
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ execute: timing

    function test_Execute_UsesFirstUpdateAtOrAfterCommitPlusDelay() public {
        uint256 id = _commit(alice, MON, int256(_sizeFor(1_000e6, MON)), 100e6, type(uint128).max);
        CH.Order memory o = ch.getOrder(id);
        vm.warp(o.execAfter + 5);
        // A later update (the keeper would like to pick it) is not the first one after execAfter:
        // its previous publish time is >= execAfter → Pyth rejects it under uniqueness.
        bytes[] memory later = _upd1(FEED_MON, 2e8, o.execAfter + 3, o.execAfter + 2);
        vm.prank(keeper);
        vm.expectRevert(PythErrors.PriceFeedNotFoundWithinRange.selector);
        ch.executeOrder(id, later);
        // An update published before execAfter is out of range.
        bytes[] memory early = _upd1(FEED_MON, 2e8, o.execAfter - 1, o.execAfter - 2);
        vm.prank(keeper);
        vm.expectRevert(PythErrors.PriceFeedNotFoundWithinRange.selector);
        ch.executeOrder(id, early);
        // The first update at/after execAfter fills, at its price.
        bytes[] memory first = _upd1(FEED_MON, 31e7, o.execAfter, o.execAfter - 1);
        vm.prank(keeper);
        ch.executeOrder(id, first);
        CH.Position memory p = ch.getPosition(alice, MON);
        assertEq(p.entryPrice, 3.1e18, "filled at the unique update's price");
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Executed));
        // the publish time may also be later than execAfter if Pyth had no update in between
        uint256 id2 = _commit(bob, MON, int256(_sizeFor(1_000e6, MON)), 100e6, type(uint128).max);
        o = ch.getOrder(id2);
        vm.warp(o.execAfter + 10);
        vm.prank(keeper);
        ch.executeOrder(id2, _upd1(FEED_MON, 29e7, o.execAfter + 7, o.execAfter - 1));
        assertEq(ch.getPosition(bob, MON).entryPrice, 2.9e18);
        assertSolvent();
    }

    function test_Execute_TooEarlyAndTooLate() public {
        uint256 id = _commit(alice, MON, int256(_sizeFor(1_000e6, MON)), 100e6, type(uint128).max);
        CH.Order memory o = ch.getOrder(id);
        vm.warp(o.execAfter - 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CH.OrderNotReady.selector, id, o.execAfter));
        ch.executeOrder(id, _updAll(o.execAfter));
        vm.warp(o.deadline + 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CH.OrderExpired.selector, id, o.deadline));
        ch.executeOrder(id, _updAll(o.execAfter));
        // an update after the deadline is out of the window even if the block is in time
        uint256 id2 = _commit(bob, MON, int256(_sizeFor(1_000e6, MON)), 100e6, type(uint128).max);
        o = ch.getOrder(id2);
        vm.warp(o.deadline);
        vm.prank(keeper);
        vm.expectRevert(PythErrors.PriceFeedNotFoundWithinRange.selector);
        ch.executeOrder(id2, _upd1(FEED_MON, 3e8, o.deadline + 1, o.execAfter - 1));
    }

    function test_Execute_ReplayAndDoubleExecution() public {
        uint256 id = _commit(alice, MON, int256(_sizeFor(1_000e6, MON)), 100e6, type(uint128).max);
        _execute(id);
        CH.Order memory o = ch.getOrder(id);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CH.OrderNotPending.selector, id));
        ch.executeOrder(id, _updAll(o.execAfter));
        vm.expectRevert(abi.encodeWithSelector(CH.OrderNotPending.selector, id));
        ch.cancelOrder(id);
        // unknown order id
        vm.expectRevert(abi.encodeWithSelector(CH.OrderNotPending.selector, 12345));
        ch.executeOrder(12345, _none());
    }

    function test_Execute_PaysExecutorByCredit() public {
        uint256 id = _commit(alice, MON, int256(_sizeFor(1_000e6, MON)), 100e6, type(uint128).max);
        uint256 balBefore = address(ch).balance;
        _execute(id);
        assertEq(address(ch).balance, balBefore, "no native transfer on the hot path");
        assertEq(ch.executionFeesOwed(keeper), EXEC_FEE);
        uint256 kb = keeper.balance;
        vm.prank(keeper);
        assertEq(ch.claimExecutionFees(), EXEC_FEE);
        assertEq(keeper.balance, kb + EXEC_FEE);
        assertEq(ch.executionFeesOwed(keeper), 0);
        vm.prank(keeper);
        vm.expectRevert(CH.ZeroAmount.selector);
        ch.claimExecutionFees();
        assertSolvent();
    }

    // ------------------------------------------------------------------ cancel

    function test_Cancel_OnlyAfterDeadline_RefundsAccount() public {
        uint256 id = _commit(alice, MON, int256(_sizeFor(1_000e6, MON)), 100e6, type(uint128).max);
        CH.Order memory o = ch.getOrder(id);
        vm.warp(o.deadline);
        vm.expectRevert(abi.encodeWithSelector(CH.OrderNotExpired.selector, id, o.deadline));
        vm.prank(alice);
        ch.cancelOrder(id);
        vm.warp(o.deadline + 1);
        uint256 ab = alice.balance;
        vm.prank(bob); // anyone may clean up; the refund goes to the account
        ch.cancelOrder(id);
        assertEq(alice.balance, ab + EXEC_FEE);
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Cancelled));
        (,,,, uint256 reserved,) = ch.getAccount(alice);
        assertEq(reserved, 0);
        assertEq(ch.pendingOrderOf(alice, MON), 0);
        assertEq(ch.freeCollateral(alice), 10_000e6);
        assertSolvent();
    }

    function test_Cancel_RefundToRejectingContractIsCredited() public {
        RejectingTrader t = new RejectingTrader();
        address who = address(t);
        // put the rejecting contract in a known lane is unnecessary: any lane works
        vm.prank(admin);
        ausd.ownerMint(who, 1_000e6);
        vm.deal(who, 1 ether);
        t.depositAndCommit(ch, MockAUSDLike(address(ausd)), MON, int256(_sizeFor(100e6, MON)), 10e6, EXEC_FEE);
        uint256 id = ch.pendingOrderOf(who, MON);
        vm.warp(ch.getOrder(id).deadline + 1);
        ch.cancelOrder(id);
        assertEq(ch.executionFeesOwed(who), EXEC_FEE, "credited, claimable");
        assertSolvent();
    }

    // ------------------------------------------------------------------ fills

    function test_Fill_IncreaseReduceClose_Math() public {
        // open 1,000 notional long at 3.00 with 100 margin (10x)
        _open(alice, MON, true, 1_000e6, 100e6);
        CH.Position memory p = ch.getPosition(alice, MON);
        assertEq(p.entryPrice, 3e18);
        assertEq(p.entryNotional, 1_000e6 - 1, "floor of size*price (size rounded down)");
        // the trading fee (5 bps of notional, rounded up = 0.5) is paid out of the order's margin
        assertEq(p.margin, 100e6 - 500_000, "margin net of the fee (R-06)");
        assertEq(p.id, 1, "first position id");
        // trading fee: 5 bps of notional, rounded up
        assertEq(collateralOf(alice), int256(10_000e6) - 500_000);
        // price to 3.30 → increase by 1,000 notional at 3.30 → weighted entry
        _setSpot(FEED_MON, 33e7);
        _open(alice, MON, true, 1_000e6, 100e6);
        p = ch.getPosition(alice, MON);
        uint256 s1 = _sizeForPx(1_000e6, 3e18);
        uint256 s2 = _sizeForPx(1_000e6, 3.3e18);
        assertEq(p.size, s1 + s2);
        uint256 num = s1 * 3e18 + s2 * 3.3e18;
        assertEq(p.entryPrice, (num - 1) / (s1 + s2) + 1, "long entry rounded up");
        uint256 fee2 = (((s2 * 3.3e18) / 1e30) * 5 + 9_999) / 10_000;
        assertEq(p.margin, 200e6 - 500_000 - fee2, "both fees paid from margin");
        assertEq(p.id, 1, "increase keeps the position id");
        // reduce half at 3.60: realized = half × (3.60 − entry), floored
        _setSpot(FEED_MON, 36e7);
        int256 before = collateralOf(alice);
        uint256 half = p.size / 2;
        uint256 id = _commit(alice, MON, -int256(half), 0, 1);
        _execute(id);
        CH.Position memory q = ch.getPosition(alice, MON);
        assertEq(q.size, p.size - half);
        assertEq(q.margin, (p.margin * q.size + p.size - 1) / p.size, "margin kept rounded up");
        int256 pnl = int256(half) * (int256(3.6e18) - int256(p.entryPrice)) / 1e30;
        uint256 fee = ((half * 3.6e18 / 1e30) * 5 + 9_999) / 10_000;
        assertEq(collateralOf(alice), before + pnl - int256(fee));
        // close the rest
        _closeAll(alice, MON);
        assertEq(ch.getPosition(alice, MON).size, 0);
        (,,, bytes32[] memory open,,) = ch.getAccount(alice);
        assertEq(open.length, 0);
        (uint256 l, uint256 s) = ch.laneOpenInterest(3, MON);
        assertEq(l + s, 0, "OI fully released");
        assertSolvent();
    }

    function test_Fill_ShortEntryRoundedDown_AndFloorPnl() public {
        _open(alice, MON, false, 1_000e6, 100e6);
        _setSpot(FEED_MON, 33e7);
        _open(alice, MON, false, 1_000e6, 100e6);
        CH.Position memory p = ch.getPosition(alice, MON);
        uint256 s1 = _sizeForPx(1_000e6, 3e18);
        uint256 s2 = _sizeForPx(1_000e6, 3.3e18);
        assertEq(p.entryPrice, (s1 * 3e18 + s2 * 3.3e18) / (s1 + s2), "short entry rounded down");
        (int256 pnl,) = ch.unrealizedPnl(alice, MON);
        int256 exact = int256(p.size) * (int256(p.entryPrice) - 3.3e18);
        // floor toward -inf
        int256 expected = exact / 1e30;
        if (exact % 1e30 != 0 && exact < 0) expected -= 1;
        assertEq(pnl, expected);
    }

    function test_Fill_SlippageFailsOrder_ExecutorPaid_EscrowReleased() public {
        int256 sz = int256(_sizeFor(1_000e6, MON));
        uint256 id = _commit(alice, MON, sz, 100e6, 2.9e18); // buy, max 2.90
        CH.Order memory o = ch.getOrder(id);
        vm.warp(o.execAfter + 1);
        vm.prank(keeper);
        ch.executeOrder(id, _upd1(FEED_MON, 3e8, o.execAfter, o.execAfter - 1));
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Failed));
        assertEq(ch.getPosition(alice, MON).size, 0);
        (,,,, uint256 reserved,) = ch.getAccount(alice);
        assertEq(reserved, 0);
        assertEq(ch.pendingOrderOf(alice, MON), 0);
        assertEq(ch.executionFeesOwed(keeper), EXEC_FEE, "executor paid for a valid attempt");
        assertEq(collateralOf(alice), 10_000e6, "no fee, no fill");
        // a sell with a min price above the fill also fails
        _open(bob, MON, true, 1_000e6, 100e6);
        CH.Position memory p = ch.getPosition(bob, MON);
        uint256 id2 = _commit(bob, MON, -int256(p.size), 0, 3.01e18);
        _execute(id2);
        assertEq(uint8(ch.getOrder(id2).status), uint8(CH.OrderStatus.Failed));
        assertSolvent();
    }

    function test_Fill_FailsOnLeverageMinSizeAndMargin() public {
        // leverage: 1,000 notional with 49 margin at max 20x → 20.4x
        uint256 id = _commit(alice, MON, int256(_sizeFor(1_000e6, MON)), 49e6, type(uint128).max);
        _execute(id);
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Failed), "leverage");
        // min size: 9 AUSD notional
        id = _commit(alice, MON, int256(_sizeFor(9e6, MON)), 9e6, type(uint128).max);
        _execute(id);
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Failed), "min size");
        // increase without new margin pushes leverage over the max
        _open(alice, MON, true, 1_000e6, 50e6); // exactly 20x minus rounding
        id = _commit(alice, MON, int256(_sizeFor(100e6, MON)), 0, type(uint128).max);
        _execute(id);
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Failed), "increase w/o margin");
    }

    function test_Fill_InitialMarginAcrossLegs() public {
        address c = laneAddr(2, 9);
        fund(c, 100e6);
        _open(c, MON, true, 1_000e6, 60e6); // uses 60 of ~99.5 collateral
        // second leg needs 60 more margin: escrow check passes on 40 only → commit reverts
        vm.prank(c);
        vm.expectRevert();
        ch.commitOrder{value: EXEC_FEE}(BTC, int256(_sizeFor(1_000e6, BTC)), 60e6, type(uint128).max);
        // the MON leg loses 30 → equity < IM for a 39-margin BTC leg → fill fails (cross check)
        uint256 id = _commit(c, BTC, int256(_sizeFor(780e6, BTC)), 39e6, type(uint128).max);
        _setSpot(FEED_MON, 291e6); // −3% on 1,000 notional ≈ −30
        _execute(id);
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Failed), "cross-margin IM");
    }

    /// @notice A pending close whose position was liquidated before execution must fail and must
    ///         never open the opposite position (reduce orders carry no margin).
    function test_Fill_StaleReduceAfterLiquidation_NeverOpensOpposite() public {
        address v = laneAddr(5, 21);
        fund(v, 100e6);
        _open(v, MON, true, 1_900e6, 95e6);
        uint256 id = _commit(v, MON, -int256(ch.getPosition(v, MON).size), 0, 1);
        // crash, auction, pool take (lane 5 pool funded here)
        address lp = makeAddr("lp");
        vm.prank(admin);
        ausd.ownerMint(lp, 50_000e6);
        vm.startPrank(lp);
        ausd.approve(address(ch), type(uint256).max);
        ch.backstopDeposit(5, 50_000e6, _none());
        vm.stopPrank();
        _setSpot(FEED_MON, 2.88e8);
        address[] memory l = new address[](1);
        l[0] = v;
        ch.startAuctions(5, l, _none());
        vm.roll(block.number + 3);
        assertEq(ch.backstopTakeBatch(5, l, _none()), 1);
        assertEq(ch.getPosition(v, MON).size, 0);
        _execute(id);
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Failed), "stale reduce fails");
        assertEq(ch.getPosition(v, MON).size, 0, "no short opened");
        assertSolvent();
    }

    /// @notice R2-03 (v3): the account's other legs are priced through the lane's monotonic path
    ///         from the executor's update (newest of supplied / stored / lane price). No separate
    ///         Pyth push is needed, and a supplied price OLDER than the lane price is never used.
    function test_Fill_OtherLegsPricedFromUpdate_MonotonicPerLane() public {
        _open(alice, BTC, true, 2_000e6, 200e6);
        vm.warp(block.timestamp + 1_000); // stored prices stale
        uint256 id = _commit(alice, MON, int256(_sizeFor(1_000e6, MON)), 100e6, type(uint128).max);
        CH.Order memory o = ch.getOrder(id);
        vm.warp(o.execAfter + 1);
        // only the order's feed: the BTC leg has no usable price → whole call reverts (keeper's
        // problem), the order stays pending
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CH.StalePrice.selector, BTC, o.execAfter - 1_000 - 3));
        ch.executeOrder(id, _upd1(FEED_MON, 3e8, o.execAfter, o.execAfter - 1));
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Pending));
        // a fresh BTC price in the update is enough: no Pyth-storage push needed
        uint256 snap = vm.snapshotState();
        bytes[] memory all = _updAll(o.execAfter);
        vm.prank(keeper);
        ch.executeOrder(id, all);
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Executed));
        (, uint256 tBtc) = ch.lanePrice(3, BTC);
        assertEq(tBtc, o.execAfter, "BTC lane price advanced");
        vm.revertToState(snap);
        // the lane already used a newer BTC price (via another call): an older supplied BTC price
        // cannot be selected for the leg (prices never move back in a lane)
        bytes[] memory newer = _updAll(block.timestamp);
        vm.prank(alice);
        ch.withdraw(1e6, newer); // records BTC (and MON) at `now` in lane 3
        _setSpot(FEED_BTC, 50_000e8); // an OLD message claiming BTC halved
        bytes[] memory oldBtc = new bytes[](2);
        oldBtc[0] = _upd1(FEED_BTC, 50_000e8, o.execAfter, o.execAfter - 1)[0];
        oldBtc[1] = _upd1(FEED_MON, 3e8, o.execAfter, o.execAfter - 1)[0];
        vm.prank(keeper);
        ch.executeOrder(id, oldBtc);
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Executed), "older BTC ignored");
    }

    function test_Fill_InAuctionFails() public {
        address c = laneAddr(3, 11);
        fund(c, 100e6);
        _open(c, MON, true, 1_900e6, 95e6);
        uint256 id = _commit(c, MON, -int256(ch.getPosition(c, MON).size / 2), 0, 1);
        _setSpot(FEED_MON, 2.88e8); // −4% → under maintenance
        address[] memory accts = new address[](1);
        accts[0] = c;
        ch.startAuctions(3, accts, _none());
        (bool active,,) = ch.auctionOf(c);
        assertTrue(active);
        _execute(id);
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Failed), "frozen account");
    }

    // ------------------------------------------------------------------ pyth fees

    function test_PythFee_ForwardedAndExcessRefunded() public {
        pyth.setFees(7, 3);
        uint256 id = _commit(alice, MON, int256(_sizeFor(1_000e6, MON)), 100e6, type(uint128).max);
        CH.Order memory o = ch.getOrder(id);
        vm.warp(o.execAfter + 1);
        bytes[] memory u = _updAll(o.execAfter);
        uint256 fee = pyth.getUpdateFee(u);
        assertEq(fee, 3 * 7 + 3);
        uint256 kb = keeper.balance;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CH.InsufficientPythFee.selector, fee - 1, fee));
        ch.executeOrder{value: fee - 1}(id, u);
        vm.prank(keeper);
        ch.executeOrder{value: 1 ether}(id, u);
        assertEq(keeper.balance, kb - fee, "only the Pyth fee is kept");
        assertEq(address(pyth).balance, fee);
        assertSolvent();
    }

    // ------------------------------------------------------------------ helpers

    function _sizeForPx(uint256 notional, uint256 px18) internal pure returns (uint256) {
        return (notional * 1e30) / px18;
    }
}

/// @notice A trading contract that rejects native MON (refund push fails → credited).
contract RejectingTrader {
    function depositAndCommit(
        CH ch,
        MockAUSDLike ausd,
        bytes32 market,
        int256 size,
        uint256 margin,
        uint256 fee
    ) external {
        ausd.approve(address(ch), type(uint256).max);
        ch.deposit(1_000e6);
        ch.commitOrder{value: fee}(market, size, margin, type(uint128).max);
    }

    receive() external payable {
        revert("no MON");
    }
}

interface MockAUSDLike {
    function approve(address, uint256) external returns (bool);
}
