// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ProdTestBase} from "./ProdTestBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @notice Funding (global skew, rate-limited index, settlement on touch, sign, accrual,
///         clamp, backstop pools) and caps (leverage, deposit, lane TVL, lane OI, min size).
contract ProdFundingTest is ProdTestBase {
    address internal longA = laneAddr(1, 1);
    address internal longB = laneAddr(6, 2);
    address internal shortC = laneAddr(4, 3);

    function setUp() public override {
        super.setUp();
        fund(longA, 10_000e6);
        fund(longB, 10_000e6);
        fund(shortC, 10_000e6);
    }

    function _rate(bytes32 m) internal view returns (int256 r) {
        (, r,,,) = ch.fundingState(m);
    }

    function test_UpdateFunding_RateLimited() public {
        (,, uint256 last,, uint256 next) = ch.fundingState(MON);
        assertEq(next, last + 60);
        vm.expectRevert(abi.encodeWithSelector(CH.FundingUpdateTooSoon.selector, next));
        ch.updateFunding(MON);
        vm.warp(next);
        ch.updateFunding(MON);
        vm.expectRevert(abi.encodeWithSelector(CH.FundingUpdateTooSoon.selector, block.timestamp + 60));
        ch.updateFunding(MON);
        vm.expectRevert(abi.encodeWithSelector(CH.MarketNotListed.selector, bytes32(0)));
        ch.updateFunding(bytes32(0));
    }

    function test_FundingFromGlobalSkew_LongsPay_ShortsReceive() public {
        // global skew across lanes 1 and 6: +2,000 long; lane 4: −500 short → skew +1,500
        _open(longA, MON, true, 1_000e6, 100e6);
        _open(longB, MON, true, 1_000e6, 100e6);
        _open(shortC, MON, false, 500e6, 50e6);
        vm.warp(block.timestamp + 60);
        ch.updateFunding(MON);
        int256 skew = int256(2 * (1_000e6 - 1)) - int256(500e6 - 1);
        int256 maxRate = int256((uint256(100) * 1e18) / 10_000 / 1 days);
        int256 expected = (maxRate * skew) / int256(100_000e6);
        assertEq(_rate(MON), expected, "rate = max x skew / scale");
        assertGt(expected, 0);

        uint256 insBefore;
        (insBefore,,,,) = ch.getLane(1);
        vm.warp(block.timestamp + 1 days);
        _refreshStored();
        (, int256 fA) = ch.unrealizedPnl(longA, MON);
        (, int256 fC) = ch.unrealizedPnl(shortC, MON);
        assertLt(fA, 0, "long pays");
        assertGt(fC, 0, "short receives");
        // expected long payment ≈ entryNotional × rate × 1 day (floored against the long)
        CH.Position memory p = ch.getPosition(longA, MON);
        int256 owed = -int256(p.entryNotional) * expected * 1 days;
        int256 floorOwed = owed / 1e18 - (owed % 1e18 != 0 ? int256(1) : int256(0));
        assertEq(fA, floorOwed);

        // settles when touched: closing realizes it into collateral and the lane fund
        int256 before = collateralOf(longA);
        _closeAll(longA, MON);
        (uint256 insAfter,,,,) = ch.getLane(1);
        assertLt(collateralOf(longA) - before, int256(0) + 0); // paid funding + fee, price flat
        assertGt(insAfter, insBefore, "lane received the funding (and fees)");
        assertSolvent();
    }

    function test_FundingClampAndNegativeRate() public {
        // short-heavy beyond skewScale (100k) → rate = −max
        address big = laneAddr(2, 99);
        fund(big, 1_000_000e6);
        vm.prank(admin);
        ch.setCaps(1_000_000e6, 100_000_000e6, 100_000); // 10x insurance (the bound)
        _open(big, MON, false, 200_000e6, 20_000e6);
        vm.warp(block.timestamp + 60);
        ch.updateFunding(MON);
        int256 maxRate = int256((uint256(100) * 1e18) / 10_000 / 1 days);
        assertEq(_rate(MON), -maxRate);
        vm.warp(block.timestamp + 1 hours);
        _refreshStored();
        (, int256 f) = ch.unrealizedPnl(big, MON);
        assertLt(f, 0, "short-heavy skew: rate < 0, shorts pay");
        assertSolvent();
    }

    function test_NoSkewNoFunding() public {
        _open(longA, MON, true, 1_000e6, 100e6);
        // rate is 0 until updateFunding runs
        vm.warp(block.timestamp + 10 days);
        _refreshStored();
        (, int256 f) = ch.unrealizedPnl(longA, MON);
        assertEq(f, 0);
    }

    function test_FundingIndexAccruesBetweenUpdates() public {
        _open(longA, MON, true, 1_000e6, 100e6);
        vm.warp(block.timestamp + 60);
        ch.updateFunding(MON);
        (int256 idx0, int256 r,,,) = ch.fundingState(MON);
        vm.warp(block.timestamp + 1_000);
        (,,, int256 now_,) = ch.fundingState(MON);
        assertEq(now_, idx0 + r * 1_000, "index read = stored + rate x elapsed");
    }
}

