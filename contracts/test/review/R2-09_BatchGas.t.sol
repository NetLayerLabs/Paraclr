// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R2-09 (Info): per-account gas of the batch paths (incl. the new skip checks).
///        **INFO (v3): documented in SECURITY_NOTES §4; the keeper chunks batches.** Not a finding
///        to flip; kept as a measurement.
/// @notice Measures `startAuctions`, `backstopTakeBatch` and `expireBatch` per account
///         (Foundry/Cancun gas; Monad charges more for cold state). The shipped keeper sends
///         every liquidatable account of a lane in ONE batch with no chunking. Monad's per-tx
///         limit is 30M gas.
contract R2_09_BatchGasTest is ReviewBase {
    uint8 internal constant L = 5;

    function test_R2_09_BatchGasPerAccount() public {
        _lpDeposit(makeAddr("lp"), L, 90_000e6);
        uint256 n = 60;
        address[] memory list = new address[](n);
        for (uint256 i; i < n; ++i) {
            list[i] = laneAddr(L, 1_000 + i);
            fund(list[i], 2e6);
            _open(list[i], i % 2 == 0 ? MON : SOL, true, 20e6, 2e6); // 10x minimum positions
        }
        // v3: accounts already below zero equity are closed out at start (R2-07); measure the
        // auction path with equity in (0, MM): -8%
        _setSpot(FEED_MON, 2.76e8);
        _setSpot(FEED_SOL, 165.6e8);
        uint256 g = gasleft();
        assertEq(ch.startAuctions(L, list, _none()), n);
        uint256 gStart = g - gasleft();
        vm.roll(block.number + 3);
        g = gasleft();
        uint256 taken = ch.backstopTakeBatch(L, list, _none());
        uint256 gTake = g - gasleft();
        emit log_named_uint("startAuctions gas / account", gStart / n);
        emit log_named_uint("backstopTakeBatch gas / account", gTake / n);
        emit log_named_uint("accounts per 30M tx (startAuctions)", 30_000_000 / (gStart / n));
        emit log_named_uint("taken", taken);
    }
}
