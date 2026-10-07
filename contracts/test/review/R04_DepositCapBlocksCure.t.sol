// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R-04 (Medium): the deposit caps block margin top-ups, so capped users cannot cure.
///        **FLIPPED INTO A REGRESSION.**
/// @notice FLIPPED 2026-10-07 after the fix: the tests now assert top-ups and cures WORK.
///         v3 note (R2-01): the exemption is now `topUpAllowance` (only while equity is below
///         initial margin, up to 110% of it); the bound assertion follows that rule.
///         Fix: a deposit by an account holding positions (incl. in auction) is a margin top-up:
///         exempt from the lane TVL cap and from the fixed per-account cap; instead bounded by
///         `maxDepositPerAccount + Σ position margins` (so a 1-AUSD position cannot unlock
///         unlimited deposits). Fresh deposits stay capped.
contract R04_DepositCapBlocksCureTest is ReviewBase {
    uint8 internal constant L = 5;

    function setUp() public override {
        super.setUp();
        _betaCaps();
    }

    function _mintTo(address who, uint256 amount) internal {
        vm.prank(admin);
        ausd.ownerMint(who, amount);
        vm.prank(who);
        ausd.approve(address(ch), type(uint256).max);
    }

    function test_R04a_AccountAtDepositCapCanTopUpAndCure() public {
        address u = laneAddr(L, 1);
        fund(u, 50e6);
        _open(u, MON, true, 450e6, 45e6);
        _setSpot(FEED_MON, 2.72e8);
        assertTrue(ch.isLiquidatable(u));
        assertEq(ch.startAuctions(L, _one(u), _none()), 1);
        _mintTo(u, 200e6);
        vm.prank(u);
        ch.deposit(20e6); // top-up beyond the 50 AUSD fresh-deposit cap
        vm.roll(block.number + 1);
        assertTrue(ch.cancelAuction(u, _none()), "cured by the top-up");
        // bounded (v3, R2-01): the exemption only restores equity to 110% of initial margin; any
        // further deposit is subject to the 50 AUSD cap again
        (int256 coll,,,,,) = ch.getAccount(u);
        uint256 allowance = ch.topUpAllowance(u);
        vm.prank(u);
        vm.expectRevert(abi.encodeWithSelector(CH.DepositCapExceeded.selector, coll + 1e6, 50e6));
        ch.deposit(allowance + 1e6);
        // a FRESH deposit (no positions) is still capped at 50
        address f = laneAddr(L, 2);
        _mintTo(f, 100e6);
        vm.prank(f);
        vm.expectRevert(abi.encodeWithSelector(CH.DepositCapExceeded.selector, int256(51e6), 50e6));
        ch.deposit(51e6);
    }

    function test_R04b_ThirdPartyCannotBlockTopUpsByFillingLaneTvl() public {
        address u = laneAddr(L, 1);
        fund(u, 30e6);
        _open(u, MON, true, 300e6, 30e6); // all-in now fills (R-06)
        (int256 laneColl,,,,,,) = ch.laneLedger(L);
        uint256 room = 500e6 - uint256(laneColl); // no pool cash in this lane
        for (uint256 i; room > 0; ++i) {
            uint256 amt = room > 50e6 ? 50e6 : room;
            fund(laneAddr(L, 100 + i), amt);
            room -= amt;
        }
        assertEq(ch.laneTvl(L), 500e6);
        _setSpot(FEED_MON, 2.72e8);
        assertTrue(ch.isLiquidatable(u));
        _mintTo(u, 10e6);
        vm.prank(u);
        ch.deposit(10e6); // exempt from the lane TVL cap
        assertGt(ch.laneTvl(L), 500e6, "top-up went through a full lane");
        assertFalse(ch.isLiquidatable(u), "defended");
        // a fresh deposit into the full lane is still refused
        address f = laneAddr(L, 999);
        _mintTo(f, 10e6);
        vm.prank(f);
        vm.expectRevert();
        ch.deposit(10e6);
    }
}
