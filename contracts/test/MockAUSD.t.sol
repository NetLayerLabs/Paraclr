// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockAUSD} from "../src/MockAUSD.sol";

contract MockAUSDTest is Test {
    MockAUSD internal ausd;
    address internal admin = makeAddr("admin");
    address internal user = makeAddr("user");

    function setUp() public {
        ausd = new MockAUSD(admin);
    }

    function test_Metadata() public view {
        assertEq(ausd.decimals(), 6);
        assertEq(ausd.symbol(), "AUSD");
    }

    function test_FaucetMintUpToCap() public {
        vm.prank(user);
        ausd.mint(user, 10_000e6);
        assertEq(ausd.balanceOf(user), 10_000e6);
        assertEq(ausd.totalSupply(), 10_000e6);
    }

    function test_RevertWhen_FaucetAboveCap() public {
        vm.expectRevert(abi.encodeWithSelector(MockAUSD.MintCapExceeded.selector, 10_000e6 + 1, 10_000e6));
        ausd.mint(user, 10_000e6 + 1);
    }

    function test_OwnerMintUncapped_OnlyOwner() public {
        vm.prank(admin);
        ausd.ownerMint(user, 1_000_000e6);
        assertEq(ausd.balanceOf(user), 1_000_000e6);
        vm.expectRevert();
        ausd.ownerMint(user, 1);
    }

    function test_TransferFrom() public {
        ausd.mint(user, 100e6);
        vm.prank(user);
        ausd.approve(address(this), 60e6);
        ausd.transferFrom(user, admin, 60e6);
        assertEq(ausd.balanceOf(admin), 60e6);
        assertEq(ausd.allowance(user, address(this)), 0);
        vm.expectRevert(MockAUSD.InsufficientAllowance.selector);
        ausd.transferFrom(user, admin, 1);
    }
}
