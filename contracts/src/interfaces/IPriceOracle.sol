// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPriceOracle
/// @notice Price source consumed by the Paraclr clearinghouse.
/// @dev Prices are quoted in AUSD per 1 unit of the base asset, scaled to 1e18
///      (e.g. MON at 3.25 AUSD => 3.25e18). This matches Chainlink Data Streams'
///      18-decimal crypto report format, so no rescaling is needed on the hot path.
interface IPriceOracle {
    /// @notice Latest price for a market.
    /// @param marketId keccak256 of the market symbol, e.g. keccak256("MON/AUSD").
    /// @return price 1e18-scaled AUSD price (0 if never set).
    /// @return updatedAt Unix timestamp of the observation backing `price`.
    function getPrice(bytes32 marketId) external view returns (uint256 price, uint256 updatedAt);
}
