// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R2-08 (Medium): the loss waterfall was one-way, so LPs paid for realisation ORDER.
///        **FLIPPED INTO A REGRESSION (v3).**
/// @notice FLIPPED 2026-10-07 after the v3 fix: the netting pair leaves the LPs WHOLE.
///         Fix: pool cash consumed by the waterfall is tracked per lane (`backstopReceivable`) and
///         repaid from lane inflows (trader losses, fees, funding, `fundLane`) BEFORE insurance
///         (after bad debt). The pool's contribution is a loan to the lane.
contract R2_08_WaterfallAsymmetryTest is ReviewBase {
    uint8 internal constant L = 5;
    address internal lp = makeAddr("lp");

    function setUp() public override {
        super.setUp();
        uint256[8] memory seed;
        seed[L] = 100e6;
        _bareClearinghouse(seed);
        _lpDeposit(lp, L, 1_000e6);
    }

    function test_R2_08_ZeroNetLaneResult_LpsWhole() public {
        address w = laneAddr(L, 1);
        address x = laneAddr(L, 2);
        fund(w, 100e6);
        fund(x, 400e6);
        _open(w, MON, false, 500e6, 50e6);
        _open(x, MON, true, 500e6, 50e6);
        uint256 ins0 = _insurance(L);
        (int256 nav0,,,) = ch.backstopNav(L);

        _setSpot(FEED_MON, 1.8e8);
        _closeAll(w, MON); // the winner closes first: insurance, then the pool pays
        assertGt(ch.backstopReceivable(L), 95e6, "the pool lent ~100 to the lane");
        _closeAll(x, MON); // the loser's loss repays the pool first

        (int256 nav1,,,) = ch.backstopNav(L);
        uint256 ins1 = _insurance(L);
        assertEq(ch.backstopReceivable(L), 0, "loan repaid");
        emit log_named_decimal_int("pool NAV change (LPs)", nav1 - nav0, 6);
        emit log_named_decimal_int("insurance change", int256(ins1) - int256(ins0), 6);
        assertEq(nav1, nav0, "LPs whole");
        assertLt(ins1, ins0 + 1e6, "insurance kept only the fees");
        assertSolvent();
    }
}
