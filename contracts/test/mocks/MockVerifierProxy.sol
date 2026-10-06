// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVerifierProxy} from "../../src/interfaces/IVerifierProxy.sol";

/// @notice Test double for Chainlink's VerifierProxy: unpacks the signed-report envelope and
///         returns `reportData` without checking DON signatures. `valid = false` simulates a
///         report with bad signatures.
contract MockVerifierProxy is IVerifierProxy {
    bool public valid = true;
    bytes public lastParameterPayload;

    error InvalidSignature();

    function setValid(bool v) external {
        valid = v;
    }

    function verify(bytes calldata payload, bytes calldata parameterPayload)
        external
        payable
        returns (bytes memory)
    {
        if (!valid) revert InvalidSignature();
        lastParameterPayload = parameterPayload;
        (, bytes memory reportData,,,) = abi.decode(payload, (bytes32[3], bytes, bytes32[], bytes32[], bytes32));
        return reportData;
    }
}
