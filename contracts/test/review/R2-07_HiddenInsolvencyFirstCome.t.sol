// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R2-07 (Low): the R-05 haircut was first-come on REALISATION; a bankrupt account sat in its
///        auction while `laneSolvency` stayed silent. **FLIPPED INTO A REGRESSION (v3).**
/// @notice FLIPPED 2026-10-07 after the v3 fix.
///         Fix: an account whose equity is already NEGATIVE when `startAuctions` sees it is not
///         auctioned (nobody would pay for it) but closed out at once through the expiry path
///         (insurance → pool → bad debt), so its loss is in the lane's books immediately.
///         Residual (accepted, SECURITY_NOTES §4.5): an UNREALISED winner's gain is still not in
///         the realised books until it closes, so withdrawals before that are paid in full;
///         `test_R2_07b` documents that bound.
contract R2_07_HiddenInsolvencyFirstComeTest is ReviewBase {
    function setUp() public override {
        super.setUp();
        uint256[8] memory seed;
        seed[3] = 100e6;
        _bareClearinghouse(seed);
    }

    function test_R2_07_NegativeEquityClosedOutAtStart_NoAuctionWindow() public {
        address x = laneAddr(3, 2);
        fund(x, 50e6);
        _open(x, MON, true, 500e6, 50e6);
        _setSpot(FEED_MON, 1.8e8); // -40% gap: equity ~ -150
        (int256 ex,,,) = ch.accountHealth(x);
        assertLt(ex, -140e6);
        uint256 insBefore = _insurance(3);
        vm.recordLogs();
        assertEq(ch.startAuctions(3, _one(x), _none()), 0, "not auctioned");
        bool expiredEvent;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == CH.AuctionExpired.selector) expiredEvent = true;
        }
        assertTrue(expiredEvent, "AuctionExpired emitted at start");
        (bool active,,) = ch.auctionOf(x);
        assertFalse(active);
        assertEq(ch.getPosition(x, MON).size, 0, "closed out at once");
        assertEq(collateralOf(x), 0, "negative equity written off");
        // the lane booked x's realised loss AND the write-off in the same transaction: net, the
        // lane (counterparty) keeps x's collateral (49.75 after the opening fee)
        assertApproxEqAbs(_insurance(3) - insBefore, 49_750_000, 10, "books updated at start");
        (,,,, uint256 expired) = ch.auctionStats(3);
        assertEq(expired, 1);
        assertSolvent();
    }

    /// @notice Accepted residual: the deficit created by an UNREALISED winner is invisible until it
    ///         closes; the first withdrawer is paid in full, the later one is haircut. Bounded by the
    ///         winner's gain beyond lane insurance + pool cash.
    function test_R2_07b_ResidualUnrealisedWinner_Documented() public {
        address w = laneAddr(3, 1);
        address x = laneAddr(3, 2);
        address y = laneAddr(3, 3);
        address z = laneAddr(3, 4);
        fund(w, 100e6);
        fund(x, 50e6);
        fund(y, 1_000e6);
        fund(z, 1_000e6);
        _open(w, MON, false, 500e6, 50e6);
        _open(x, MON, true, 500e6, 50e6);
        _setSpot(FEED_MON, 1.8e8);
        assertEq(ch.startAuctions(3, _one(x), _none()), 0, "x closed out at once (R2-07 fix)");
        vm.prank(y);
        ch.withdraw(1_000e6, _none());
        _closeAll(w, MON); // the winner realises
        vm.prank(z);
        ch.withdraw(1_000e6, _none());
        assertEq(ausd.balanceOf(y), 1_000e6);
        assertLt(ausd.balanceOf(z), 1_000e6, "residual: realised later, haircut later");
        assertGt(ausd.balanceOf(z), 940e6, "bounded by the winner's excess gain");
        assertSolvent();
    }
}
