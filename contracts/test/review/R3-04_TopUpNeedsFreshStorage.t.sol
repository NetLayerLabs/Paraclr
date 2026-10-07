// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R3-04 (Low): the R-04 rescue top-up silently depended on a <= 15 s storage push.
///        **FLIPPED INTO A REGRESSION (v4).**
/// @notice FLIPPED 2026-10-07 after the v4 fix: the top-up works with the trader's own price update.
///         Original finding (v3): `deposit(amount)` took no price update and `topUpAllowance`
///         priced the legs from Pyth storage / the lane price only (<= 15 s), so with storage pushes
///         60–143 s apart on Monad a capped holder sliding towards liquidation got
///         `DepositCapExceeded` when adding margin.
///         Fix (v4): `depositWithPrice(amount, priceUpdate)` (payable, excess refunded) resolves the
///         account's markets from the supplied update (lane-monotonic, <= `maxPriceAge`) before
///         computing the exemption. `deposit(amount)` is unchanged.
contract R3_04_TopUpNeedsFreshStorageTest is ReviewBase {
    uint8 internal constant L = 5;
    address internal u;

    function setUp() public override {
        super.setUp();
        _betaCaps();
        u = laneAddr(L, 1);
        fund(u, 50e6);
        _open(u, MON, true, 450e6, 45e6); // 10x, at the 50 AUSD cap
        vm.prank(admin);
        ausd.ownerMint(u, 100e6);
        vm.prank(u);
        ausd.approve(address(ch), type(uint256).max);
        vm.deal(u, 1 ether);
    }

    function test_R3_04_DepositWithPriceTopsUpOnStaleStorage() public {
        // The market slides to 2.80 (below IM, above MM). The last push is 20 s old.
        _store(FEED_MON, 2.8e8, block.timestamp);
        vm.warp(block.timestamp + 20);
        assertEq(ch.topUpAllowance(u), 0, "no usable stored price: no exemption from the view");
        vm.prank(u);
        vm.expectRevert(); // plain deposit: unchanged behaviour (DepositCapExceeded)
        ch.deposit(20e6);

        // stale update (older than maxPriceAge) does not help either
        bytes[] memory old = _updMon(2.8e8, block.timestamp - ch.maxPriceAge() - 1);
        vm.prank(u);
        vm.expectRevert();
        ch.depositWithPrice(20e6, old);

        // the trader's own fresh update: exemption computed at 2.80, deposit accepted
        uint256 balBefore = u.balance;
        uint256 ausdBefore = ausd.balanceOf(u);
        vm.prank(u);
        ch.depositWithPrice{value: 1e15}(20e6, _updMon(2.8e8, block.timestamp));
        assertEq(u.balance, balBefore, "excess native refunded (fee 0)");
        assertEq(ausdBefore - ausd.balanceOf(u), 20e6);
        (uint256 p, uint256 t) = ch.lanePrice(L, MON);
        assertEq(p, 2.8e18, "lane price advanced by the update");
        assertEq(t, block.timestamp);
        (int256 e,, uint256 im,) = ch.accountHealth(u);
        assertLe(e, int256(im), "still at or below IM: within the exemption");
        assertSolvent();
    }

    /// @notice The exemption is computed exactly as `topUpAllowance` at the supplied price: the
    ///         exemption plus the account's remaining cap room is accepted, one unit more is refused.
    function test_R3_04b_DepositWithPriceBoundedByAllowance() public {
        _store(FEED_MON, 2.8e8, block.timestamp);
        vm.warp(block.timestamp + 20);
        bytes[] memory live = _updMon(2.8e8, block.timestamp);
        uint256 snap = vm.snapshotState();
        assertEq(ch.startAuctions(L, _one(u), live), 0); // records 2.80 in the lane (view helper)
        uint256 allow = ch.topUpAllowance(u);
        assertGt(allow, 20e6);
        vm.revertToState(snap);
        uint256 room = uint256(50e6 - collateralOf(u));
        vm.prank(u);
        vm.expectPartialRevert(CH.DepositCapExceeded.selector);
        ch.depositWithPrice(allow + room + 1, live);
        vm.prank(u);
        ch.depositWithPrice(allow + room, live);
        (int256 e,, uint256 im,) = ch.accountHealth(u);
        assertEq(e, int256(im + room), "IM via the exemption, plus the normal cap room");
    }

    /// @notice Without positions the update is ignored and the caps apply as for `deposit`.
    function test_R3_04c_NoPositions_UpdateIgnored_CapsApply() public {
        address n = laneAddr(L, 7);
        vm.prank(admin);
        ausd.ownerMint(n, 100e6);
        vm.startPrank(n);
        ausd.approve(address(ch), type(uint256).max);
        vm.expectRevert(); // above the 50 AUSD account cap
        ch.depositWithPrice(51e6, _updMon(2.8e8, block.timestamp));
        ch.depositWithPrice(50e6, new bytes[](1)); // garbage update: not parsed
        vm.stopPrank();
        assertEq(collateralOf(n), 50e6);
        (, uint256 t) = ch.lanePrice(L, MON);
        assertLt(t, block.timestamp + 1);
    }
}
