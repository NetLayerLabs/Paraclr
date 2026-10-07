// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R5-02 (Low): `CollateralAboveCap` guards orders, but `take` still books new margin from
///        exempt money; plus two side effects of the v5 diff (Info).
/// @notice a) R4-03 residual: after a dip top-up and a recovery, an account above the cap is
///            refused margin-adding orders, but it can still take a same-lane auction. `_inherit`
///            books new margin, funded by the exempt collateral, and later dips are topped up exempt
///            on the larger IM. The ratchet needs a supply of auctions (the attacker's own
///            10x Sybils, each fresh-capped and losing its equity), so it is costly and bounded by
///            OI capacity.
///         b) Info: a trader whose collateral exceeds the cap through PROFITS can no longer open
///            any position (every new position needs margin) until it withdraws down to the cap.
///         c) Info: `_feedIsDead` now also trusts the NEWEST stored price's usability. Anyone can
///            push a newer, real but wide-confidence print of a LIVE feed into Pyth storage right
///            before a timelocked swap executes, unlocking the 50% bound. Only governance can
///            call the swap, so this weakens the "refutable during the delay" property rather than
///            adding attacker power.
contract R5_02_TakeBypassesCollateralCapTest is ReviewBase {
    uint8 internal constant L = 5;

    function setUp() public override {
        super.setUp();
        _betaCaps(); // 50 / 500 / 10x
    }

    function test_R5_02a_TakeBooksMarginAboveTheCap() public {
        address m = laneAddr(L, 1);
        fund(m, 50e6);
        _open(m, MON, true, 495e6, 50e6); // ~10x
        vm.prank(admin);
        ausd.ownerMint(m, 1_000e6);
        vm.prank(m);
        ausd.approve(address(ch), type(uint256).max);
        _setSpot(FEED_MON, 2.97e8); // dip
        uint256 allow = ch.topUpAllowance(m);
        vm.prank(m);
        ch.deposit(allow); // exempt
        _setSpot(FEED_MON, 3e8); // recovery: collateral above the cap, equity above IM
        assertGt(collateralOf(m), 50e6);
        vm.prank(m);
        vm.expectPartialRevert(CH.CollateralAboveCap.selector);
        ch.commitOrder{value: EXEC_FEE}(MON, int256(_sizeFor(40e6, MON)), 4e6, type(uint128).max);

        // a small same-lane Sybil at 10x is liquidated; the capped account takes it
        address v = laneAddr(L, 2);
        fund(v, 2e6);
        _open(v, SOL, true, 20e6, 2e6);
        _setSpot(FEED_SOL, 1638e7); // -9%
        assertEq(ch.startAuctions(L, _one(v), _none()), 1);
        uint256 imBefore = ch.getPosition(m, MON).margin;
        vm.prank(m);
        ch.take(v, _none());
        uint256 inherited = ch.getPosition(m, SOL).margin;
        assertGt(inherited, 1e6, "new margin booked while collateral is above the cap");
        (,, uint256 imAfter,) = ch.accountHealth(m);
        emit log_named_decimal_uint("IM before take", imBefore, 6);
        emit log_named_decimal_uint("margin inherited above the cap", inherited, 6);
        emit log_named_decimal_int("collateral (cap 50)", collateralOf(m), 6);
        assertGt(imAfter, imBefore + 1e6, "exposure grew, funded by exempt collateral");
        assertGt(collateralOf(m), 50e6);
        // later dips are topped up exempt on this larger IM: the order path is closed, the take path is not
    }

    function test_R5_02b_ProfitableTraderLockedOutOfNewPositions() public {
        address u = laneAddr(L, 3);
        fund(u, 50e6);
        _open(u, MON, true, 400e6, 40e6);
        _setSpot(FEED_MON, 3.3e8); // +10%
        _closeAll(u, MON); // realised +40
        assertGt(collateralOf(u), 80e6);
        vm.prank(u);
        vm.expectPartialRevert(CH.CollateralAboveCap.selector);
        ch.commitOrder{value: EXEC_FEE}(SOL, int256(_sizeFor(100e6, SOL)), 10e6, type(uint128).max);
    }

    function test_R5_02c_PushedWideConfPrintMakesLiveFeedDead() public {
        address a = laneAddr(3, 1);
        fund(a, 50e6);
        _open(a, MON, true, 100e6, 10e6);
        bytes32 newFeed = keccak256("MON/USD v2 feed");
        pyth.setStoredPrice(newFeed, 3.9e8, 3e4, EXPO, block.timestamp); // +30%
        vm.prank(admin);
        vm.expectRevert(CH.InvalidParam.selector); // live feed: 10% max
        ch.replaceMarketFeed(MON, newFeed, 5_000);
        // anyone pushes a newer, real print of the LIVE feed that happened to have a 3% conf
        vm.warp(block.timestamp + 1);
        pyth.setStoredPrice(newFeed, 3.9e8, 3e4, EXPO, block.timestamp);
        pyth.setStoredPrice(FEED_MON, 3e8, uint64(9_000_000), EXPO, block.timestamp);
        vm.prank(admin);
        ch.replaceMarketFeed(MON, newFeed, 5_000); // now "dead": a 30% repricing goes through
        (,, bytes32 feedNow,,,) = ch.getMarket(MON);
        assertEq(feedNow, newFeed);
    }
}
