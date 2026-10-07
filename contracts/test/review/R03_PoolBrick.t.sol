// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R-03 (Medium): a backstop pool is permanently bricked after an insolvency write-off.
///        **FLIPPED INTO A REGRESSION.**
/// @notice FLIPPED 2026-10-07 after the fix: the test now asserts the pool RECOVERS.
///         Fix: when a pool is flat with cash <= 0 (after the deficit is written off against the
///         lane: insurance → bad debt), all outstanding shares are retired by bumping the pool's
///         epoch (`BackstopPoolReset`). Old LPs' shares are worth exactly 0 (that is what the
///         write-off means); `backstopSharesOf` reports only current-epoch shares. The next deposit
///         starts at 1:1 and the pool takes auctions again.
contract R03_PoolBrickTest is ReviewBase {
    uint8 internal constant L = 5;
    address internal lp = makeAddr("lp");

    function _victim(uint256 salt) internal returns (address v) {
        v = laneAddr(L, salt);
        fund(v, 100e6);
        _open(v, MON, true, 1_900e6, 95e6);
    }

    function test_R03_PoolRecoversAfterWriteOff() public {
        uint256 lpShares = _lpDeposit(lp, L, 300e6);
        address v = _victim(1);
        _setSpot(FEED_MON, 2.88e8);
        ch.startAuctions(L, _one(v), _none());
        vm.roll(block.number + 3);
        assertEq(ch.backstopTakeBatch(L, _one(v), _none()), 1, "pool takes a 1,824 AUSD long");
        _setSpot(FEED_MON, 2.3e8);
        (int256 eqBefore,,,) = ch.backstopNav(L);
        assertLt(eqBefore, 0, "pool insolvent");
        assertEq(ch.backstopEpoch(L), 0);
        vm.expectEmit(true, false, false, false, address(ch));
        emit CH.BackstopPoolReset(L, 1, lpShares, 0);
        vm.prank(admin);
        ch.backstopReduce(L, MON, type(uint256).max, _none());

        (int256 eq, int256 cash,, uint256 supply) = ch.backstopNav(L);
        assertEq(eq, 0);
        assertEq(cash, 0);
        assertEq(supply, 0, "old shares retired");
        assertEq(ch.backstopEpoch(L), 1);
        assertEq(ch.backstopSharesOf(L, lp), 0, "old LP's shares are worth 0");
        (uint256 req,,) = ch.backstopWithdrawRequest(L, lp);
        assertEq(req, 0);

        // Recapitalisation works at 1:1
        address lp2 = makeAddr("lp2");
        uint256 s2 = _lpDeposit(lp2, L, 10_000e6);
        assertEq(s2, 10_000e6, "fresh epoch, 1:1");
        (eq,,, supply) = ch.backstopNav(L);
        assertEq(eq, 10_000e6);
        assertEq(supply, 10_000e6);

        // ... and the pool takes the next auction again
        address v2 = _victim(2);
        _setSpot(FEED_MON, 2.2e8);
        ch.startAuctions(L, _one(v2), _none());
        vm.roll(block.number + 3);
        assertEq(ch.backstopTakeBatch(L, _one(v2), _none()), 1, "pool alive");
        assertSolvent();
    }
}
