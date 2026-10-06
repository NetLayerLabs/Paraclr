// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IVerifierProxy
/// @notice Subset of Chainlink Data Streams' on-chain VerifierProxy.
/// @dev `payload` is the full signed report blob delivered by the Data Streams API:
///      abi.encode(bytes32[3] reportContext, bytes reportData, bytes32[] rs, bytes32[] ss, bytes32 rawVs).
///      On success the proxy returns the verified `reportData`. `parameterPayload` is
///      abi.encode(address feeToken) on networks where a FeeManager is configured.
interface IVerifierProxy {
    function verify(bytes calldata payload, bytes calldata parameterPayload)
        external
        payable
        returns (bytes memory verifierResponse);
}
