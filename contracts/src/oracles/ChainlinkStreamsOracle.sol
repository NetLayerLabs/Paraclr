// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceOracle} from "../interfaces/IPriceOracle.sol";
import {IVerifierProxy} from "../interfaces/IVerifierProxy.sol";
import {Owned} from "../utils/Owned.sol";

/// @title ChainlinkStreamsOracle
/// @notice IPriceOracle adapter for Chainlink Data Streams (pull-based, sub-second reports).
///
///         Flow: an off-chain keeper (or the trader's own tx bundle) fetches a signed report from
///         the Data Streams API and calls `submitReport(signedReport)`. The report is verified
///         on-chain by Chainlink's VerifierProxy (`verifier`), decoded as a v3 (crypto) report,
///         and the benchmark price is stored against the mapped Paraclr market id.
///
/// @dev HACKATHON STUB: fee payment (FeeManager / LINK or native approval) is not wired up;
///      `feeToken` is forwarded in the parameter payload so a production deployment only needs
///      to add the approval. Each market's price is its own storage slot, so reports for
///      different feeds submitted in the same block never conflict under Monad's parallel EVM.
contract ChainlinkStreamsOracle is IPriceOracle, Owned {
    /// @notice Data Streams v3 report schema (crypto feeds). Prices are int192, 18 decimals.
    struct ReportV3 {
        bytes32 feedId;
        uint32 validFromTimestamp;
        uint32 observationsTimestamp;
        uint192 nativeFee;
        uint192 linkFee;
        uint32 expiresAt;
        int192 benchmarkPrice;
        int192 bid;
        int192 ask;
    }

    struct PriceData {
        uint192 price;
        uint64 updatedAt;
    }

    /// @notice Chainlink VerifierProxy used to authenticate signed reports.
    IVerifierProxy public verifier;
    /// @notice Token used to pay verification fees (address(0) if the network charges none).
    address public feeToken;

    /// @notice Data Streams feed id => Paraclr market id.
    mapping(bytes32 => bytes32) public marketForFeed;
    mapping(bytes32 => PriceData) internal _prices;

    event VerifierUpdated(address indexed verifier, address indexed feeToken);
    event FeedMapped(bytes32 indexed feedId, bytes32 indexed marketId);
    event ReportVerified(bytes32 indexed feedId, bytes32 indexed marketId, uint256 price, uint256 observedAt);

    error UnknownFeed(bytes32 feedId);
    error StaleReport(uint256 observedAt, uint256 lastObservedAt);
    error ReportExpired(uint256 expiresAt);
    error NonPositivePrice(int192 price);

    constructor(address initialOwner, address verifier_, address feeToken_) Owned(initialOwner) {
        verifier = IVerifierProxy(verifier_);
        feeToken = feeToken_;
        emit VerifierUpdated(verifier_, feeToken_);
    }

    function setVerifier(address verifier_, address feeToken_) external onlyOwner {
        verifier = IVerifierProxy(verifier_);
        feeToken = feeToken_;
        emit VerifierUpdated(verifier_, feeToken_);
    }

    function mapFeed(bytes32 feedId, bytes32 marketId) external onlyOwner {
        marketForFeed[feedId] = marketId;
        emit FeedMapped(feedId, marketId);
    }

    /// @notice Verify a signed Data Streams report and store its benchmark price.
    /// @param signedReport Full report blob from the Data Streams API.
    function submitReport(bytes calldata signedReport) public returns (bytes32 marketId, uint256 price) {
        bytes memory reportData = verifier.verify(signedReport, abi.encode(feeToken));
        ReportV3 memory r = abi.decode(reportData, (ReportV3));

        marketId = marketForFeed[r.feedId];
        if (marketId == bytes32(0)) revert UnknownFeed(r.feedId);
        if (r.expiresAt < block.timestamp) revert ReportExpired(r.expiresAt);
        if (r.benchmarkPrice <= 0) revert NonPositivePrice(r.benchmarkPrice);

        PriceData storage p = _prices[marketId];
        if (r.observationsTimestamp <= p.updatedAt) revert StaleReport(r.observationsTimestamp, p.updatedAt);

        price = uint256(uint192(r.benchmarkPrice));
        p.price = uint192(price);
        p.updatedAt = r.observationsTimestamp;
        emit ReportVerified(r.feedId, marketId, price, r.observationsTimestamp);
    }

    /// @notice Submit several reports in one tx (e.g. all markets before a liquidation sweep).
    function submitReports(bytes[] calldata signedReports) external {
        for (uint256 i; i < signedReports.length; ++i) {
            submitReport(signedReports[i]);
        }
    }

    function getPrice(bytes32 marketId) external view returns (uint256 price, uint256 updatedAt) {
        PriceData memory p = _prices[marketId];
        return (p.price, p.updatedAt);
    }
}
