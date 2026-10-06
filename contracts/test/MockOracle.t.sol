// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockOracle} from "../src/oracles/MockOracle.sol";
import {Owned} from "../src/utils/Owned.sol";

/// @notice Updater allowlist: the keeper's price pusher and crash operator use separate keys.
contract MockOracleTest is Test {
    event UpdaterSet(address indexed updater, bool allowed);

    MockOracle internal oracle;
    address internal owner = makeAddr("owner");
    address internal pusher = makeAddr("pusher");
    address internal stranger = makeAddr("stranger");
    bytes32 internal constant MON = keccak256("MON/AUSD");
    bytes32 internal constant BTC = keccak256("BTC/AUSD");

    function setUp() public {
        vm.warp(1_700_000_000);
        oracle = new MockOracle(owner);
    }

    function _ids() internal pure returns (bytes32[] memory ids) {
        ids = new bytes32[](2);
        ids[0] = MON;
        ids[1] = BTC;
    }

    function _prices(uint256 a, uint256 b) internal pure returns (uint256[] memory p) {
        p = new uint256[](2);
        p[0] = a;
        p[1] = b;
    }

    function test_OwnerCanWriteWithoutBeingAnUpdater() public {
        vm.prank(owner);
        oracle.setPrice(MON, 4e16);
        (uint256 p, uint256 at) = oracle.getPrice(MON);
        assertEq(p, 4e16);
        assertEq(at, block.timestamp);
        assertFalse(oracle.isUpdater(owner));
    }

    function test_UpdaterCanWriteAllPricePaths() public {
        vm.expectEmit(true, false, false, true, address(oracle));
        emit UpdaterSet(pusher, true);
        vm.prank(owner);
        oracle.setUpdater(pusher, true);
        assertTrue(oracle.isUpdater(pusher));

        vm.startPrank(pusher);
        oracle.setPrices(_ids(), _prices(4e16, 110_000e18));
        oracle.setPrice(MON, 5e16);
        oracle.shockPrice(MON, 8_000);
        (uint256 p,) = oracle.getPrice(MON);
        assertEq(p, 4e16);
        oracle.shockPrices(_ids(), 5_000);
        vm.stopPrank();

        (p,) = oracle.getPrice(MON);
        assertEq(p, 2e16);
        (p,) = oracle.getPrice(BTC);
        assertEq(p, 55_000e18);
    }

    function test_RevertWhen_NonUpdaterWrites() public {
        vm.startPrank(stranger);
        vm.expectRevert(Owned.Unauthorized.selector);
        oracle.setPrice(MON, 1);
        vm.expectRevert(Owned.Unauthorized.selector);
        oracle.setPrices(_ids(), _prices(1, 1));
        vm.expectRevert(Owned.Unauthorized.selector);
        oracle.shockPrice(MON, 8_000);
        vm.expectRevert(Owned.Unauthorized.selector);
        oracle.shockPrices(_ids(), 8_000);
        vm.stopPrank();
    }

    function test_RevokedUpdaterLosesAccess() public {
        vm.startPrank(owner);
        oracle.setUpdater(pusher, true);
        oracle.setUpdater(pusher, false);
        vm.stopPrank();
        assertFalse(oracle.isUpdater(pusher));
        vm.prank(pusher);
        vm.expectRevert(Owned.Unauthorized.selector);
        oracle.setPrice(MON, 1);
    }

    function test_RevertWhen_UpdaterManagesUpdaters() public {
        vm.prank(owner);
        oracle.setUpdater(pusher, true);
        // Updaters write prices; only the owner manages the allowlist.
        vm.prank(pusher);
        vm.expectRevert(Owned.Unauthorized.selector);
        oracle.setUpdater(stranger, true);
        vm.prank(owner);
        vm.expectRevert(Owned.ZeroAddress.selector);
        oracle.setUpdater(address(0), true);
    }

    function test_RevertWhen_LengthMismatchOrOverflow() public {
        vm.startPrank(owner);
        vm.expectRevert(MockOracle.LengthMismatch.selector);
        oracle.setPrices(_ids(), new uint256[](1));
        uint256 tooBig = uint256(type(uint192).max) + 1;
        vm.expectRevert(abi.encodeWithSelector(MockOracle.PriceTooLarge.selector, tooBig));
        oracle.setPrice(MON, tooBig);
        vm.stopPrank();
    }
}
