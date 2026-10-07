// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R-06 (Low): an "all-in" increase order passes commit and always fails at fill.
///        **FLIPPED INTO A REGRESSION.**
/// @notice FLIPPED 2026-10-07 after the fix: "deposit 50, trade 500 at 10x with all of it" now
///         FILLS. Fix: the trading fee of an increase is paid out of the order's margin (the
///         position keeps `margin − fee`); leverage is checked on the gross margin.
contract R06_AllInMarginFailsTest is ReviewBase {
    function test_R06_AllInMarginOrderFills() public {
        _betaCaps();
        address u = laneAddr(2, 1);
        fund(u, 50e6);
        uint256 id = _commit(u, MON, int256(_sizeFor(500e6, MON)), 50e6, type(uint128).max);
        _execute(id);
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Executed), "Executed");
        CH.Position memory p = ch.getPosition(u, MON);
        assertGt(p.size, 0);
        uint256 fee = 250_000; // 5 bps of ~500 AUSD, rounded up
        assertEq(p.margin, 50e6 - fee, "fee paid out of the margin");
        assertEq(collateralOf(u), int256(50e6 - fee));
        (int256 eq,, uint256 im,) = ch.accountHealth(u);
        assertGe(eq, int256(im), "at initial margin");
        // over-leverage beyond the fee is still refused (gross-margin check)
        address w = laneAddr(2, 2);
        fund(w, 50e6);
        uint256 id2 = _commit(w, MON, int256(_sizeFor(501e6, MON)), 50e6, type(uint128).max);
        _execute(id2);
        assertEq(uint8(ch.getOrder(id2).status), uint8(CH.OrderStatus.Failed), "10.02x fails");
    }
}
