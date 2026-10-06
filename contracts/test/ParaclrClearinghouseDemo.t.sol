// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ParaclrTestBase} from "./utils/ParaclrTestBase.sol";
import {ParaclrClearinghouse} from "../src/ParaclrClearinghouse.sol";
import {ParaclrClearinghouseDemo} from "../src/ParaclrClearinghouseDemo.sol";
import {NaiveClearinghouseDemo} from "../src/NaiveClearinghouseDemo.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {Owned} from "../src/utils/Owned.sol";

/// @notice Demo-only seeding path used by the flash-crash benchmark.
contract ParaclrClearinghouseDemoTest is ParaclrTestBase {
    event AccountsSeeded(address indexed funder, uint256 accounts, uint256 positions, uint256 totalCollateral);

    ParaclrClearinghouseDemo internal demo;

    function _deployClearinghouse() internal override returns (ParaclrClearinghouse) {
        return new ParaclrClearinghouseDemo(admin, ausd, IPriceOracle(address(oracle)), false);
    }

    function setUp() public override {
        super.setUp();
        demo = ParaclrClearinghouseDemo(address(ch));
        // The base fixture spent the owner's AUSD on lane insurance; give it a seeding budget
        // (approval to `ch` is already max).
        vm.prank(admin);
        ausd.ownerMint(admin, 10_000_000e6);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _seed(address account, uint256 collateral, bytes32 market, bool isLong, uint256 margin, uint256 lev)
        internal
        pure
        returns (ParaclrClearinghouseDemo.SeedParams memory s)
    {
        s.account = account;
        s.collateral = collateral;
        s.positions = new ParaclrClearinghouseDemo.SeedPosition[](1);
        s.positions[0] = ParaclrClearinghouseDemo.SeedPosition(market, isLong, margin, lev);
    }

    /// @dev `perLane` accounts in every lane. Even index: 10x long MON with 100 collateral
    ///      (liquidated by -20%). Odd index: 2x long MON + 3x short BTC with ample collateral.
    function _book(uint256 perLane)
        internal
        view
        returns (ParaclrClearinghouseDemo.SeedParams[] memory seeds, address[] memory accounts)
    {
        seeds = new ParaclrClearinghouseDemo.SeedParams[](8 * perLane);
        accounts = new address[](8 * perLane);
        for (uint8 lane; lane < 8; ++lane) {
            for (uint256 i; i < perLane; ++i) {
                uint256 k = lane * perLane + i;
                address a = laneAddr(lane, 10_000 + k);
                accounts[k] = a;
                if (i % 2 == 0) {
                    seeds[k] = _seed(a, 100e6, MON, true, 100e6, 10);
                } else {
                    seeds[k].account = a;
                    seeds[k].collateral = 1_000e6;
                    seeds[k].positions = new ParaclrClearinghouseDemo.SeedPosition[](2);
                    seeds[k].positions[0] = ParaclrClearinghouseDemo.SeedPosition(MON, true, 200e6, 2);
                    seeds[k].positions[1] = ParaclrClearinghouseDemo.SeedPosition(BTC, false, 300e6, 3);
                }
            }
        }
    }

    function _noKeepers() internal pure returns (address[] memory) {
        return new address[](0);
    }

    // ------------------------------------------------------------------
    // Tests
    // ------------------------------------------------------------------

    function test_Seed_AccountsLandInTheirLanes() public {
        (ParaclrClearinghouseDemo.SeedParams[] memory seeds, address[] memory accounts) = _book(4);
        uint256 balBefore = ausd.balanceOf(admin);

        vm.expectEmit(true, false, false, true, address(ch));
        emit AccountsSeeded(admin, 32, 48, 16 * 100e6 + 16 * 1_000e6);
        vm.prank(admin);
        uint256 pulled = demo.seedAccounts(seeds);

        assertEq(pulled, 16 * 100e6 + 16 * 1_000e6);
        assertEq(balBefore - ausd.balanceOf(admin), pulled, "AUSD pulled from owner");
        for (uint8 lane; lane < 8; ++lane) {
            assertEq(ch.laneAccountCount(lane), 4, "accounts per lane");
            address[] memory page = ch.getLaneAccounts(lane, 0, 10);
            for (uint256 i; i < page.length; ++i) {
                assertEq(ch.laneOf(page[i]), lane, "natural lane");
            }
        }

        // Account state matches what deposit + openPosition would have produced.
        (int256 coll, uint8 lane0, bool registered, bytes32[] memory mkts) = ch.getAccount(accounts[0]);
        assertEq(coll, 100e6);
        assertEq(lane0, 0);
        assertTrue(registered);
        assertEq(mkts.length, 1);
        ParaclrClearinghouse.Position memory p = ch.getPosition(accounts[0], MON);
        assertTrue(p.isLong);
        assertEq(p.leverage, 10);
        assertEq(p.entryPrice, MON_PRICE);
        assertEq(p.entryNotional, 1_000e6);
        assertEq(p.margin, 100e6);
        assertEq(p.size, (1_000e6 * 1e30) / MON_PRICE);

        (,,, mkts) = ch.getAccount(accounts[1]);
        assertEq(mkts.length, 2);

        // Open interest is booked per lane exactly as for real trades.
        (uint256 oiLong, uint256 oiShort) = ch.openInterest(MON);
        assertEq(oiLong, 16 * 1_000e6 + 16 * 400e6);
        assertEq(oiShort, 0);
        (, oiShort) = ch.openInterest(BTC);
        assertEq(oiShort, 16 * 900e6);

        assertSolvencyInvariant(accounts, _noKeepers());
    }

    function test_Seed_FlashCrashLiquidatesSeededBook_InvariantHolds() public {
        (ParaclrClearinghouseDemo.SeedParams[] memory seeds, address[] memory accounts) = _book(6);
        vm.prank(admin);
        demo.seedAccounts(seeds);
        assertSolvencyInvariant(accounts, _noKeepers());

        bytes32[] memory ids = new bytes32[](2);
        ids[0] = MON;
        ids[1] = BTC;
        vm.prank(admin);
        oracle.shockPrices(ids, 8_000);

        address[] memory keepers = new address[](8);
        uint256 total;
        for (uint8 lane; lane < 8; ++lane) {
            keepers[lane] = makeAddr(string(abi.encodePacked("keeper", lane)));
            address[] memory liq = ch.getLiquidatableAccounts(lane, 0, 100);
            assertEq(liq.length, 3, "only the 10x longs are under water");
            vm.prank(keepers[lane]);
            total += ch.liquidateBatch(lane, liq);
        }
        assertEq(total, 24);
        for (uint256 i; i < accounts.length; ++i) {
            assertFalse(ch.isLiquidatable(accounts[i]));
        }
        assertSolvencyInvariant(accounts, keepers);
    }

    /// @notice Same seeded book, same crash, same auction sweep on Paraclr and on the naive
    ///         shared-state baseline: every account ends identically and the shared aggregates
    ///         equal the sum of Paraclr's per-lane aggregates. Only the storage keying differs.
    function test_NaiveBaseline_IdenticalOutcomes() public {
        (ParaclrClearinghouseDemo.SeedParams[] memory seeds, address[] memory accounts) = _book(4);
        NaiveClearinghouseDemo naive = new NaiveClearinghouseDemo(admin, ausd, IPriceOracle(address(oracle)));
        vm.startPrank(admin);
        naive.listMarket("MON/AUSD");
        naive.listMarket("BTC/AUSD");
        ausd.ownerMint(admin, LANE_SEED * 8 + 16 * 50_000e6);
        ausd.approve(address(naive), type(uint256).max);
        for (uint8 lane; lane < 8; ++lane) {
            naive.fundLane(lane, LANE_SEED);
            naive.backstopDeposit(lane, 50_000e6);
            demo.backstopDeposit(lane, 50_000e6);
        }
        demo.seedAccounts(seeds);
        naive.seedAccounts(seeds);
        vm.stopPrank();

        bytes32[] memory ids = new bytes32[](2);
        ids[0] = MON;
        ids[1] = BTC;
        vm.prank(admin);
        oracle.shockPrices(ids, 8_000);

        ParaclrClearinghouseDemo[2] memory both = [demo, ParaclrClearinghouseDemo(address(naive))];
        for (uint256 c; c < 2; ++c) {
            for (uint8 lane; lane < 8; ++lane) {
                address[] memory liq = both[c].getLiquidatableAccounts(lane, 0, 100);
                assertEq(both[c].startAuctions(lane, liq), 2);
            }
        }
        vm.roll(block.number + 6);
        for (uint256 c; c < 2; ++c) {
            for (uint8 lane; lane < 8; ++lane) {
                address[] memory list = both[c].getAuctionAccounts(lane, 0, 100);
                assertEq(list.length, 2, "per-lane auction list (naive: shared, filtered)");
                assertEq(both[c].backstopTakeBatch(lane, list), 2);
            }
        }

        for (uint256 i; i < accounts.length; ++i) {
            (int256 a,,,) = demo.getAccount(accounts[i]);
            (int256 b,,,) = naive.getAccount(accounts[i]);
            assertEq(a, b, "same per-account outcome");
        }
        uint256 ins;
        int256 cash;
        uint256 taken;
        for (uint8 lane; lane < 8; ++lane) {
            (uint256 i_,,,,) = demo.getLane(lane);
            (, int256 c_,,) = demo.backstopNav(lane);
            (uint256 t_,,) = demo.backstopStats(lane);
            ins += i_;
            cash += c_;
            taken += t_;
        }
        (uint256 nIns, uint256 nDebt,,,) = naive.getLane(5); // any lane: the shared aggregate
        (, int256 nCash,,) = naive.backstopNav(2);
        (uint256 nTaken,,) = naive.backstopStats(7);
        assertEq(nIns, ins, "shared insurance == sum of lane insurance");
        assertEq(nDebt, 0);
        assertEq(nCash, cash, "shared pool cash == sum of lane pools");
        assertEq(nTaken, taken);
        assertEq(taken, 16);
        (uint256 heldA,, int256 surplusA,) = demo.solvency();
        (uint256 heldB,, int256 surplusB,) = naive.solvency();
        assertEq(heldA, heldB);
        assertEq(surplusA, 0);
        assertEq(surplusB, 0);
    }

    function test_Seed_TopsUpExistingAccountWithoutReRegistering() public {
        address a = laneAddr(6, 1);
        fund(a, 50e6);
        ParaclrClearinghouseDemo.SeedParams[] memory seeds = new ParaclrClearinghouseDemo.SeedParams[](1);
        seeds[0] = _seed(a, 100e6, BTC, false, 100e6, 5);
        vm.prank(admin);
        demo.seedAccounts(seeds);
        assertEq(ch.laneAccountCount(6), 1);
        assertEq(collateralOf(a), 150e6);
        address[] memory accts = new address[](1);
        accts[0] = a;
        assertSolvencyInvariant(accts, _noKeepers());
    }

    function test_RevertWhen_NonOwnerSeeds() public {
        (ParaclrClearinghouseDemo.SeedParams[] memory seeds,) = _book(1);
        vm.prank(makeAddr("mallory"));
        vm.expectRevert(Owned.Unauthorized.selector);
        demo.seedAccounts(seeds);
    }

    function test_RevertWhen_SeedBreaksMarginRules() public {
        ParaclrClearinghouseDemo.SeedParams[] memory seeds = new ParaclrClearinghouseDemo.SeedParams[](1);
        address a = laneAddr(1, 7);

        // Collateral below initial margin.
        seeds[0] = _seed(a, 50e6, MON, true, 100e6, 10);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ParaclrClearinghouse.InsufficientMargin.selector, int256(50e6), 100e6));
        demo.seedAccounts(seeds);

        // Leverage above the cap.
        seeds[0] = _seed(a, 500e6, MON, true, 100e6, 21);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ParaclrClearinghouse.InvalidLeverage.selector, 21));
        demo.seedAccounts(seeds);

        // Unlisted market.
        bytes32 eth = keccak256("ETH/AUSD");
        seeds[0] = _seed(a, 500e6, eth, true, 100e6, 2);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ParaclrClearinghouse.MarketNotListed.selector, eth));
        demo.seedAccounts(seeds);

        // Zero collateral / zero address.
        seeds[0] = _seed(a, 0, MON, true, 100e6, 2);
        vm.prank(admin);
        vm.expectRevert(ParaclrClearinghouse.ZeroAmount.selector);
        demo.seedAccounts(seeds);
        seeds[0] = _seed(address(0), 500e6, MON, true, 100e6, 2);
        vm.prank(admin);
        vm.expectRevert(Owned.ZeroAddress.selector);
        demo.seedAccounts(seeds);

        // Same market twice in one account.
        seeds[0].account = a;
        seeds[0].positions = new ParaclrClearinghouseDemo.SeedPosition[](2);
        seeds[0].positions[0] = ParaclrClearinghouseDemo.SeedPosition(MON, true, 100e6, 2);
        seeds[0].positions[1] = ParaclrClearinghouseDemo.SeedPosition(MON, false, 100e6, 2);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ParaclrClearinghouse.PositionExists.selector, MON));
        demo.seedAccounts(seeds);
    }

    function test_RevertWhen_OwnerHasNotApprovedEnough() public {
        (ParaclrClearinghouseDemo.SeedParams[] memory seeds,) = _book(1);
        vm.startPrank(admin);
        ausd.approve(address(ch), 1);
        vm.expectRevert(ParaclrClearinghouse.TransferFailed.selector);
        demo.seedAccounts(seeds);
        vm.stopPrank();
    }
}
