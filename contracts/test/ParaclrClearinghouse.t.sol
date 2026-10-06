// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ParaclrTestBase} from "./utils/ParaclrTestBase.sol";
import {ParaclrClearinghouse} from "../src/ParaclrClearinghouse.sol";
import {NaiveClearinghouseDemo} from "../src/NaiveClearinghouseDemo.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {console2} from "forge-std/console2.sol";

contract ParaclrClearinghouseTest is ParaclrTestBase {
    event Deposit(address indexed account, uint8 indexed lane, uint256 amount);
    event Liquidated(
        uint8 indexed lane,
        address indexed account,
        address indexed keeper,
        int256 equity,
        uint256 notionalClosed,
        uint256 penalty,
        uint256 badDebt
    );
    event LaneSettled(
        uint8 indexed lane,
        address indexed keeper,
        uint256 liquidated,
        uint256 skipped,
        uint256 insuranceFund,
        uint256 badDebt
    );

    address internal alice;
    address internal bob;
    address internal keeper = makeAddr("keeper");

    function setUp() public override {
        super.setUp();
        alice = laneAddr(3, 1);
        bob = laneAddr(5, 2);
    }

    // ------------------------------------------------------------------
    // Basics
    // ------------------------------------------------------------------

    function test_LaneOf() public view {
        for (uint8 lane; lane < 8; ++lane) {
            assertEq(ch.laneOf(laneAddr(lane, 42)), lane);
        }
        assertEq(ch.laneOf(address(0x1003)), 3);
    }

    function test_DepositAndWithdraw() public {
        vm.prank(admin);
        ausd.ownerMint(alice, 1_000e6);
        vm.startPrank(alice);
        ausd.approve(address(ch), type(uint256).max);

        vm.expectEmit(true, true, false, true, address(ch));
        emit Deposit(alice, 3, 1_000e6);
        ch.deposit(1_000e6);

        (int256 coll, uint8 lane, bool registered, bytes32[] memory mkts) = ch.getAccount(alice);
        assertEq(coll, 1_000e6);
        assertEq(lane, 3);
        assertTrue(registered);
        assertEq(mkts.length, 0);
        assertEq(ch.laneAccountCount(3), 1);
        assertEq(ch.getLaneAccounts(3, 0, 10)[0], alice);

        ch.withdraw(400e6);
        vm.stopPrank();
        assertEq(collateralOf(alice), 600e6);
        assertEq(ausd.balanceOf(alice), 400e6);
    }

    function test_RevertWhen_WithdrawExceedsFreeCollateral() public {
        fund(alice, 1_000e6);
        open(alice, MON, true, 500e6, 10);
        assertEq(ch.freeCollateral(alice), 500e6);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(ParaclrClearinghouse.InsufficientFreeCollateral.selector, 500e6 + 1, 500e6)
        );
        ch.withdraw(500e6 + 1);
    }

    // ------------------------------------------------------------------
    // Trading happy paths
    // ------------------------------------------------------------------

    function test_OpenLong_CloseInProfit() public {
        fund(alice, 1_000e6);
        uint256 size = open(alice, MON, true, 100e6, 10); // 1,000 AUSD notional
        assertApproxEqAbs(size, uint256(1_000e18) / 3, 1);

        ParaclrClearinghouse.Position memory p = ch.getPosition(alice, MON);
        assertTrue(p.isLong);
        assertEq(p.leverage, 10);
        assertEq(p.entryNotional, 1_000e6);
        assertEq(p.entryPrice, MON_PRICE);
        (uint256 oiLong,) = ch.openInterest(MON);
        assertEq(oiLong, 1_000e6);

        vm.prank(admin);
        oracle.setPrice(MON, 3.3e18); // +10%
        assertApproxEqAbs(ch.unrealizedPnl(alice, MON), 100e6, 1);

        vm.prank(alice);
        int256 pnl = ch.closePosition(MON);
        assertApproxEqAbs(pnl, 100e6, 1);
        assertApproxEqAbs(collateralOf(alice), 1_100e6, 1);
        (uint256 ins,,,,) = ch.getLane(3);
        assertApproxEqAbs(ins, LANE_SEED - 100e6, 1);
        (oiLong,) = ch.openInterest(MON);
        assertEq(oiLong, 0);

        vm.prank(alice);
        ch.withdraw(1_000e6);
    }

    function test_OpenShort_ProfitOnDrop() public {
        fund(bob, 1_000e6);
        open(bob, MON, false, 200e6, 5);
        vm.prank(admin);
        oracle.shockPrice(MON, 9_000); // -10%
        vm.prank(bob);
        int256 pnl = ch.closePosition(MON);
        assertApproxEqAbs(pnl, 100e6, 1);
        (, uint256 oiShort) = ch.openInterest(MON);
        assertEq(oiShort, 0);
    }

    function test_CrossMargin_HedgedBookStaysHealthy() public {
        fund(alice, 300e6);
        open(alice, MON, true, 100e6, 10);
        open(alice, BTC, false, 100e6, 10);
        (,,, bytes32[] memory mkts) = ch.getAccount(alice);
        assertEq(mkts.length, 2);

        // MON -20% hurts the long, BTC -20% pays the short: net flat, still healthy.
        vm.startPrank(admin);
        oracle.shockPrice(MON, 8_000);
        oracle.shockPrice(BTC, 8_000);
        vm.stopPrank();
        (int256 equity,,,) = ch.accountHealth(alice);
        assertApproxEqAbs(equity, 300e6, 2);
        assertFalse(ch.isLiquidatable(alice));
    }

    // ------------------------------------------------------------------
    // Reverts
    // ------------------------------------------------------------------

    function test_RevertWhen_BadOpenParams() public {
        fund(alice, 1_000e6);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(ParaclrClearinghouse.InvalidLeverage.selector, 21));
        ch.openPosition(MON, true, 10e6, 21);
        vm.expectRevert(abi.encodeWithSelector(ParaclrClearinghouse.InvalidLeverage.selector, 0));
        ch.openPosition(MON, true, 10e6, 0);
        bytes32 doge = keccak256("DOGE/AUSD");
        vm.expectRevert(abi.encodeWithSelector(ParaclrClearinghouse.MarketNotListed.selector, doge));
        ch.openPosition(doge, true, 10e6, 2);
        vm.expectRevert(
            abi.encodeWithSelector(ParaclrClearinghouse.InsufficientMargin.selector, int256(1_000e6), 2_000e6)
        );
        ch.openPosition(MON, true, 2_000e6, 2);

        ch.openPosition(MON, true, 10e6, 20); // 20x is the max and is allowed
        vm.expectRevert(abi.encodeWithSelector(ParaclrClearinghouse.PositionExists.selector, MON));
        ch.openPosition(MON, false, 10e6, 2);
        vm.expectRevert(abi.encodeWithSelector(ParaclrClearinghouse.NoPosition.selector, BTC));
        ch.closePosition(BTC);
        vm.stopPrank();
    }

    function test_RevertWhen_PriceStale() public {
        fund(alice, 1_000e6);
        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(alice);
        vm.expectPartialRevert(ParaclrClearinghouse.StalePrice.selector);
        ch.openPosition(MON, true, 10e6, 2);
    }

    function test_RevertWhen_NonOwnerAdmin() public {
        vm.expectRevert();
        ch.listMarket("SOL/AUSD");
        vm.expectRevert();
        oracle.setPrice(MON, 1);
    }

    // ------------------------------------------------------------------
    // Liquidation after a -20% flash crash
    // ------------------------------------------------------------------

    function test_Liquidation_After20PctShock() public {
        address a10x = laneAddr(3, 10); // equity 100, 10x: -20% => equity -100 (bad debt)
        address a5x = laneAddr(3, 11); // equity 105, 5x : -20% => equity 5 < mm 10 (penalty)
        address a3x = laneAddr(3, 12); // equity 100, 3x : -20% => equity 40 > mm 6 (safe)
        fund(a10x, 100e6);
        fund(a5x, 105e6);
        fund(a3x, 100e6);
        open(a10x, MON, true, 100e6, 10);
        open(a5x, MON, true, 100e6, 5);
        open(a3x, MON, true, 100e6, 3);

        address[] memory batch = new address[](3);
        batch[0] = a10x;
        batch[1] = a5x;
        batch[2] = a3x;
        assertEq(ch.getLiquidatableAccounts(3, 0, 100).length, 0);

        vm.prank(admin);
        oracle.shockPrice(MON, 8_000); // -20%

        assertTrue(ch.isLiquidatable(a10x));
        assertTrue(ch.isLiquidatable(a5x));
        assertFalse(ch.isLiquidatable(a3x));
        assertEq(ch.getLiquidatableAccounts(3, 0, 100).length, 2);

        (uint256 insBefore,,,,) = ch.getLane(3);

        vm.expectEmit(true, true, true, false, address(ch));
        emit Liquidated(3, a10x, keeper, 0, 0, 0, 0);
        vm.expectEmit(true, true, false, false, address(ch));
        emit LaneSettled(3, keeper, 2, 1, 0, 0);
        vm.prank(keeper);
        uint256 n = ch.liquidateBatch(3, batch);
        assertEq(n, 2);

        // 10x: -200 loss on 100 equity => 100 bad debt absorbed by lane-3 insurance.
        assertEq(collateralOf(a10x), 0);
        // 5x: 105 - 100 loss = 5 equity, penalty 1% of 400 = 4 (2 to keeper, 2 to lane).
        assertApproxEqAbs(collateralOf(a5x), 1e6, 2);
        assertApproxEqAbs(ch.keeperRewards(keeper), 2e6, 1);
        // 3x untouched.
        assertEq(ch.getPosition(a3x, MON).size > 0, true);
        (,,, bytes32[] memory m10) = ch.getAccount(a10x);
        assertEq(m10.length, 0);

        // Lane 3 insurance: +200 (10x loss) -100 (bad debt write-off) +100 (5x loss) +2 (penalty).
        (uint256 insAfter, uint256 debt, uint256 liqs, uint256 settledAt,) = ch.getLane(3);
        assertApproxEqAbs(insAfter, insBefore + 202e6, 3);
        assertEq(debt, 0);
        assertEq(liqs, 2);
        assertEq(settledAt, block.timestamp);

        // Other lanes untouched.
        for (uint8 lane; lane < 8; ++lane) {
            if (lane == 3) continue;
            (uint256 ins,,,,) = ch.getLane(lane);
            assertEq(ins, LANE_SEED);
        }

        vm.prank(keeper);
        uint256 claimed = ch.claimKeeperRewards();
        assertEq(ausd.balanceOf(keeper), claimed);

        address[] memory keepers = new address[](1);
        keepers[0] = keeper;
        assertSolvencyInvariant(batch, keepers);
    }

    function test_Liquidation_ShortfallBeyondInsuranceBecomesLaneDebt() public {
        // Fresh lane with no insurance: use an unfunded clearinghouse.
        ch = new ParaclrClearinghouse(admin, ausd, IPriceOracle(address(oracle)), false);
        vm.prank(admin);
        ch.listMarket("MON/AUSD");
        address t = laneAddr(6, 99);
        fund(t, 100e6);
        open(t, MON, true, 100e6, 20); // 2,000 notional
        vm.prank(admin);
        oracle.shockPrice(MON, 8_000); // -400 => equity -300

        address[] memory batch = new address[](1);
        batch[0] = t;
        vm.prank(keeper);
        ch.liquidateBatch(6, batch);
        (uint256 ins, uint256 debt,,,) = ch.getLane(6);
        // +400 loss credited, then 300 write-off debited => 100 insurance, 0 debt.
        assertApproxEqAbs(ins, 100e6, 2);
        assertEq(debt, 0);

        // Now a winner in lane 6 draws more than the lane holds => recorded as lane debt.
        address w = laneAddr(6, 100);
        fund(w, 1_000e6);
        open(w, MON, false, 1_000e6, 10);
        vm.prank(admin);
        oracle.shockPrice(MON, 9_000); // short +1,000
        vm.prank(w);
        ch.closePosition(MON);
        (ins, debt,,,) = ch.getLane(6);
        assertEq(ins, 0);
        assertApproxEqAbs(debt, 900e6, 3);

        // fundLane repays debt first.
        vm.startPrank(admin);
        ausd.ownerMint(admin, 1_000e6);
        ausd.approve(address(ch), type(uint256).max);
        ch.fundLane(6, 1_000e6);
        vm.stopPrank();
        (ins, debt,,,) = ch.getLane(6);
        assertEq(debt, 0);
        assertApproxEqAbs(ins, 100e6, 3);
    }

    // ------------------------------------------------------------------
    // Lane isolation — the parallel-execution guarantee
    // ------------------------------------------------------------------

    function test_RevertWhen_BatchContainsAccountFromAnotherLane() public {
        address lane3 = laneAddr(3, 7);
        address lane5 = laneAddr(5, 8);
        fund(lane3, 100e6);
        fund(lane5, 100e6);
        open(lane3, MON, true, 100e6, 10);
        open(lane5, MON, true, 100e6, 10);
        vm.prank(admin);
        oracle.shockPrice(MON, 8_000);

        address[] memory batch = new address[](2);
        batch[0] = lane3;
        batch[1] = lane5;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ParaclrClearinghouse.AccountNotInLane.selector, lane5, uint8(3)));
        ch.liquidateBatch(3, batch);

        // Nothing was liquidated (whole batch reverted).
        assertTrue(ch.isLiquidatable(lane3));
        assertTrue(ch.isLiquidatable(lane5));

        vm.expectRevert(abi.encodeWithSelector(ParaclrClearinghouse.InvalidLane.selector, uint8(8)));
        ch.liquidateBatch(8, new address[](0));
    }

    function test_LaneIsolation_BadDebtStaysInLane() public {
        address lane5 = laneAddr(5, 8);
        fund(lane5, 100e6);
        open(lane5, MON, true, 100e6, 20);
        vm.prank(admin);
        oracle.shockPrice(MON, 5_000); // -50% => huge loss

        address[] memory batch = new address[](1);
        batch[0] = lane5;
        vm.prank(keeper);
        ch.liquidateBatch(5, batch);

        // 2,000 notional -50% => -1,000 PnL on 100 collateral => 900 bad debt, all absorbed by
        // lane 5: its fund nets +1,000 (trader loss) - 900 (write-off) = +100.
        (uint256 ins5,, uint256 liqs5,,) = ch.getLane(5);
        (uint256 ins3,, uint256 liqs3,,) = ch.getLane(3);
        assertEq(ins3, LANE_SEED, "lane 3 untouched");
        assertEq(liqs3, 0);
        assertEq(liqs5, 1);
        assertApproxEqAbs(ins5, LANE_SEED + 100e6, 1, "lane 5 absorbed the bad debt");
    }

    /// @notice Proves the core claim with Foundry's storage-access recorder: batches for
    ///         different lanes write disjoint storage slots, and neither reads a slot the other
    ///         writes. That is exactly the condition under which Monad runs them in parallel
    ///         without re-execution.
    function test_ParallelSafety_LaneBatchesTouchDisjointStorage() public {
        address[] memory b3 = _openLaneBook(3, 6);
        address[] memory b5 = _openLaneBook(5, 6);
        vm.prank(admin);
        oracle.shockPrice(MON, 8_000);

        address keeper3 = makeAddr("keeper3");
        address keeper5 = makeAddr("keeper5");

        uint256 snap = vm.snapshotState();
        vm.record();
        vm.prank(keeper3);
        ch.liquidateBatch(3, b3);
        (bytes32[] memory r3, bytes32[] memory w3) = vm.accesses(address(ch));

        vm.revertToState(snap);
        vm.record();
        vm.prank(keeper5);
        ch.liquidateBatch(5, b5);
        (bytes32[] memory r5, bytes32[] memory w5) = vm.accesses(address(ch));

        assertGt(w3.length, 0);
        assertGt(w5.length, 0);
        _assertDisjoint(w3, w5, "write/write conflict");
        _assertDisjoint(w3, r5, "lane3 writes vs lane5 reads");
        _assertDisjoint(w5, r3, "lane5 writes vs lane3 reads");
    }

    /// @dev Storage slots one transaction read and wrote on the clearinghouse.
    struct Access {
        bytes32[] reads;
        bytes32[] writes;
    }

    /// @dev Records, from the same pre-states, the four auction-path transactions of a -20% crash
    ///      on two lanes: [0] startAuctions(3), [1] backstopTakeBatch(3), [2] startAuctions(5),
    ///      [3] backstopTakeBatch(5). Takes run 6 blocks after both lanes started (150 bps).
    function _recordAuctionPath() internal returns (Access[4] memory acc) {
        vm.startPrank(admin);
        ausd.ownerMint(admin, 8 * 50_000e6);
        for (uint8 lane; lane < 8; ++lane) {
            ch.backstopDeposit(lane, 50_000e6);
        }
        vm.stopPrank();
        address[] memory b3 = _openLaneBook(3, 6);
        address[] memory b5 = _openLaneBook(5, 6);
        vm.prank(admin);
        oracle.shockPrice(MON, 8_000);

        uint256 snap = vm.snapshotState();
        vm.record();
        vm.prank(makeAddr("keeper3"));
        assertEq(ch.startAuctions(3, b3), 6);
        (acc[0].reads, acc[0].writes) = vm.accesses(address(ch));
        vm.revertToState(snap);

        snap = vm.snapshotState();
        vm.record();
        vm.prank(makeAddr("keeper5"));
        assertEq(ch.startAuctions(5, b5), 6);
        (acc[2].reads, acc[2].writes) = vm.accesses(address(ch));
        vm.revertToState(snap);

        ch.startAuctions(3, b3);
        ch.startAuctions(5, b5);
        vm.roll(block.number + 6);

        snap = vm.snapshotState();
        vm.record();
        vm.prank(makeAddr("keeper3"));
        assertEq(ch.backstopTakeBatch(3, b3), 6);
        (acc[1].reads, acc[1].writes) = vm.accesses(address(ch));
        vm.revertToState(snap);

        snap = vm.snapshotState();
        vm.record();
        vm.prank(makeAddr("keeper5"));
        assertEq(ch.backstopTakeBatch(5, b5), 6);
        (acc[3].reads, acc[3].writes) = vm.accesses(address(ch));
        vm.revertToState(snap);
    }

    /// @notice The fair-liquidation path keeps the lane guarantee: every lane-3 auction tx
    ///         (start, backstop take) and every lane-5 auction tx touch disjoint storage — no
    ///         write/write and no read/write overlap in either direction.
    function test_ParallelSafety_AuctionPathTouchesDisjointStorage() public {
        Access[4] memory acc = _recordAuctionPath();
        for (uint256 i; i < 2; ++i) {
            for (uint256 j = 2; j < 4; ++j) {
                assertGt(acc[i].writes.length, 0);
                assertGt(acc[j].writes.length, 0);
                _assertDisjoint(acc[i].writes, acc[j].writes, "auction write/write conflict");
                _assertDisjoint(acc[i].writes, acc[j].reads, "lane3 auction writes vs lane5 reads");
                _assertDisjoint(acc[j].writes, acc[i].reads, "lane5 auction writes vs lane3 reads");
            }
        }
    }

    /// @notice The opposite claim for the naive baseline (identical code, one shared key for every
    ///         per-lane aggregate): the same lane-3 and lane-5 auction txs DO conflict.
    function test_ParallelSafety_NaiveSharedStateConflicts() public {
        _useNaive();
        Access[4] memory acc = _recordAuctionPath();
        uint256 startWW = _overlap(acc[0].writes, acc[2].writes);
        uint256 takeWW = _overlap(acc[1].writes, acc[3].writes);
        uint256 takeWR = _overlap(acc[1].writes, acc[3].reads);
        uint256 takeRW = _overlap(acc[3].writes, acc[1].reads);
        console2.log("naive: startAuctions(3) vs (5) distinct slots both write", startWW);
        console2.log("naive: backstopTakeBatch(3) vs (5) distinct slots both write", takeWW);
        assertGt(startWW, 0, "naive starts share the auction list / counters");
        assertGt(takeWW, 0, "naive takes share pool / insurance / OI / ledger");
        assertGt(takeWR, 0);
        assertGt(takeRW, 0);
    }

    /// @notice Same contrast for the legacy `liquidateBatch` path.
    function test_ParallelSafety_NaiveLegacyBatchesConflict() public {
        _useNaive();
        address[] memory b3 = _openLaneBook(3, 4);
        address[] memory b5 = _openLaneBook(5, 4);
        vm.prank(admin);
        oracle.shockPrice(MON, 8_000);
        uint256 snap = vm.snapshotState();
        vm.record();
        ch.liquidateBatch(3, b3);
        (bytes32[] memory r3, bytes32[] memory w3) = vm.accesses(address(ch));
        vm.revertToState(snap);
        vm.record();
        ch.liquidateBatch(5, b5);
        (bytes32[] memory r5, bytes32[] memory w5) = vm.accesses(address(ch));
        assertGt(_overlap(w3, w5), 0);
        assertGt(_overlap(w3, r5), 0);
        assertGt(_overlap(w5, r3), 0);
    }

    /// @dev Swap `ch` for a NaiveClearinghouseDemo with the same fixture as the base setUp.
    function _useNaive() internal {
        ch = ParaclrClearinghouse(address(new NaiveClearinghouseDemo(admin, ausd, IPriceOracle(address(oracle)))));
        assertTrue(ch.sharedState());
        vm.startPrank(admin);
        ch.listMarket("MON/AUSD");
        ch.listMarket("BTC/AUSD");
        ausd.ownerMint(admin, LANE_SEED * 8);
        ausd.approve(address(ch), type(uint256).max);
        for (uint8 lane; lane < 8; ++lane) {
            ch.fundLane(lane, LANE_SEED);
        }
        vm.stopPrank();
    }

    /// @dev Number of DISTINCT slots in `a` that also appear in `b`.
    function _overlap(bytes32[] memory a, bytes32[] memory b) internal pure returns (uint256 n) {
        for (uint256 i; i < a.length; ++i) {
            bool seen;
            for (uint256 k; k < i && !seen; ++k) {
                seen = a[k] == a[i];
            }
            if (seen) continue;
            for (uint256 j; j < b.length; ++j) {
                if (a[i] == b[j]) {
                    ++n;
                    break;
                }
            }
        }
    }

    /// @notice Demo scenario: 8 keepers clear 8 lanes after a -20% crash.
    function test_FlashCrash_EightKeepersClearEightLanes() public {
        uint256 perLane = 16;
        address[][] memory books = new address[][](8);
        address[] memory everyone = new address[](8 * perLane);
        address[] memory keepers = new address[](8);
        for (uint8 lane; lane < 8; ++lane) {
            books[lane] = _openLaneBook(lane, perLane);
            for (uint256 i; i < perLane; ++i) {
                everyone[lane * perLane + i] = books[lane][i];
            }
            keepers[lane] = makeAddr(string(abi.encodePacked("keeper", lane)));
        }
        (uint256 oiLong,) = ch.openInterest(MON);
        assertEq(oiLong, 8 * perLane * 1_000e6);

        vm.prank(admin);
        oracle.shockPrice(MON, 8_000);

        for (uint8 lane; lane < 8; ++lane) {
            assertEq(ch.getLiquidatableAccounts(lane, 0, 1_000).length, perLane);
            vm.prank(keepers[lane]);
            assertEq(ch.liquidateBatch(lane, books[lane]), perLane);
            (,, uint256 liqs,,) = ch.getLane(lane);
            assertEq(liqs, perLane);
        }
        (oiLong,) = ch.openInterest(MON);
        assertEq(oiLong, 0);
        assertSolvencyInvariant(everyone, keepers);
    }

    function test_LiquidateBatch_SkipsHealthyAndDuplicates() public {
        address a = laneAddr(2, 1);
        fund(a, 1_000e6);
        open(a, MON, true, 100e6, 10);
        vm.prank(admin);
        oracle.shockPrice(MON, 8_000);
        assertFalse(ch.isLiquidatable(a));

        address[] memory batch = new address[](2);
        batch[0] = a;
        batch[1] = a;
        vm.prank(keeper);
        assertEq(ch.liquidateBatch(2, batch), 0); // cross-margin: 1,000 collateral covers the loss
    }

    // ------------------------------------------------------------------
    // Fuzz: PnL math
    // ------------------------------------------------------------------

    function testFuzz_PnlMath(uint256 entry, uint256 exit, uint256 margin, uint256 lev, bool isLong) public {
        entry = bound(entry, 1e15, 1e24); // 0.001 .. 1,000,000 AUSD
        exit = bound(exit, 1e15, 1e24);
        margin = bound(margin, 1e6, 1e12); // 1 .. 1,000,000 AUSD
        lev = bound(lev, 1, 20);
        uint256 notional = margin * lev;

        vm.prank(admin);
        oracle.setPrice(MON, entry);
        fund(alice, margin);
        open(alice, MON, isLong, margin, lev);

        vm.prank(admin);
        oracle.setPrice(MON, exit);

        // Reference: notional * (exit - entry) / entry, sign-flipped for shorts.
        int256 expected = (int256(notional) * (int256(exit) - int256(entry))) / int256(entry);
        if (!isLong) expected = -expected;

        int256 unrealized = ch.unrealizedPnl(alice, MON);
        vm.prank(alice);
        int256 realized = ch.closePosition(MON);

        assertEq(realized, unrealized, "realized == unrealized");
        // size is rounded down once and value once: error bounded by 1 + exit/entry units.
        uint256 tol = 2 + exit / entry;
        assertApproxEqAbs(realized, expected, tol, "pnl math");

        // Collateral after close: margin + pnl, floored at 0 (shortfall written off to the lane).
        int256 expectedColl = int256(margin) + realized;
        if (expectedColl < 0) expectedColl = 0;
        assertEq(collateralOf(alice), expectedColl);

        address[] memory accts = new address[](1);
        accts[0] = alice;
        assertSolvencyInvariant(accts, new address[](0));
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev `n` accounts in `lane`, each 100 AUSD collateral, 10x long MON (1,000 notional).
    function _openLaneBook(uint8 lane, uint256 n) internal returns (address[] memory book) {
        book = new address[](n);
        for (uint256 i; i < n; ++i) {
            address t = laneAddr(lane, 10_000 + uint256(lane) * 1_000 + i);
            fund(t, 100e6);
            open(t, MON, true, 100e6, 10);
            book[i] = t;
        }
    }

    function _assertDisjoint(bytes32[] memory a, bytes32[] memory b, string memory err) internal pure {
        for (uint256 i; i < a.length; ++i) {
            for (uint256 j; j < b.length; ++j) {
                require(a[i] != b[j], err);
            }
        }
    }
}
