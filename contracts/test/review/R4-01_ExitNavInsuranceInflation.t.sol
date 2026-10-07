// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R4-01 (Low): the exit NAV cap followed insurance, which a hedged pair could raise for one
///        block. **FLIPPED INTO A REGRESSION (v5).**
/// @notice FLIPPED 2026-10-07 after the v5 fix: the hedged-pair exit now nets NOTHING.
///         Original finding (v4): exits were priced at `cash + min(unrealised, insurance)`. A hedged
///         pair in the lane closed its loser first (crediting insurance and lifting the cap), a ripe
///         LP exited at the lifted NAV, then the winner closed and drained insurance back: the
///         exiting LP took its share of a gain the lane could not pay, and the LPs who stayed carried
///         it as a receivable.
///         Fix (v5): exits are priced at `cash + min(unrealised, 0)`: unrealised gains are paid to
///         LPs only once realised, so insurance no longer enters the exit price at all. Deposits are
///         still priced at the full NAV (and gated), so entry is never cheaper than exit.
contract R4_01_ExitNavInsuranceInflationTest is ReviewBase {
    uint8 internal constant L = 5;
    address internal attackerLp = makeAddr("attackerLp");
    address internal victimLp = makeAddr("victimLp");

    function setUp() public override {
        super.setUp();
        uint256[8] memory seed;
        seed[L] = 100e6;
        _bareClearinghouse(seed);
        _lpDeposit(attackerLp, L, 1_000e6);
        _lpDeposit(victimLp, L, 1_000e6);
        address v = laneAddr(L, 3);
        fund(v, 50e6);
        _open(v, MON, true, 400e6, 40e6);
        _setSpot(FEED_MON, 2.65e8);
        ch.startAuctions(L, _one(v), _none());
        vm.roll(block.number + 3);
        assertEq(ch.backstopTakeBatch(L, _one(v), _none()), 1, "pool holds a MON long at 2.65");
    }

    function test_R4_01_HedgedPairExitNetsNothing() public {
        uint256 sA = ch.backstopSharesOf(L, attackerLp);
        vm.prank(attackerLp);
        ch.backstopRequestWithdraw(L, sA);
        // the attacker's hedged SOL pair in the same lane (both orders committed in advance)
        address w = laneAddr(L, 1); // short
        address x = laneAddr(L, 2); // long
        fund(w, 100e6);
        fund(x, 100e6);
        _open(w, SOL, false, 700e6, 70e6);
        _open(x, SOL, true, 700e6, 70e6);
        vm.warp(block.timestamp + 1 hours); // request ripe
        _setSpot(FEED_MON, 4.2e8); // pool gain ~206.7 > insurance ~147
        _setSpot(FEED_SOL, 162e8); // -10%: w +70, x -70
        (int256 navBefore, int256 cashBefore,,) = ch.backstopNav(L);
        assertEq(navBefore, cashBefore, "the exit NAV counts the unrealised gain as 0");

        // baseline: the same exit without the hedged pair's help
        uint256 snap = vm.snapshotState();
        vm.prank(attackerLp);
        uint256 outPlain = ch.backstopWithdraw(L, sA, _none());
        vm.revertToState(snap);

        uint256 insBefore = _insurance(L);
        _closeAll(x, SOL); // 1) the loser first: insurance +70 ...
        assertGt(_insurance(L), insBefore + 60e6, "insurance lifted");
        (int256 navLifted,,,) = ch.backstopNav(L);
        assertEq(navLifted, navBefore, "... but the exit NAV does not move");
        vm.prank(attackerLp);
        uint256 outA = ch.backstopWithdraw(L, sA, _none()); // 2) exit in the window
        _closeAll(w, SOL); // 3) the winner: insurance back down
        assertApproxEqAbs(_insurance(L), insBefore, 2e6, "insurance net ~unchanged (fees)");

        uint256 fair = uint256(navBefore) / 2; // half of the pool's cash
        (int256 navLeft,,,) = ch.backstopNav(L);
        emit log_named_decimal_uint("attacker LP paid (gamed)", outA, 6);
        emit log_named_decimal_uint("attacker LP paid (plain exit)", outPlain, 6);
        emit log_named_decimal_int("victim LP left with (exit NAV)", navLeft, 6);
        assertEq(outA, outPlain, "the hedged pair nets nothing");
        assertEq(outA, fair, "exactly half the cash, no unrealised gain");
        assertGe(uint256(navLeft), fair, "victim not below its fair share");
        // realising the gain pays it to the LP who stayed (cash up to insurance, the rest owed)
        vm.prank(admin);
        ch.backstopReduce(L, MON, type(uint256).max, _none());
        (int256 navAfter,,,) = ch.backstopNav(L);
        uint256 rec = ch.backstopReceivable(L);
        emit log_named_decimal_int("victim LP after realising the gain", navAfter, 6);
        emit log_named_decimal_uint("plus the receivable it holds", rec, 6);
        assertGt(uint256(navAfter) + rec, fair + 200e6, "the whole gain accrues to the LP who stayed");
        assertSolvent();
    }
}
