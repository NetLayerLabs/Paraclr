// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ChainlinkStreamsOracle} from "../src/oracles/ChainlinkStreamsOracle.sol";
import {ParaclrClearinghouse} from "../src/ParaclrClearinghouse.sol";
import {MockAUSD} from "../src/MockAUSD.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {MockVerifierProxy} from "./mocks/MockVerifierProxy.sol";

contract ChainlinkStreamsOracleTest is Test {
    ChainlinkStreamsOracle internal oracle;
    MockVerifierProxy internal verifier;
    address internal admin = makeAddr("admin");
    address internal feeToken = makeAddr("LINK");
    bytes32 internal constant FEED_MON = bytes32(uint256(0x000359));
    bytes32 internal MON = keccak256("MON/AUSD");

    function setUp() public {
        vm.warp(1_700_000_000);
        verifier = new MockVerifierProxy();
        oracle = new ChainlinkStreamsOracle(admin, address(verifier), feeToken);
        vm.prank(admin);
        oracle.mapFeed(FEED_MON, MON);
    }

    function _signedReport(bytes32 feedId, int192 price, uint32 observedAt) internal view returns (bytes memory) {
        ChainlinkStreamsOracle.ReportV3 memory r = ChainlinkStreamsOracle.ReportV3({
            feedId: feedId,
            validFromTimestamp: observedAt,
            observationsTimestamp: observedAt,
            nativeFee: 0,
            linkFee: 0,
            expiresAt: uint32(block.timestamp + 1 days),
            benchmarkPrice: price,
            bid: price - 1e15,
            ask: price + 1e15
        });
        bytes32[3] memory ctx;
        return abi.encode(ctx, abi.encode(r), new bytes32[](0), new bytes32[](0), bytes32(0));
    }

    function test_SubmitReport_StoresPrice() public {
        (bytes32 m, uint256 p) = oracle.submitReport(_signedReport(FEED_MON, 3.25e18, uint32(block.timestamp)));
        assertEq(m, MON);
        assertEq(p, 3.25e18);
        (uint256 price, uint256 at) = oracle.getPrice(MON);
        assertEq(price, 3.25e18);
        assertEq(at, block.timestamp);
        assertEq(verifier.lastParameterPayload(), abi.encode(feeToken));
    }

    function test_RevertWhen_ReportStaleOrUnknownOrInvalid() public {
        oracle.submitReport(_signedReport(FEED_MON, 3e18, uint32(block.timestamp)));

        vm.expectPartialRevert(ChainlinkStreamsOracle.StaleReport.selector);
        oracle.submitReport(_signedReport(FEED_MON, 3e18, uint32(block.timestamp)));

        bytes32 unknown = bytes32(uint256(0xdead));
        vm.expectRevert(abi.encodeWithSelector(ChainlinkStreamsOracle.UnknownFeed.selector, unknown));
        oracle.submitReport(_signedReport(unknown, 3e18, uint32(block.timestamp + 1)));

        vm.expectPartialRevert(ChainlinkStreamsOracle.NonPositivePrice.selector);
        oracle.submitReport(_signedReport(FEED_MON, 0, uint32(block.timestamp + 1)));

        verifier.setValid(false);
        vm.expectRevert(MockVerifierProxy.InvalidSignature.selector);
        oracle.submitReport(_signedReport(FEED_MON, 3e18, uint32(block.timestamp + 1)));
    }

    function test_ClearinghouseTradesOnStreamsPrices() public {
        MockAUSD ausd = new MockAUSD(admin);
        ParaclrClearinghouse ch = new ParaclrClearinghouse(admin, ausd, IPriceOracle(address(oracle)), false);
        vm.prank(admin);
        ch.listMarket("MON/AUSD");
        oracle.submitReport(_signedReport(FEED_MON, 3e18, uint32(block.timestamp)));

        address trader = makeAddr("trader");
        ausd.mint(trader, 1_000e6);
        vm.startPrank(trader);
        ausd.approve(address(ch), type(uint256).max);
        ch.deposit(1_000e6);
        ch.openPosition(MON, true, 100e6, 10);
        vm.stopPrank();

        vm.warp(block.timestamp + 1);
        oracle.submitReport(_signedReport(FEED_MON, 3.3e18, uint32(block.timestamp)));
        assertApproxEqAbs(ch.unrealizedPnl(trader, MON), 100e6, 1);
        assertEq(ch.markPrice(MON), 3.3e18);
    }
}
