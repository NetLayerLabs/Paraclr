// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R-09 (Medium) and R-08 (Low): the pool's discount was insurance-funded.
///        **FLIPPED INTO REGRESSIONS.**
/// @notice FLIPPED 2026-10-07 after the fix: both extractions now net <= 0.
///         R-09 fix: the pool, like an external taker, is paid at most the trader's remaining
///         equity `min(P, max(E, 0))`; insurance never pays a discount (it only absorbs negative
///         equity, exactly as on expiry). LP withdrawals are also delayed.
///         R-08 fix: `auctionMaxDiscountBps` is capped at 5% (< the 10% pool margin) and a pool
///         with no shares never takes.
contract R08_R09_PoolDiscountExtractionTest is ReviewBase {
    function _victimIn(uint8 lane, uint256 salt) internal returns (address v) {
        v = laneAddr(lane, salt);
        fund(v, 100e6);
        _open(v, MON, true, 1_900e6, 95e6);
    }

    function test_R09_JitLpNetsNothingOnBankruptAuction_InsuranceNotDrained() public {
        uint8 lane = 4;
        address v = _victimIn(lane, 1);
        _setSpot(FEED_MON, 2.88e8); // under maintenance, equity > 0: auction starts
        assertEq(ch.startAuctions(lane, _one(v), _none()), 1);
        // v3 (R2-07): accounts already bankrupt at start are closed out at once, so the R-09 case
        // is an account that gaps into negative equity DURING its auction
        _setSpot(FEED_MON, 2.8e8); // equity ≈ -27.6 (bankrupt)
        (int256 e,,,) = ch.accountHealth(v);
        assertLt(e, 0);
        vm.roll(block.number + 19); // 475 bps

        uint256 snap = vm.snapshotState();
        vm.roll(block.number + 1);
        assertEq(ch.expireBatch(lane, _one(v), _none()), 1);
        uint256 insIfExpired = _insurance(lane);
        vm.revertToState(snap);

        address jit = makeAddr("jit");
        uint256 shares = _lpDeposit(jit, lane, 1_000e6);
        uint256 insBefore = _insurance(lane);
        assertEq(ch.backstopTakeBatch(lane, _one(v), _none()), 1);
        (, uint256 earned,) = ch.backstopStats(lane);
        assertEq(earned, 0, "a bankrupt account pays the pool nothing");
        // the lane (counterparty) receives the trader's realised loss and writes off only the
        // negative equity: net +collateral, exactly as if the auction had expired
        assertGe(_insurance(lane), insBefore, "insurance not drained");
        assertEq(_insurance(lane), insIfExpired, "same insurance outcome as letting it expire");
        vm.prank(admin);
        ch.backstopReduce(lane, MON, type(uint256).max, _none());
        uint256 out = _lpWithdraw(jit, lane, shares);
        assertLe(out, 1_000e6, "JIT LP nets <= 0");
        assertSolvent();
    }

    function test_R08_MaxDiscountCapped_EmptyPoolNeverTakes() public {
        vm.prank(admin);
        vm.expectRevert(CH.InvalidBps.selector);
        ch.setAuctionParams(25, 1_500);
        vm.prank(admin);
        vm.expectRevert(CH.InvalidBps.selector);
        ch.setAuctionParams(25, 501);
        uint8 lane = 6; // no LP shares in this lane
        address v = _victimIn(lane, 1);
        _setSpot(FEED_MON, 2.88e8);
        ch.startAuctions(lane, _one(v), _none());
        for (uint256 b; b < 20; ++b) {
            vm.roll(block.number + 1);
            assertEq(ch.backstopTakeBatch(lane, _one(v), _none()), 0, "a pool with no LPs never takes");
        }
        (, int256 cash,, uint256 supply) = ch.backstopNav(lane);
        assertEq(supply, 0);
        assertEq(cash, 0, "no orphaned discount");
    }
}
