// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockAUSD} from "../../src/MockAUSD.sol";
import {MockOracle} from "../../src/oracles/MockOracle.sol";
import {ParaclrClearinghouse} from "../../src/ParaclrClearinghouse.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";

abstract contract ParaclrTestBase is Test {
    MockAUSD internal ausd;
    MockOracle internal oracle;
    ParaclrClearinghouse internal ch;

    address internal admin = makeAddr("admin");
    bytes32 internal MON;
    bytes32 internal BTC;

    uint256 internal constant MON_PRICE = 3e18; // 3 AUSD
    uint256 internal constant BTC_PRICE = 100_000e18;
    uint256 internal constant LANE_SEED = 1_000_000e6; // insurance per lane

    function setUp() public virtual {
        vm.warp(1_700_000_000);
        ausd = new MockAUSD(admin);
        oracle = new MockOracle(admin);
        ch = _deployClearinghouse();

        vm.startPrank(admin);
        MON = ch.listMarket("MON/AUSD");
        BTC = ch.listMarket("BTC/AUSD");
        oracle.setPrice(MON, MON_PRICE);
        oracle.setPrice(BTC, BTC_PRICE);

        ausd.ownerMint(admin, LANE_SEED * 8);
        ausd.approve(address(ch), type(uint256).max);
        for (uint8 lane; lane < 8; ++lane) {
            ch.fundLane(lane, LANE_SEED);
        }
        vm.stopPrank();
    }

    /// @dev Override to run the shared fixture against a subclass (e.g. ParaclrClearinghouseDemo).
    function _deployClearinghouse() internal virtual returns (ParaclrClearinghouse) {
        return new ParaclrClearinghouse(admin, ausd, IPriceOracle(address(oracle)), false);
    }

    /// @dev Deterministic address guaranteed to live in `lane` (uint160(addr) % 8 == lane).
    function laneAddr(uint8 lane, uint256 salt) internal pure returns (address) {
        uint160 base = uint160(uint256(keccak256(abi.encode("paraclr", salt))));
        return address((base & ~uint160(7)) | uint160(lane));
    }

    function fund(address who, uint256 amount) internal {
        vm.prank(admin);
        ausd.ownerMint(who, amount);
        vm.startPrank(who);
        ausd.approve(address(ch), type(uint256).max);
        ch.deposit(amount);
        vm.stopPrank();
    }

    function open(address who, bytes32 market, bool isLong, uint256 margin, uint256 lev) internal returns (uint256) {
        vm.prank(who);
        return ch.openPosition(market, isLong, margin, lev);
    }

    function collateralOf(address who) internal view returns (int256 c) {
        (c,,,) = ch.getAccount(who);
    }

    /// @dev AUSD.balanceOf(ch) == sum(collateral) + sum(insurance) - sum(badDebt) + sum(keeperRewards)
    ///      + sum(backstop pool cash), recomputed from account state (not the ledgers), and the
    ///      on-chain `solvency()` proof agrees (surplus 0). `accounts` must list every account.
    function assertSolvencyInvariant(address[] memory accounts, address[] memory keepers) internal view {
        int256 total;
        for (uint256 i; i < accounts.length; ++i) {
            total += collateralOf(accounts[i]);
        }
        for (uint8 lane; lane < 8; ++lane) {
            (uint256 ins, uint256 debt,,,) = ch.getLane(lane);
            (, int256 poolCash,,) = ch.backstopNav(lane);
            total += int256(ins) - int256(debt) + poolCash;
        }
        for (uint256 i; i < keepers.length; ++i) {
            total += int256(ch.keeperRewards(keepers[i]));
        }
        assertEq(total, int256(ausd.balanceOf(address(ch))), "solvency invariant");
        (uint256 held, uint256 liabilities, int256 surplus, bool solvent) = ch.solvency();
        assertEq(held, ausd.balanceOf(address(ch)), "solvency().ausdHeld");
        assertEq(liabilities, held, "solvency().liabilities");
        assertEq(surplus, 0, "solvency().surplus");
        assertTrue(solvent, "solvency().solvent");
    }
}
