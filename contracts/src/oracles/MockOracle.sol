// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceOracle} from "../interfaces/IPriceOracle.sol";
import {Owned} from "../utils/Owned.sol";

/// @title MockOracle
/// @notice Owner/updater-driven price source for tests and the hackathon demo (e.g. the "-20%
///         flash crash" button). Implements the same IPriceOracle interface as
///         ChainlinkStreamsOracle so the clearinghouse can be pointed at either.
/// @dev Each market's price lives in its own mapping slot, so updating MON/AUSD never conflicts
///      with a transaction reading BTC/AUSD under Monad's parallel execution.
///
///      Updater allowlist: the owner can authorise extra writer keys with `setUpdater`. The keeper
///      service pushes the GBM price feed from a dedicated "price pusher" key while the operator
///      (owner) key sends the crash/recover transactions, so the two never share a nonce stream.
contract MockOracle is IPriceOracle, Owned {
    struct PriceData {
        uint192 price; // 1e18-scaled
        uint64 updatedAt;
    }

    mapping(bytes32 => PriceData) internal _prices;

    /// @notice Addresses (besides the owner) allowed to write prices.
    mapping(address => bool) public isUpdater;

    event PriceUpdated(bytes32 indexed marketId, uint256 price, uint256 updatedAt);
    event UpdaterSet(address indexed updater, bool allowed);

    error LengthMismatch();
    error PriceTooLarge(uint256 price);

    constructor(address initialOwner) Owned(initialOwner) {}

    /// @dev Owner or an allowlisted updater.
    modifier onlyUpdater() {
        if (msg.sender != owner && !isUpdater[msg.sender]) revert Unauthorized();
        _;
    }

    /// @notice Grant or revoke price-writing rights for `updater` (owner only).
    function setUpdater(address updater, bool allowed) external onlyOwner {
        if (updater == address(0)) revert ZeroAddress();
        isUpdater[updater] = allowed;
        emit UpdaterSet(updater, allowed);
    }

    function setPrice(bytes32 marketId, uint256 price) external onlyUpdater {
        _setPrice(marketId, price);
    }

    function setPrices(bytes32[] calldata marketIds, uint256[] calldata prices) external onlyUpdater {
        if (marketIds.length != prices.length) revert LengthMismatch();
        for (uint256 i; i < marketIds.length; ++i) {
            _setPrice(marketIds[i], prices[i]);
        }
    }

    /// @notice Multiply a market's price by `bps / 10_000` (e.g. 8000 = -20% crash).
    function shockPrice(bytes32 marketId, uint256 bps) external onlyUpdater {
        _shock(marketId, bps);
    }

    /// @notice Shock several markets in one transaction (the keeper's flash-crash: one oracle tx,
    ///         so every market moves in the same block).
    function shockPrices(bytes32[] calldata marketIds, uint256 bps) external onlyUpdater {
        for (uint256 i; i < marketIds.length; ++i) {
            _shock(marketIds[i], bps);
        }
    }

    function getPrice(bytes32 marketId) external view returns (uint256 price, uint256 updatedAt) {
        PriceData memory p = _prices[marketId];
        return (p.price, p.updatedAt);
    }

    function _shock(bytes32 marketId, uint256 bps) internal {
        _setPrice(marketId, (uint256(_prices[marketId].price) * bps) / 10_000);
    }

    function _setPrice(bytes32 marketId, uint256 price) internal {
        if (price > type(uint192).max) revert PriceTooLarge(price);
        _prices[marketId] = PriceData(uint192(price), uint64(block.timestamp));
        emit PriceUpdated(marketId, price, block.timestamp);
    }
}
