// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ParaclrTestBase} from "./utils/ParaclrTestBase.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Gas scenarios for the fair-liquidation paths (run with `forge test --gas-report
///         --match-contract ParaclrGas`). Book: 16 accounts in lane 3, 100 AUSD collateral each,
///         10x long MON (1,000 notional), -20% crash. Pools seeded with 50k per lane.
contract ParaclrGasTest is ParaclrTestBase {
    address[] internal book;
    address internal keeper = makeAddr("keeper");

    function setUp() public override {
        super.setUp();
        vm.roll(1_000);
        vm.startPrank(admin);
        ausd.ownerMint(admin, 8 * 50_000e6);
        for (uint8 lane; lane < 8; ++lane) {
            ch.backstopDeposit(lane, 50_000e6);
        }
        vm.stopPrank();
        for (uint256 i; i < 16; ++i) {
            address t = laneAddr(3, 500 + i);
            fund(t, 100e6);
            open(t, MON, true, 100e6, 10);
            book.push(t);
        }
        vm.prank(admin);
        oracle.shockPrice(MON, 8_000);
    }

    function _first(uint256 n) internal view returns (address[] memory a) {
        a = new address[](n);
        for (uint256 i; i < n; ++i) {
            a[i] = book[i];
        }
    }

    function _measure(string memory label, uint256 before) internal view {
        console2.log(label, before - gasleft());
    }

    function test_gas_StartAuctions_1() public {
        address[] memory a = _first(1);
        vm.prank(keeper);
        uint256 g = gasleft();
        ch.startAuctions(3, a);
        _measure("startAuctions x1", g);
    }

    function test_gas_StartAuctions_16() public {
        address[] memory a = _first(16);
        vm.prank(keeper);
        uint256 g = gasleft();
        ch.startAuctions(3, a);
        _measure("startAuctions x16", g);
    }

    function test_gas_BackstopTakeBatch_1() public {
        address[] memory a = _first(1);
        ch.startAuctions(3, a);
        vm.roll(block.number + 6);
        vm.prank(keeper);
        uint256 g = gasleft();
        ch.backstopTakeBatch(3, a);
        _measure("backstopTakeBatch x1", g);
    }

    function test_gas_BackstopTakeBatch_16() public {
        address[] memory a = _first(16);
        ch.startAuctions(3, a);
        vm.roll(block.number + 6);
        vm.prank(keeper);
        uint256 g = gasleft();
        ch.backstopTakeBatch(3, a);
        _measure("backstopTakeBatch x16", g);
    }

    function test_gas_ExternalTake() public {
        address taker = laneAddr(3, 999);
        fund(taker, 10_000e6);
        address[] memory a = _first(1);
        ch.startAuctions(3, a);
        vm.roll(block.number + 4);
        vm.prank(taker);
        uint256 g = gasleft();
        ch.take(a[0]);
        _measure("take (external)", g);
    }

    function test_gas_CancelAuction() public {
        address[] memory a = _first(1);
        ch.startAuctions(3, a);
        vm.prank(admin);
        oracle.setPrice(MON, MON_PRICE);
        uint256 g = gasleft();
        ch.cancelAuction(a[0]);
        _measure("cancelAuction", g);
    }

    function test_gas_ExpireBatch_16() public {
        address[] memory a = _first(16);
        ch.startAuctions(3, a);
        vm.roll(block.number + 20);
        vm.prank(keeper);
        uint256 g = gasleft();
        ch.expireBatch(3, a);
        _measure("expireBatch x16", g);
    }

    function test_gas_LegacyLiquidateBatch_16() public {
        address[] memory a = _first(16);
        vm.prank(keeper);
        uint256 g = gasleft();
        ch.liquidateBatch(3, a);
        _measure("liquidateBatch x16 (legacy)", g);
    }

    function test_gas_BackstopDepositWithdrawReduce() public {
        address[] memory a = _first(4);
        ch.startAuctions(3, a);
        vm.roll(block.number + 6);
        ch.backstopTakeBatch(3, a); // pool now holds MON exposure
        vm.startPrank(admin);
        ausd.ownerMint(admin, 1_000e6);
        uint256 g = gasleft();
        uint256 shares = ch.backstopDeposit(3, 1_000e6);
        _measure("backstopDeposit (pool with exposure)", g);
        g = gasleft();
        ch.backstopWithdraw(3, shares);
        _measure("backstopWithdraw (pool with exposure)", g);
        (, int256[] memory sz,) = ch.backstopPositions(3);
        g = gasleft();
        ch.backstopReduce(3, MON, uint256(sz[0]) / 2);
        _measure("backstopReduce (partial)", g);
        vm.stopPrank();
        g = gasleft();
        ch.solvency();
        _measure("solvency() view", g);
    }
}
