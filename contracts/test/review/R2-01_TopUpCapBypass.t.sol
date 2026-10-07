// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R2-01 (Medium): the R-04 top-up exemption let any holder ratchet past BOTH beta caps.
///        **FLIPPED INTO A REGRESSION (v3).**
/// @notice FLIPPED 2026-10-07 after the v3 fix: the ratchet now FAILS.
///         Fix: (1) an increase order that adds margin may not leave margin above notional
///         (`MarginAboveNotional`), so dust orders cannot book free collateral as margin;
///         (2) the cap exemption (`topUpAllowance`) only exists while equity is BELOW initial margin
///         and only up to 110% of it; every other part of a deposit obeys both caps.
///         UPDATED v4 (R3-03): the exemption now restores equity to exactly 100% of initial margin
///         (`TOP_UP_TARGET_BPS = 10_000`), so exempt money can never fund new margin.
contract R2_01_TopUpCapBypassTest is ReviewBase {
    uint8 internal constant L = 5;

    function setUp() public override {
        super.setUp();
        _betaCaps(); // 50 AUSD per account, 500 AUSD per lane, 10x
    }

    function test_R2_01_DustOrdersCannotRatchetPastEitherCap() public {
        address u = laneAddr(L, 1);
        fund(u, 50e6);
        // the PoC's first step (20 notional with 50 margin) is now refused at fill
        uint256 first = _commit(u, MON, int256(_sizeFor(20e6, MON)), 50e6, type(uint128).max);
        _execute(first);
        assertEq(uint8(ch.getOrder(first).status), uint8(CH.OrderStatus.Failed), "margin > notional refused");
        _open(u, MON, true, 20e6, 2e6); // a normal small position
        vm.prank(admin);
        ausd.ownerMint(u, 10_000e6);
        vm.prank(u);
        ausd.approve(address(ch), type(uint256).max);

        for (uint256 i; i < 20; ++i) {
            // 1) no exemption while healthy: a deposit beyond the cap reverts
            assertEq(ch.topUpAllowance(u), 0, "healthy account: no exemption");
            int256 c = collateralOf(u);
            vm.prank(u);
            vm.expectRevert();
            ch.deposit(uint256(50e6 - c) + 1);
            // 2) the dust increase booking all free collateral as margin fails
            uint256 free = uint256(collateralOf(u)) - ch.getPosition(u, MON).margin;
            uint256 id = _commit(u, MON, int256(1e11), free, type(uint128).max);
            _execute(id);
            assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Failed), "dust margin refused");
        }
        assertLe(collateralOf(u), 50e6, "account within its cap");
        assertLe(ch.laneTvl(L), ch.maxTvlPerLane(), "lane within its cap");
        assertLe(ch.getPosition(u, MON).margin, 2e6, "no margin parked");
        assertSolvent();
    }

    /// @notice The exemption is real but bounded: an account below initial margin may top up to
    ///         its initial margin (to defend or cure), never further (110% in v3, 100% since v4).
    function test_R2_01b_ExemptionOnlyRestoresToInitialMargin() public {
        address u = laneAddr(L, 2);
        fund(u, 50e6);
        _open(u, MON, true, 450e6, 45e6);
        assertEq(ch.topUpAllowance(u), 0);
        _setSpot(FEED_MON, 2.8e8); // −6.7%: equity ≈ 49.8 − 30 = 19.8 < IM 44.8
        (int256 e,, uint256 im,) = ch.accountHealth(u);
        assertLt(e, int256(im));
        uint256 allowance = ch.topUpAllowance(u);
        assertEq(ch.TOP_UP_TARGET_BPS(), 10_000);
        assertEq(allowance, uint256(int256(im) - e), "to 100% of IM (R3-03)");
        vm.prank(admin);
        ausd.ownerMint(u, 1_000e6);
        vm.prank(u);
        ausd.approve(address(ch), type(uint256).max);
        // allowance + anything that the caps still allow (collateral is already at 49.775)
        vm.prank(u);
        vm.expectRevert();
        ch.deposit(allowance + 1e6);
        vm.prank(u);
        ch.deposit(allowance);
        assertEq(ch.topUpAllowance(u), 0, "restored: no further exemption");
        (e,,,) = ch.accountHealth(u);
        assertGe(e, int256(im));
    }
}