contract ProdCapsTest is ProdTestBase {
    address internal a = laneAddr(2, 1);
    address internal b = laneAddr(2, 2);

    function setUp() public override {
        super.setUp();
        vm.prank(admin);
        ch.setCaps(50e6, 500e6, 50_000); // beta values
    }

    function _mintApprove(address who, uint256 amount) internal {
        vm.prank(admin);
        ausd.ownerMint(who, amount);
        vm.prank(who);
        ausd.approve(address(ch), type(uint256).max);
        vm.deal(who, 10 ether);
    }

    function test_DepositCap_Edge() public {
        _mintApprove(a, 100e6);
        vm.startPrank(a);
        ch.deposit(50e6);
        vm.expectRevert(abi.encodeWithSelector(CH.DepositCapExceeded.selector, int256(50e6 + 1), 50e6));
        ch.deposit(1);
        ch.withdraw(10e6, _none());
        ch.deposit(10e6); // back to exactly the cap
        vm.stopPrank();
        assertEq(collateralOf(a), 50e6);
    }

    function test_LaneTvlCap_Edge_IncludesBackstop() public {
        // lane 2: 10 accounts × 50 = 500 = cap
        for (uint256 i; i < 10; ++i) {
            address u = laneAddr(2, 100 + i);
            _mintApprove(u, 50e6);
            vm.prank(u);
            ch.deposit(50e6);
        }
        assertEq(ch.laneTvl(2), 500e6);
        address u2 = laneAddr(2, 200);
        _mintApprove(u2, 50e6);
        vm.prank(u2);
        vm.expectRevert(abi.encodeWithSelector(CH.LaneTvlCapExceeded.selector, 500e6 + 1e6, 500e6));
        ch.deposit(1e6);
        // pool deposits count too
        vm.prank(u2);
        vm.expectRevert(abi.encodeWithSelector(CH.LaneTvlCapExceeded.selector, 500e6 + 1e6, 500e6));
        ch.backstopDeposit(2, 1e6, _none());
        // another lane is unaffected
        address u3 = laneAddr(3, 200);
        _mintApprove(u3, 50e6);
        vm.prank(u3);
        ch.deposit(50e6);
    }

    function test_Leverage_Edge() public {
        vm.prank(admin);
        ch.setRiskParams(10, 5, 10e6);
        _mintApprove(a, 50e6);
        vm.prank(a);
        ch.deposit(50e6);
        // 10x exactly: 400 notional / 40 margin (size floors → notional ≤ 400)
        uint256 id = _commit(a, MON, int256(_sizeFor(400e6, MON)), 40e6, type(uint128).max);
        _execute(id);
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Executed));
        _closeAll(a, MON);
        // 10x + a hair: fails
        id = _commit(a, MON, int256(_sizeFor(400e6, MON) + 1e15), 40e6, type(uint128).max);
        _execute(id);
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Failed));
    }

    function test_MinPositionSize_Edge() public {
        _mintApprove(a, 50e6);
        vm.prank(a);
        ch.deposit(50e6);
        // exactly 10 AUSD notional: size such that size × 3 / 1e30 == 10e6
        uint256 px = 3e18;
        uint256 size = (10e6 * 1e30 + px - 1) / px;
        uint256 id = _commit(a, MON, int256(size), 5e6, type(uint128).max);
        _execute(id);
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Executed));
        // partial reduce leaving < min fails
        id = _commit(a, MON, -int256(size / 2), 0, 1);
        _execute(id);
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Failed));
        // full close is always allowed
        _closeAll(a, MON);
        assertEq(ch.getPosition(a, MON).size, 0);
    }

    function test_OiCap_ByBackingAndAbsolute() public {
        // lane 2 backing = insurance 100,000 → ×5 = 500,000 ≫ absolute cap below
        vm.startPrank(admin);
        ch.setCaps(1_000_000e6, 100_000_000e6, 50_000);
        ch.setMarketConfig(MON, FEED_MON, 100_000e6, 1_000e6, 100); // absolute 1,000 per side
        vm.stopPrank();
        fund(a, 10_000e6);
        fund(b, 10_000e6);
        assertEq(ch.laneOiCap(2, MON), 1_000e6);
        _open(a, MON, true, 900e6, 90e6);
        (uint256 l,) = ch.laneOpenInterest(2, MON);
        // up to the cap exactly
        uint256 room = 1_000e6 - l;
        uint256 px = 3e18;
        uint256 id = _commit(b, MON, int256((room * 1e30) / px), 10e6, type(uint128).max);
        _execute(id);
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Executed));
        (l,) = ch.laneOpenInterest(2, MON);
        assertLe(l, 1_000e6);
        // one more unit of notional → Failed (OiCapExceeded)
        id = _commit(a, MON, int256(_sizeFor(2e6, MON)), 1e6, type(uint128).max);
        _execute(id);
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Failed));
        // the other side and other lanes are unaffected
        address c = laneAddr(2, 3);
        fund(c, 10_000e6);
        _open(c, MON, false, 900e6, 90e6);
        address other = laneAddr(5, 7);
        fund(other, 10_000e6);
        _open(other, MON, true, 900e6, 90e6);
    }

    /// @notice R-07: the backing-based OI cap counts lane INSURANCE only; a pool deposit (which can
    ///         leave) does not raise it. Funding the lane does.
    function test_OiCap_ScalesWithInsuranceOnly_PoolDepositsDoNotCount() public {
        vm.startPrank(admin);
        ch.setCaps(1_000_000e6, 100_000_000e6, 50_000);
        vm.stopPrank();
        (uint256 ins,,,,) = ch.getLane(2);
        assertEq(ch.laneOiCap(2, MON), (ins * 50_000) / 10_000);
        _mintApprove(a, 20_000e6);
        vm.prank(a);
        ch.backstopDeposit(2, 10_000e6, _none());
        assertEq(ch.laneOiCap(2, MON), (ins * 50_000) / 10_000, "pool cash does not count");
        vm.prank(a);
        ch.fundLane(2, 10_000e6);
        assertEq(ch.laneOiCap(2, MON), ((ins + 10_000e6) * 50_000) / 10_000, "insurance does");
    }

    function test_CapsCanBeTightenedBelowExisting_ReducesStillWork() public {
        vm.prank(admin);
        ch.setCaps(1_000_000e6, 100_000_000e6, 50_000);
        fund(a, 10_000e6);
        _open(a, MON, true, 2_000e6, 200e6);
        vm.prank(admin);
        ch.setCaps(1e6, 1e6, 0); // everything at/over the cap
        assertEq(ch.laneOiCap(2, MON), 0);
        ParaclrReduce memory r;
        r.size = ch.getPosition(a, MON).size / 2;
        uint256 id = _commit(a, MON, -int256(r.size), 0, 1);
        _execute(id);
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Executed), "reduce under a zero cap");
        vm.prank(a);
        ch.withdraw(1_000e6, _none());
    }

    struct ParaclrReduce {
        uint256 size;
    }
}
