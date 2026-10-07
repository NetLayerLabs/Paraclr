// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R-07 (Low): the backing-based OI cap is bypassed with a transient pool deposit.
///        **FLIPPED INTO A REGRESSION.**
/// @notice FLIPPED 2026-10-07 after the fix: the transient deposit no longer raises the cap.
///         Fix: `laneOiCap = min(maxLaneOi, lane INSURANCE × oiCapMultiplierBps)`. Pool cash is
///         not counted (it can leave after the withdrawal delay); insurance cannot leave.
contract R07_OiCapBypassTest is ReviewBase {
    function setUp() public override {
        super.setUp();
        uint256[8] memory seed;
        seed[3] = 100e6;
        _bareClearinghouse(seed);
    }

    function test_R07_PoolDepositDoesNotInflateOiCap() public {
        assertEq(ch.laneOiCap(3, MON), 500e6);
        address lpA = makeAddr("attackerLp");
        _lpDeposit(lpA, 3, 1_000e6);
        assertEq(ch.laneOiCap(3, MON), 500e6, "pool cash does not count");
        address a = laneAddr(3, 1);
        fund(a, 600e6);
        uint256 id = _commit(a, MON, int256(_sizeFor(5_000e6, MON)), 500e6, type(uint128).max);
        _execute(id);
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Failed), "5,000 OI > 500 cap");
        (uint256 longOi,) = ch.laneOpenInterest(3, MON);
        assertEq(longOi, 0);
        // within the insurance-based cap it fills
        _open(a, MON, true, 490e6, 49e6);
        (longOi,) = ch.laneOpenInterest(3, MON);
        assertLe(longOi, ch.laneOiCap(3, MON));
    }
}
