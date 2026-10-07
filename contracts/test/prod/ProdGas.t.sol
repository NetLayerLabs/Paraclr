// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ProdTestBase} from "./ProdTestBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @notice Gas of the main production paths: `forge test --match-contract ProdGasTest --gas-report`.
///         Uses MockPyth, so Pyth's own verification cost is NOT included (see ProdForkTest /
///         contracts/README for the real-Pyth figure). Each call is its own transaction in the
///         report (21k intrinsic + cold access included).
contract ProdGasTest is ProdTestBase {
    address internal a = laneAddr(3, 1);
    address internal lp = makeAddr("lp");
    address[] internal book;

    function setUp() public override {
        super.setUp();
        fund(a, 5_000e6);
        vm.prank(admin);
        ausd.ownerMint(lp, 100_000e6);
        vm.startPrank(lp);
        ausd.approve(address(ch), type(uint256).max);
        ch.backstopDeposit(5, 50_000e6, _none());
        vm.stopPrank();
        for (uint256 i; i < 8; ++i) {
            address t = laneAddr(5, 100 + i);
            fund(t, 100e6);
            _open(t, MON, true, 1_900e6, 95e6);
            book.push(t);
        }
    }

    function test_Gas_OrderLifecycle() public {
        // increase (new position), increase (existing), partial reduce, full close
        _open(a, MON, true, 1_000e6, 100e6);
        _open(a, MON, true, 500e6, 50e6);
        uint256 half = ch.getPosition(a, MON).size / 2;
        _execute(_commit(a, MON, -int256(half), 0, 1));
        _closeAll(a, MON);
        // cancel after deadline
        uint256 id = _commit(a, SOL, int256(_sizeFor(100e6, SOL)), 10e6, type(uint128).max);
        vm.warp(ch.getOrder(id).deadline + 1);
        ch.cancelOrder(id);
        _refreshStored();
        // withdraw with and without a price update; claim
        _open(a, BTC, true, 500e6, 50e6);
        vm.prank(a);
        ch.withdraw(10e6, _none());
        bytes[] memory u = _updAll(block.timestamp);
        vm.prank(a);
        ch.withdraw(10e6, u);
        vm.prank(keeper);
        ch.claimExecutionFees();
        vm.warp(block.timestamp + 61);
        _refreshStored();
        ch.updateFunding(MON);
    }

    function test_Gas_Liquidations() public {
        _setSpot(FEED_MON, 2.88e8);
        address[] memory one = new address[](1);
        one[0] = book[0];
        ch.startAuctions(5, one, _none());
        address[] memory rest = new address[](7);
        for (uint256 i; i < 7; ++i) {
            rest[i] = book[i + 1];
        }
        ch.startAuctions(5, rest, _none());
        vm.roll(block.number + 3);
        ch.backstopTakeBatch(5, one, _none());
        ch.backstopTakeBatch(5, rest, _none());
        (bytes32[] memory pm, int256[] memory sz,) = ch.backstopPositions(5);
        vm.prank(admin);
        ch.backstopReduce(5, pm[0], uint256(sz[0]) / 2, _none());
        _lpWithdraw(lp, 5, 1_000e6);
    }

    function test_Gas_ExpireAndExternalTake() public {
        _setSpot(FEED_MON, 2.88e8);
        _lpWithdraw(lp, 5, ch.backstopSharesOf(5, lp)); // empty pool → nobody takes
        ch.startAuctions(5, book, _none());
        address taker = laneAddr(5, 999);
        fund(taker, 5_000e6);
        vm.roll(block.number + 10);
        vm.prank(taker);
        ch.take(book[0], _none());
        vm.roll(block.number + 20);
        _refreshStored();
        address[] memory rest = new address[](7);
        for (uint256 i; i < 7; ++i) {
            rest[i] = book[i + 1];
        }
        ch.expireBatch(5, rest, _none());
    }
}
