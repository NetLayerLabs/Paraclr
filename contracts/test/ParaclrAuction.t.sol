// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ParaclrTestBase} from "./utils/ParaclrTestBase.sol";
import {ParaclrClearinghouse} from "../src/ParaclrClearinghouse.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {Owned} from "../src/utils/Owned.sol";

/// @notice Fair liquidation: auctions, backstop pools and the solvency ledger.
contract ParaclrAuctionTest is ParaclrTestBase {
    uint256 internal constant POOL_SEED = 50_000e6;

    address internal keeper = makeAddr("keeper");
    address internal lp2 = makeAddr("lp2");

    function setUp() public override {
        super.setUp();
        vm.roll(1_000);
        vm.startPrank(admin);
        ausd.ownerMint(admin, POOL_SEED * 8);
        for (uint8 lane; lane < 8; ++lane) {
            ch.backstopDeposit(lane, POOL_SEED);
        }
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev 100 AUSD collateral, 10x long MON (1,000 notional at 3 AUSD).
    function _trader(uint8 lane, uint256 salt) internal returns (address t) {
        t = laneAddr(lane, salt);
        fund(t, 100e6);
        open(t, MON, true, 100e6, 10);
    }

    function _one(address a) internal pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = a;
    }

    function _setMon(uint256 price) internal {
        vm.prank(admin);
        oracle.setPrice(MON, price);
    }

    function _start(address a) internal {
        assertEq(ch.startAuctions(ch.laneOf(a), _one(a)), 1, "started");
    }

    function _poolCash(uint8 lane) internal view returns (int256 cash) {
        (, cash,,) = ch.backstopNav(lane);
    }

    function _ins(uint8 lane) internal view returns (uint256 ins) {
        (ins,,,,) = ch.getLane(lane);
    }

    function _debt(uint8 lane) internal view returns (uint256 debt) {
        (, debt,,,) = ch.getLane(lane);
    }

    function _assertPoolHolds(uint8 lane, int256 size, uint256 entryPrice, int256 cash) internal view {
        (bytes32[] memory pm, int256[] memory sz, uint256[] memory entry) = ch.backstopPositions(lane);
        assertEq(pm.length, 1);
        assertEq(pm[0], MON);
        assertEq(sz[0], size);
        assertEq(entry[0], entryPrice);
        (int256 eqPool, int256 c, int256 unreal,) = ch.backstopNav(lane);
        assertEq(c, cash, "pool cash");
        assertEq(unreal, 0, "inherited at mark");
        assertEq(eqPool, cash);
    }

    function _assertBooksBalance() internal view {
        (uint256 held, uint256 liabilities, int256 surplus, bool solvent) = ch.solvency();
        assertEq(held, ausd.balanceOf(address(ch)), "held");
        assertEq(surplus, 0, "surplus");
        assertEq(liabilities, held, "liabilities == held");
        assertTrue(solvent, "solvent");
        // Independent recomputation from the per-lane ledgers.
        int256 total;
        for (uint8 lane; lane < 8; ++lane) {
            (int256 coll, uint256 ins, int256 cash, uint256 kr, uint256 debt) = ch.laneLedger(lane);
            total += coll + int256(ins) + cash + int256(kr) - int256(debt);
        }
        assertEq(total, int256(held), "sum(laneLedger) == AUSD held");
    }

    // ------------------------------------------------------------------
    // Start + freeze
    // ------------------------------------------------------------------

    function test_StartAuctions_OnlyUnderwater_SkipsHealthyAndActive() public {
        address u = _trader(3, 1);
        address h = laneAddr(3, 2);
        fund(h, 1_000e6);
        open(h, MON, true, 100e6, 10);
        address none = laneAddr(3, 3); // never registered
        _setMon(2.76e18); // -8%: u equity ~20 < mm ~23

        address[] memory batch = new address[](3);
        batch[0] = u;
        batch[1] = h;
        batch[2] = none;
        (int256 eq,,, uint256 notional) = ch.accountHealth(u);
        vm.expectEmit(true, true, false, true, address(ch));
        emit ParaclrClearinghouse.AuctionStarted(3, u, block.number, eq, notional);
        assertEq(ch.startAuctions(3, batch), 1);
        // Already active: skipped.
        assertEq(ch.startAuctions(3, batch), 0);

        (bool active, uint64 startBlock, uint16 d) = ch.auctionOf(u);
        assertTrue(active);
        assertEq(startBlock, block.number);
        assertEq(d, 0);
        (active,,) = ch.auctionOf(h);
        assertFalse(active);

        address[] memory list = ch.getAuctionAccounts(3, 0, 10);
        assertEq(list.length, 1);
        assertEq(list[0], u);
        (uint256 act, uint256 started,,,) = ch.auctionStats(3);
        assertEq(act, 1);
        assertEq(started, 1);
        // getLiquidatableAccounts no longer reports it (it is already being auctioned).
        assertEq(ch.getLiquidatableAccounts(3, 0, 10).length, 0);
    }

    function test_RevertWhen_StartAuctionsOutOfLane() public {
        address u3 = _trader(3, 1);
        address u5 = _trader(5, 2);
        _setMon(2.4e18);
        address[] memory batch = new address[](2);
        batch[0] = u3;
        batch[1] = u5;
        vm.expectRevert(abi.encodeWithSelector(ParaclrClearinghouse.AccountNotInLane.selector, u5, uint8(3)));
        ch.startAuctions(3, batch);
        vm.expectRevert(abi.encodeWithSelector(ParaclrClearinghouse.InvalidLane.selector, uint8(8)));
        ch.startAuctions(8, batch);
    }

    function test_Freeze_NoWithdrawOpenClose_DepositAllowed() public {
        address u = laneAddr(4, 1);
        fund(u, 200e6);
        open(u, MON, true, 100e6, 20); // 2,000 notional on 200 collateral
        _setMon(2.73e18); // -9%: equity 200-180 = 20 < mm 45.5
        _start(u);
        assertEq(ch.freeCollateral(u), 0);

        vm.startPrank(u);
        vm.expectRevert(abi.encodeWithSelector(ParaclrClearinghouse.AccountInAuction.selector, u));
        ch.withdraw(1);
        vm.expectRevert(abi.encodeWithSelector(ParaclrClearinghouse.AccountInAuction.selector, u));
        ch.openPosition(BTC, false, 10e6, 2);
        vm.expectRevert(abi.encodeWithSelector(ParaclrClearinghouse.AccountInAuction.selector, u));
        ch.closePosition(MON);
        vm.stopPrank();

        // Deposits are allowed (that is how a trader cures).
        vm.prank(admin);
        ausd.ownerMint(u, 1_000e6);
        vm.prank(u);
        ch.deposit(1_000e6);
        assertEq(collateralOf(u), 1_200e6);
        _assertBooksBalance();
    }

    // ------------------------------------------------------------------
    // Discount clock
    // ------------------------------------------------------------------

    function test_DiscountClock() public {
        address u = _trader(2, 1);
        _setMon(2.4e18);
        _start(u);
        uint256 b0 = block.number;
        uint16[6] memory expected = [uint16(0), 25, 150, 475, 500, 500];
        uint256[6] memory blocks = [uint256(0), 1, 6, 19, 20, 1_000];
        for (uint256 i; i < 6; ++i) {
            vm.roll(b0 + blocks[i]);
            (,, uint16 d) = ch.auctionOf(u);
            assertEq(d, expected[i]);
        }
        // Owner-configurable.
        vm.prank(admin);
        ch.setAuctionParams(50, 1_000);
        vm.roll(b0 + 6);
        (,, uint16 d2) = ch.auctionOf(u);
        assertEq(d2, 300);
    }

    function test_RevertWhen_BadAuctionParamsOrNonOwner() public {
        vm.startPrank(admin);
        vm.expectRevert(ParaclrClearinghouse.InvalidBps.selector);
        ch.setAuctionParams(0, 500);
        vm.expectRevert(ParaclrClearinghouse.InvalidBps.selector);
        ch.setAuctionParams(100, 50);
        vm.expectRevert(ParaclrClearinghouse.InvalidBps.selector);
        ch.setAuctionParams(25, 5_001);
        vm.expectRevert(ParaclrClearinghouse.InvalidBps.selector);
        ch.setBackstopMinDiscount(0, 10_001);
        vm.stopPrank();
        vm.expectRevert(Owned.Unauthorized.selector);
        ch.setAuctionParams(25, 500);
        vm.expectRevert(Owned.Unauthorized.selector);
        ch.setBackstopMinDiscount(0, 100);
        vm.expectRevert(Owned.Unauthorized.selector);
        ch.setBackstopOperator(keeper, true);
    }

    // ------------------------------------------------------------------
    // Backstop takes: E >= P, 0 <= E < P, E < 0
    // ------------------------------------------------------------------

    function test_BackstopTake_WaitsForMinDiscount() public {
        address u = _trader(1, 1);
        _setMon(2.4e18);
        _start(u);
        assertEq(ch.backstopMinDiscountBps(1), 75, "default: 75 bps, below the 1% legacy fee");
        vm.roll(block.number + 2); // 50 bps
        assertEq(ch.backstopTakeBatch(1, _one(u)), 0);
        vm.roll(block.number + 1); // 75 bps = 3 blocks at 25 bps/block
        assertEq(ch.backstopTakeBatch(1, _one(u)), 1);
        (bool active,,) = ch.auctionOf(u);
        assertFalse(active);
        // Taking again is a no-op.
        assertEq(ch.backstopTakeBatch(1, _one(u)), 0);
    }

    function test_BackstopTake_EquityAbovePayment_TraderKeepsResidual() public {
        address u = _trader(3, 1);
        _setMon(2.76e18); // -8%
        (int256 e,,, uint256 n) = ch.accountHealth(u);
        assertGt(e, 0);
        _start(u);
        vm.roll(block.number + 3); // 75 bps: the default pool threshold
        uint256 p = (n * 75) / 10_000;
        assertGe(e, int256(p), "E >= P");

        uint256 insBefore = _ins(3);
        int256 cashBefore = _poolCash(3);
        uint256 held = ausd.balanceOf(address(ch));
        ParaclrClearinghouse.Position memory pos = ch.getPosition(u, MON);

        vm.expectEmit(true, true, true, true, address(ch));
        emit ParaclrClearinghouse.AuctionTaken(3, u, keeper, true, 75, 3, n, uint256(e) - p, p, 0);
        vm.prank(keeper);
        assertEq(ch.backstopTakeBatch(3, _one(u)), 1);

        // Trader: positions gone, keeps E - P as free collateral, unfrozen.
        assertEq(collateralOf(u), e - int256(p));
        (,,, bytes32[] memory mkts) = ch.getAccount(u);
        assertEq(mkts.length, 0);
        assertEq(ch.freeCollateral(u), uint256(e) - p);
        vm.prank(u);
        ch.withdraw(uint256(e) - p);

        // Pool: inherited the long at mark, +P cash.
        _assertPoolHolds(3, int256(pos.size), 2.76e18, cashBefore + int256(p));
        {
            (uint256 taken, uint256 earned, uint256 absorbed) = ch.backstopStats(3);
            assertEq(taken, 1);
            assertEq(earned, p);
            assertEq(absorbed, n);
        }

        // Lane: realized the trader's -80 loss, paid nothing for the auction.
        assertEq(_ins(3), insBefore + uint256(int256(100e6) - e));
        // Open interest moved from the trader to the pool (same lane, re-booked at mark).
        (uint256 oiLong,) = ch.laneOpenInterest(3, MON);
        assertEq(oiLong, (pos.size * 2.76e18) / 1e30);
        // No AUSD moved during the take.
        assertEq(ausd.balanceOf(address(ch)), held - (uint256(e) - p));
        _assertBooksBalance();
    }

    function test_BackstopTake_EquityBelowPayment_LanePaysShortfall() public {
        address u = _trader(3, 1);
        _setMon(2.76e18); // E ~20
        (int256 e,,, uint256 n) = ch.accountHealth(u);
        _start(u);
        vm.roll(block.number + 10); // 250 bps -> P ~23 > E
        uint256 p = (n * 250) / 10_000;
        assertGt(int256(p), e);
        assertGe(e, 0);
        uint256 shortfall = p - uint256(e);
        uint256 insBefore = _ins(3);
        int256 cashBefore = _poolCash(3);

        vm.expectEmit(true, true, true, true, address(ch));
        emit ParaclrClearinghouse.AuctionTaken(3, u, keeper, true, 250, 10, n, 0, p, shortfall);
        vm.prank(keeper);
        ch.backstopTakeBatch(3, _one(u));

        assertEq(collateralOf(u), 0, "trader keeps max(0, E - P) = 0");
        assertEq(_poolCash(3), cashBefore + int256(p), "pool receives the full P");
        // Lane: +trader loss (100 - E), -shortfall.
        assertEq(_ins(3), insBefore + uint256(int256(100e6) - e) - shortfall);
        _assertBooksBalance();
    }

    function test_BackstopTake_NegativeEquity_LaneAbsorbsPMinusE() public {
        address u = _trader(6, 1);
        _setMon(2.4e18); // -20%: E ~ -100
        (int256 e,,, uint256 n) = ch.accountHealth(u);
        assertLt(e, 0);
        _start(u);
        vm.roll(block.number + 6);
        uint256 p = (n * 150) / 10_000;
        uint256 shortfall = p + uint256(-e);
        uint256 insBefore = _ins(6);

        vm.expectEmit(true, true, true, true, address(ch));
        emit ParaclrClearinghouse.BadDebtRealized(6, u, uint256(-e));
        vm.expectEmit(true, true, true, true, address(ch));
        emit ParaclrClearinghouse.AuctionTaken(6, u, keeper, true, 150, 6, n, 0, p, shortfall);
        vm.prank(keeper);
        ch.backstopTakeBatch(6, _one(u));

        assertEq(collateralOf(u), 0);
        // Lane: +100 (trader's whole collateral lost) - (P - E) where E < 0  => +100 - 100 - P... :
        // realized loss 100 - e, then shortfall P - e.
        assertEq(_ins(6), insBefore + uint256(int256(100e6) - e) - shortfall);
        _assertBooksBalance();
    }

    function test_Take_ShortfallBeyondInsuranceIsLaneBadDebt() public {
        // Fresh clearinghouse whose lane 6 has no insurance, but a funded pool.
        ch = new ParaclrClearinghouse(admin, ausd, IPriceOracle(address(oracle)), false);
        vm.startPrank(admin);
        ch.listMarket("MON/AUSD");
        ausd.ownerMint(admin, POOL_SEED);
        ausd.approve(address(ch), type(uint256).max);
        ch.backstopDeposit(6, POOL_SEED);
        vm.stopPrank();
        _setMon(MON_PRICE);

        // A winner drains lane 6 first: the -20% pays this short 200 from an empty fund.
        address w = laneAddr(6, 2);
        fund(w, 1_000e6);
        open(w, MON, false, 100e6, 10);
        address u = _trader(6, 1);
        _setMon(2.4e18); // trader loses 200 on 100 => E = -100
        vm.prank(w);
        ch.closePosition(MON);
        uint256 debt0 = _debt(6);
        assertGt(debt0, 0);
        (int256 e,,, uint256 n) = ch.accountHealth(u);
        _start(u);
        vm.roll(block.number + 6);
        uint256 p = (n * 150) / 10_000;
        vm.prank(keeper);
        ch.backstopTakeBatch(6, _one(u));

        // Lane: the trader's realized loss (100 - E) repays debt, then P - E is debited from an
        // empty fund and recorded as lane bad debt.
        assertEq(_ins(6), 0);
        assertEq(_debt(6), debt0 - uint256(int256(100e6) - e) + (p + uint256(-e)));
        assertEq(_poolCash(6), int256(POOL_SEED + p));
        _assertBooksBalance();

        // Next inflow repays the lane debt first.
        vm.startPrank(admin);
        ausd.ownerMint(admin, 1_000e6);
        ch.fundLane(6, 1_000e6);
        vm.stopPrank();
        assertEq(_debt(6), 0);
        _assertBooksBalance();
    }

    struct FuzzSnap {
        int256 e;
        uint256 n;
        uint256 p;
        uint256 held;
        uint256 ins;
        int256 cash;
    }

    function testFuzz_TakeSettlement(uint256 collateral, uint256 lev, uint256 dropBps, uint256 blocks, bool backstop)
        public
    {
        collateral = bound(collateral, 50e6, 50_000e6);
        lev = bound(lev, 2, 20);
        dropBps = bound(dropBps, 300, 4_000); // -3% .. -40%
        blocks = bound(blocks, 0, 40);

        address u = laneAddr(5, 77);
        fund(u, collateral);
        open(u, MON, true, collateral / 2, lev);
        _setMon((MON_PRICE * (10_000 - dropBps)) / 10_000);
        if (!ch.isLiquidatable(u)) return;
        FuzzSnap memory f;
        (f.e,,, f.n) = ch.accountHealth(u);
        _start(u);
        vm.roll(block.number + blocks);
        (,, uint16 d) = ch.auctionOf(u);
        f.p = (f.n * d) / 10_000;
        address taker = laneAddr(5, 78);
        if (!backstop) fund(taker, f.n * 2); // ample margin for the inherited leg
        f.held = ausd.balanceOf(address(ch));
        f.ins = _ins(5);
        f.cash = _poolCash(5);

        if (backstop) {
            vm.prank(admin);
            ch.setBackstopMinDiscount(5, 0);
            vm.prank(keeper);
            if (ch.backstopTakeBatch(5, _one(u)) == 0) return; // pool could not carry it
            assertEq(_poolCash(5), f.cash + int256(f.p), "pool paid P");
        } else {
            // External takers are paid only from the trader's own equity: min(P, max(E, 0)).
            uint256 capped = f.e <= 0 ? 0 : (uint256(f.e) < f.p ? uint256(f.e) : f.p);
            vm.prank(taker);
            assertEq(ch.take(u), capped, "external payment = min(P, max(E,0))");
            assertEq(collateralOf(taker), int256(f.n * 2 + capped), "taker paid the capped amount");
            assertLe(int256(capped), f.e > 0 ? f.e : int256(0), "never more than the trader's equity");
        }

        // Trader never loses more than E: keeps exactly max(0, E - P), never negative (for both
        // takers: the external cap only changes who funds P, never the trader's residual).
        int256 expectedResidual = f.e > int256(f.p) ? f.e - int256(f.p) : int256(0);
        assertEq(collateralOf(u), expectedResidual, "residual");
        assertGe(collateralOf(u), 0);
        // Lane: +realized trader loss (collateral - E), minus what it funds: max(0, P - E) for the
        // pool, only the negative equity max(0, -E) for an external taker.
        uint256 shortfall =
            backstop ? (f.e < int256(f.p) ? uint256(int256(f.p) - f.e) : 0) : (f.e < 0 ? uint256(-f.e) : 0);
        assertEq(
            int256(_ins(5)) - int256(_debt(5)), int256(f.ins) + (int256(collateral) - f.e) - int256(shortfall), "lane"
        );
        // AUSD conserved: a take moves no tokens, and the books still balance.
        assertEq(ausd.balanceOf(address(ch)), f.held);
        _assertBooksBalance();
    }

    // ------------------------------------------------------------------
    // External taker (same lane only)
    // ------------------------------------------------------------------

    function test_ExternalTake_SameLaneInheritsAtMark() public {
        address u = _trader(2, 1);
        address taker = laneAddr(2, 50);
        fund(taker, 1_000e6);
        _setMon(2.76e18);
        (int256 e,,, uint256 n) = ch.accountHealth(u);
        ParaclrClearinghouse.Position memory src = ch.getPosition(u, MON);
        _start(u);
        vm.roll(block.number + 2); // 50 bps: below the pool's default 75, external takers may go first
        uint256 p = (n * 50) / 10_000;

        vm.expectEmit(true, true, true, true, address(ch));
        emit ParaclrClearinghouse.AuctionTaken(2, u, taker, false, 50, 2, n, uint256(e) - p, p, 0);
        vm.prank(taker);
        assertEq(ch.take(u), p);

        ParaclrClearinghouse.Position memory got = ch.getPosition(taker, MON);
        assertTrue(got.isLong);
        assertEq(got.size, src.size);
        assertEq(got.entryPrice, 2.76e18, "taker entry = mark");
        assertEq(got.leverage, src.leverage);
        assertEq(got.entryNotional, n);
        assertEq(got.margin, (n + 9) / 10);
        assertEq(ch.unrealizedPnl(taker, MON), 0);
        assertEq(collateralOf(taker), int256(1_000e6 + p));
        assertEq(collateralOf(u), e - int256(p));
        (,, uint256 tk,,) = ch.auctionStats(2);
        assertEq(tk, 1);
        _assertBooksBalance();
    }

    function test_ExternalTake_CappedAtEquity_WhenEquityBelowPayment() public {
        address u = _trader(2, 1);
        address taker = laneAddr(2, 50);
        fund(taker, 1_000e6);
        _setMon(2.76e18); // E ~20
        (int256 e,,, uint256 n) = ch.accountHealth(u);
        _start(u);
        vm.roll(block.number + 10); // 250 bps: P ~23 > E
        uint256 p = (n * 250) / 10_000;
        assertGt(int256(p), e);
        assertGe(e, 0);
        uint256 insBefore = _ins(2);

        // The taker gets E (all the trader has), not P; the lane funds nothing.
        vm.expectEmit(true, true, true, true, address(ch));
        emit ParaclrClearinghouse.AuctionTaken(2, u, taker, false, 250, 10, n, 0, uint256(e), 0);
        vm.prank(taker);
        assertEq(ch.take(u), uint256(e));
        assertEq(collateralOf(taker), int256(1_000e6) + e);
        assertEq(collateralOf(u), 0, "trader keeps max(0, E - P) = 0, as with the pool");
        assertEq(_ins(2), insBefore + uint256(int256(100e6) - e), "lane: realized loss only, no subsidy");
        _assertBooksBalance();
    }

    function test_ExternalTake_NegativeEquity_PaysZero_LaneCoversOnlyNegativeEquity() public {
        address u = _trader(2, 1);
        address taker = laneAddr(2, 50);
        fund(taker, 1_000e6);
        _setMon(2.4e18); // E ~ -100
        (int256 e,,, uint256 n) = ch.accountHealth(u);
        assertLt(e, 0);
        _start(u);
        vm.roll(block.number + 6);
        uint256 insBefore = _ins(2);

        vm.expectEmit(true, true, true, true, address(ch));
        emit ParaclrClearinghouse.BadDebtRealized(2, u, uint256(-e));
        vm.expectEmit(true, true, true, true, address(ch));
        emit ParaclrClearinghouse.AuctionTaken(2, u, taker, false, 150, 6, n, 0, 0, uint256(-e));
        vm.prank(taker);
        assertEq(ch.take(u), 0);
        assertEq(collateralOf(taker), int256(1_000e6));
        assertEq(collateralOf(u), 0);
        // Lane: +realized loss (100 - E) - negative equity |E| = +100 (the trader's deposit).
        assertEq(_ins(2), insBefore + 100e6);
        assertEq(ch.unrealizedPnl(taker, MON), 0, "inherited at mark");
        _assertBooksBalance();
    }

    /// @dev One party controls A (bankrupt, lane 3), T (same-lane taker) and H (opposite hedge in
    ///      lane 4, so the market move nets out). Returns the party's AUSD claims after
    ///      everything is closed at mark, minus what it deposited.
    function _attackProfit(address a, address t, address h, uint256 deposits) internal view returns (int256) {
        return collateralOf(a) + collateralOf(t) + collateralOf(h) + int256(ch.keeperRewards(h)) - int256(deposits);
    }

    function _attackSetup(uint256 lev) internal returns (address a, address t, address h, uint256 deposits) {
        a = laneAddr(3, 900);
        t = laneAddr(3, 901);
        h = laneAddr(4, 902);
        fund(a, 100e6);
        fund(t, 10_000e6);
        fund(h, 10_000e6);
        open(a, MON, true, 100e6, lev);
        open(h, MON, false, 100e6, lev); // identical size: H gains exactly what A loses
        deposits = 100e6 + 20_000e6;
    }

    function _closeAttack(address t, address h) internal {
        vm.prank(h);
        ch.closePosition(MON);
        (,,, bytes32[] memory mkts) = ch.getAccount(t);
        if (mkts.length > 0) {
            vm.prank(t);
            ch.closePosition(MON); // the inherited leg, at the same mark: PnL 0
        }
    }

    /// @notice The self-liquidation exploit (0 <= E < P): under an uncapped rule the party would
    ///         pull P - E out of the lane fund. With the cap it nets nothing.
    function test_SelfLiquidationAttack_NetsNothingFromLane() public {
        (address a, address t, address h, uint256 deposits) = _attackSetup(20); // 2,000 notional
        _setMon(2.862e18); // -4.6%: A's E = 100 - 92 = 8 < mm ~47.7
        (int256 e,,, uint256 n) = ch.accountHealth(a);
        _start(a);
        vm.roll(block.number + 20); // max discount: P = 5% of ~1,908 = ~95 >> E
        uint256 p = (n * 500) / 10_000;
        assertGt(p, uint256(e) + 80e6, "uncapped rule would hand the party P - E > 80 AUSD");
        int256 lanesBefore = int256(_ins(3)) - int256(_debt(3)) + int256(_ins(4)) - int256(_debt(4));

        vm.prank(t);
        assertEq(ch.take(a), uint256(e), "capped at E");
        _closeAttack(t, h);

        assertLe(_attackProfit(a, t, h, deposits), 0, "attack nets <= 0");
        int256 lanesAfter = int256(_ins(3)) - int256(_debt(3)) + int256(_ins(4)) - int256(_debt(4));
        assertGe(lanesAfter, lanesBefore, "lanes did not fund the party");
        _assertBooksBalance();
    }

    /// @notice Fuzzed self-liquidation: for E >= 0 the party nets <= 0; for E < 0 (a price gap
    ///         below zero equity) it gets no more than the negative-equity write-off that the
    ///         no-taker path (expiry, with the party as the caller) gives anyway.
    function testFuzz_SelfLiquidationAttack_NoLaneSubsidy(uint256 lev, uint256 dropBps, uint256 blocks) public {
        lev = bound(lev, 5, 20);
        dropBps = bound(dropBps, 200, 3_000);
        blocks = bound(blocks, 0, 30);
        (address a, address t, address h, uint256 deposits) = _attackSetup(lev);
        _setMon((MON_PRICE * (10_000 - dropBps)) / 10_000);
        if (!ch.isLiquidatable(a)) return;
        _start(a);
        uint256 startBlock = block.number;
        vm.roll(startBlock + blocks);
        (int256 e,,,) = ch.accountHealth(a);

        uint256 snap = vm.snapshotState();
        vm.prank(t);
        ch.take(a);
        _closeAttack(t, h);
        int256 viaTake = _attackProfit(a, t, h, deposits);
        _assertBooksBalance();

        vm.revertToState(snap);
        vm.roll(startBlock + 20);
        vm.prank(h);
        ch.expireBatch(3, _one(a));
        _closeAttack(t, h);
        int256 viaExpiry = _attackProfit(a, t, h, deposits);

        if (e >= 0) assertLe(viaTake, 0, "E >= 0: self-take nets <= 0");
        else assertLe(viaTake, viaExpiry, "E < 0: no more than the write-off every path gives");
    }

    function test_RevertWhen_ExternalTakeInvalid() public {
        address u = _trader(2, 1);
        address other = laneAddr(4, 9); // different lane
        fund(other, 10_000e6);
        address unregistered = laneAddr(2, 10);
        address poor = laneAddr(2, 11);
        fund(poor, 1e6);
        address clash = laneAddr(2, 12); // already holds MON
        fund(clash, 10_000e6);
        open(clash, MON, false, 10e6, 1);
        address rich = laneAddr(2, 13);
        fund(rich, 10_000e6);

        vm.prank(rich);
        vm.expectRevert(abi.encodeWithSelector(ParaclrClearinghouse.NotInAuction.selector, u));
        ch.take(u);

        address frozen = _trader(2, 14);
        _setMon(2.4e18);
        _start(u);
        _start(frozen);

        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(ParaclrClearinghouse.AccountNotInLane.selector, other, uint8(2)));
        ch.take(u);
        vm.prank(unregistered);
        vm.expectRevert(abi.encodeWithSelector(ParaclrClearinghouse.NotRegistered.selector, unregistered));
        ch.take(u);
        vm.prank(u);
        vm.expectRevert(ParaclrClearinghouse.SelfTake.selector);
        ch.take(u);
        vm.prank(clash);
        vm.expectRevert(abi.encodeWithSelector(ParaclrClearinghouse.PositionExists.selector, MON));
        ch.take(u);
        vm.prank(poor);
        vm.expectPartialRevert(ParaclrClearinghouse.InsufficientMargin.selector);
        ch.take(u);

        // A taker that is itself in auction is frozen.
        vm.prank(frozen);
        vm.expectRevert(abi.encodeWithSelector(ParaclrClearinghouse.AccountInAuction.selector, frozen));
        ch.take(u);

        // Price recovers: the account is healthy, nobody may take it at a discount.
        _setMon(MON_PRICE);
        vm.prank(rich);
        vm.expectRevert(abi.encodeWithSelector(ParaclrClearinghouse.NotLiquidatable.selector, u));
        ch.take(u);
    }

    // ------------------------------------------------------------------
    // Cure + expiry
    // ------------------------------------------------------------------

    function test_Cancel_AfterTopUp() public {
        address u = _trader(7, 1);
        _setMon(2.76e18);
        _start(u);
        assertFalse(ch.cancelAuction(u), "still underwater");
        vm.prank(admin);
        ausd.ownerMint(u, 100e6);
        vm.prank(u);
        ch.deposit(100e6);
        assertFalse(ch.cancelAuction(makeAddr("anyone")), "not in auction");
        vm.expectEmit(true, true, false, true, address(ch));
        emit ParaclrClearinghouse.AuctionCancelled(7, u);
        assertTrue(ch.cancelAuction(u));
        (bool active,,) = ch.auctionOf(u);
        assertFalse(active);
        (,,, uint256 cancelled,) = ch.auctionStats(7);
        assertEq(cancelled, 1);
        assertEq(ch.getAuctionAccounts(7, 0, 10).length, 0);
        // Unfrozen: can close again.
        vm.prank(u);
        ch.closePosition(MON);
        _assertBooksBalance();
    }

    function test_Cancel_AfterPriceRecovery() public {
        address u = _trader(7, 1);
        _setMon(2.76e18);
        _start(u);
        _setMon(MON_PRICE);
        assertTrue(ch.cancelAuction(u));
        assertFalse(ch.cancelAuction(u), "already cancelled");
    }

    function test_Expire_OnlyAtMaxDiscount_LegacyPath() public {
        address u = _trader(0, 1);
        _setMon(2.4e18); // E ~ -100
        (int256 e,,,) = ch.accountHealth(u);
        _start(u);
        uint256 b0 = block.number;
        vm.roll(b0 + 19); // 475 bps
        assertEq(ch.expireBatch(0, _one(u)), 0);
        vm.roll(b0 + 20); // 500 = max
        vm.expectEmit(true, true, false, true, address(ch));
        emit ParaclrClearinghouse.AuctionExpired(0, u, e, uint256(-e));
        vm.prank(keeper);
        assertEq(ch.expireBatch(0, _one(u)), 1);
        assertEq(collateralOf(u), 0);
        (,,,, uint256 expired) = ch.auctionStats(0);
        assertEq(expired, 1);
        (,, uint256 liqs,,) = ch.getLane(0);
        assertEq(liqs, 1);
        _assertBooksBalance();
    }

    function test_Expire_PaysLegacyPenaltyToCaller() public {
        // Positive residual equity => 1% penalty (half to the caller) as in liquidateBatch.
        address u = laneAddr(0, 2);
        fund(u, 105e6);
        open(u, MON, true, 100e6, 5); // 500 notional
        _setMon(2.4e18); // -20%: equity 5 < mm 10
        (int256 e,,, uint256 n) = ch.accountHealth(u);
        _start(u);
        vm.roll(block.number + 20);
        vm.prank(keeper);
        ch.expireBatch(0, _one(u));
        uint256 penalty = (n * 100) / 10_000;
        assertEq(collateralOf(u), e - int256(penalty));
        assertEq(ch.keeperRewards(keeper), penalty / 2);
        _assertBooksBalance();
        vm.prank(keeper);
        ch.claimKeeperRewards();
        assertEq(ausd.balanceOf(keeper), penalty / 2);
        _assertBooksBalance();
    }

    function test_EmptyPool_FallsBackToExpiry() public {
        // Drain lane 1's pool: the pool cannot carry anything, auctions run to max and expire.
        vm.prank(admin);
        ch.backstopWithdraw(1, POOL_SEED);
        address u = _trader(1, 1);
        _setMon(2.4e18);
        _start(u);
        vm.roll(block.number + 10);
        assertEq(ch.backstopTakeBatch(1, _one(u)), 0, "empty pool skips");
        vm.roll(block.number + 10);
        assertEq(ch.backstopTakeBatch(1, _one(u)), 0);
        assertEq(ch.expireBatch(1, _one(u)), 1);
        _assertBooksBalance();
    }

    function test_Expire_SkipsCuredAccount() public {
        address u = _trader(0, 1);
        _setMon(2.76e18);
        _start(u);
        vm.roll(block.number + 30);
        _setMon(MON_PRICE);
        assertEq(ch.expireBatch(0, _one(u)), 0);
        assertTrue(ch.cancelAuction(u));
    }

    // ------------------------------------------------------------------
    // Backstop pool: shares, NAV, withdraw guard, reduce, netting
    // ------------------------------------------------------------------

    function test_BackstopPool_SharesTrackNavIncludingInheritedExposure() public {
        assertEq(ch.backstopSharesOf(3, admin), POOL_SEED);
        address u = _trader(3, 1);
        _setMon(2.76e18);
        _start(u);
        vm.roll(block.number + 6);
        ch.backstopTakeBatch(3, _one(u));
        (int256 eq0,,, uint256 supply0) = ch.backstopNav(3);
        assertEq(supply0, POOL_SEED);

        // Price recovers +5% on the inherited long: NAV includes the unrealized gain.
        _setMon(2.898e18);
        (int256 eq1, int256 cash1, int256 unreal1,) = ch.backstopNav(3);
        assertGt(unreal1, 0);
        assertEq(eq1, cash1 + unreal1);
        assertGt(eq1, eq0);

        // A second LP buys in at the higher NAV.
        vm.prank(admin);
        ausd.ownerMint(lp2, 1_000e6);
        vm.startPrank(lp2);
        ausd.approve(address(ch), type(uint256).max);
        vm.expectEmit(true, true, false, true, address(ch));
        emit ParaclrClearinghouse.BackstopDeposit(3, lp2, 1_000e6, (1_000e6 * POOL_SEED) / uint256(eq1));
        uint256 shares = ch.backstopDeposit(3, 1_000e6);
        assertEq(shares, (1_000e6 * POOL_SEED) / uint256(eq1));
        // Redeeming right away returns (at most) what was paid in.
        uint256 back = ch.backstopWithdraw(3, shares);
        vm.stopPrank();
        assertLe(back, 1_000e6);
        assertApproxEqAbs(back, 1_000e6, 1);
        _assertBooksBalance();
    }

    function test_BackstopWithdraw_MarginGuard() public {
        // Pool with 1,000 cash inherits ~9,200 of exposure: required margin ~920.
        vm.prank(admin);
        ch.backstopWithdraw(4, POOL_SEED - 1_000e6);
        address u = laneAddr(4, 1);
        fund(u, 1_000e6);
        open(u, MON, true, 1_000e6, 10); // 10,000 notional
        _setMon(2.76e18);
        _start(u);
        vm.roll(block.number + 6);
        assertEq(ch.backstopTakeBatch(4, _one(u)), 1);
        (int256 eq,,, uint256 supply) = ch.backstopNav(4);
        (, int256[] memory sz,) = ch.backstopPositions(4);
        uint256 required = ((uint256(sz[0]) * 2.76e18) / 1e30) * 1_000 / 10_000;
        assertGt(uint256(eq), required);

        // Withdrawing everything would leave the pool below margin.
        vm.prank(admin);
        vm.expectPartialRevert(ParaclrClearinghouse.BackstopMarginBreached.selector);
        ch.backstopWithdraw(4, supply);
        // Withdrawing down to (just above) the margin works.
        uint256 free = uint256(eq) - required;
        uint256 shares = (free * supply) / uint256(eq);
        vm.prank(admin);
        ch.backstopWithdraw(4, shares);
        _assertBooksBalance();

        vm.prank(lp2);
        vm.expectRevert(abi.encodeWithSelector(ParaclrClearinghouse.InsufficientShares.selector, 1, 0));
        ch.backstopWithdraw(4, 1);
    }

    function test_BackstopTake_SkipsWhenPoolWouldBreachMargin() public {
        vm.prank(admin);
        ch.backstopWithdraw(4, POOL_SEED - 500e6); // 500 cash
        address u = laneAddr(4, 1);
        fund(u, 1_000e6);
        open(u, MON, true, 1_000e6, 10); // 10,000 notional -> needs ~920 margin
        _setMon(2.76e18);
        _start(u);
        vm.roll(block.number + 6);
        assertEq(ch.backstopTakeBatch(4, _one(u)), 0);
        (bool active,,) = ch.auctionOf(u);
        assertTrue(active);
    }

    function test_BackstopReduce_RoleRealizesAtMark() public {
        address u = _trader(3, 1);
        _setMon(2.76e18);
        _start(u);
        vm.roll(block.number + 6);
        ch.backstopTakeBatch(3, _one(u));
        (, int256[] memory sz,) = ch.backstopPositions(3);
        uint256 size = uint256(sz[0]);

        vm.prank(keeper);
        vm.expectRevert(Owned.Unauthorized.selector);
        ch.backstopReduce(3, MON, size);

        vm.prank(admin);
        ch.setBackstopOperator(keeper, true);
        assertTrue(ch.isBackstopOperator(keeper));

        _setMon(2.898e18); // +5% from the inherited entry
        int256 cashBefore = _poolCash(3);
        uint256 insBefore = _ins(3);
        int256 expectedPnl = int256((size / 2) * (2.898e18 - 2.76e18) / 1e30);
        vm.expectEmit(true, true, false, true, address(ch));
        emit ParaclrClearinghouse.BackstopReduced(3, MON, size / 2, 2.898e18, expectedPnl);
        vm.prank(keeper);
        int256 pnl = ch.backstopReduce(3, MON, size / 2);
        assertEq(pnl, expectedPnl);
        assertEq(_poolCash(3), cashBefore + pnl);
        assertEq(_ins(3), insBefore - uint256(pnl));
        (, sz,) = ch.backstopPositions(3);
        assertEq(uint256(sz[0]), size - size / 2);

        // Reduce more than held: capped at the remaining size; the pool goes flat.
        vm.prank(admin);
        ch.backstopReduce(3, MON, type(uint256).max);
        (bytes32[] memory pm,,) = ch.backstopPositions(3);
        assertEq(pm.length, 0);
        (uint256 oiLong, uint256 oiShort) = ch.laneOpenInterest(3, MON);
        assertEq(oiLong + oiShort, 0);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ParaclrClearinghouse.NoPosition.selector, MON));
        ch.backstopReduce(3, MON, 1);
        _assertBooksBalance();

        // Flat pool: everything can be withdrawn again.
        vm.prank(admin);
        ch.backstopWithdraw(3, POOL_SEED);
        (int256 eq,,, uint256 supply) = ch.backstopNav(3);
        assertEq(supply, 0);
        assertEq(eq, 0);
        _assertBooksBalance();
    }

    function test_BackstopNetting_AvgEntryAndRealizedPnl() public {
        // Pool inherits a long at 2.76, then a long at 2.4 (avg entry), then a short (netting).
        address a = _trader(5, 1);
        _setMon(2.76e18);
        _start(a);
        vm.roll(block.number + 6);
        ch.backstopTakeBatch(5, _one(a));
        uint256 s1 = _poolSize(5);

        address b = _trader(5, 2); // opens at 2.76
        _setMon(2.4e18);
        _start(b);
        vm.roll(block.number + 6);
        uint256 s2 = ch.getPosition(b, MON).size;
        ch.backstopTakeBatch(5, _one(b));
        assertEq(_poolSize(5), s1 + s2);
        uint256 avg = _poolEntry(5);
        assertEq(avg, (s1 * 2.76e18 + s2 * 2.4e18) / (s1 + s2));

        // A short opened at 2.4 enters auction after a +10% rally: the pool nets part of its long.
        address c = laneAddr(5, 3);
        fund(c, 100e6);
        open(c, MON, false, 100e6, 10);
        _setMon(2.64e18);
        _start(c);
        vm.roll(block.number + 6);
        uint256 s3 = ch.getPosition(c, MON).size;
        int256 cashBefore = _poolCash(5);
        ch.backstopTakeBatch(5, _one(c));
        assertEq(_poolSize(5), s1 + s2 - s3);
        assertEq(_poolEntry(5), avg, "avg entry unchanged on a partial reduce");
        int256 realized = int256(s3) * (int256(2.64e18) - int256(avg)) / 1e30;
        assertEq(_poolCash(5), cashBefore + realized + int256((((s3 * 2.64e18) / 1e30) * 150) / 10_000));
        (uint256 oiLong, uint256 oiShort) = ch.laneOpenInterest(5, MON);
        assertEq(oiShort, 0);
        assertEq(oiLong, ((s1 + s2 - s3) * avg) / 1e30);
        _assertBooksBalance();
    }

    function _poolSize(uint8 lane) internal view returns (uint256) {
        (, int256[] memory sz,) = ch.backstopPositions(lane);
        return uint256(sz[0]);
    }

    function _poolEntry(uint8 lane) internal view returns (uint256) {
        (,, uint256[] memory entry) = ch.backstopPositions(lane);
        return entry[0];
    }

    // ------------------------------------------------------------------
    // Default threshold vs the legacy 1% penalty
    // ------------------------------------------------------------------

    /// @dev Liquidate `u` both ways from the same state: legacy `liquidateBatch` (1% penalty) and
    ///      a pool take at the default threshold (3 blocks = 75 bps). Returns what the trader
    ///      keeps in each case.
    function _legacyVsDefaultPoolTake(address u) internal returns (int256 legacyLeft, int256 auctionLeft) {
        uint8 lane = ch.laneOf(u);
        uint256 snap = vm.snapshotState();
        vm.prank(keeper);
        assertEq(ch.liquidateBatch(lane, _one(u)), 1);
        legacyLeft = collateralOf(u);
        vm.revertToState(snap);

        _start(u);
        assertEq(ch.backstopMinDiscountBps(lane), 75);
        vm.roll(block.number + 2);
        assertEq(ch.backstopTakeBatch(lane, _one(u)), 0, "below the default threshold");
        vm.roll(block.number + 1);
        assertEq(ch.backstopTakeBatch(lane, _one(u)), 1, "taken at the default threshold");
        auctionLeft = collateralOf(u);
    }

    /// @notice At the default pool threshold (75 bps) a trader with E >= 1% of notional keeps
    ///         strictly more than the legacy liquidation (1% penalty) would leave.
    function test_DefaultPoolTake_LeavesTraderMoreThanLegacy() public {
        address u = _trader(3, 1);
        _setMon(2.76e18); // -8% on 10x: E ~20 on ~920 notional (2.2%)
        (int256 e,,, uint256 n) = ch.accountHealth(u);
        assertGe(e * 100, int256(n), "E >= 1% of notional");
        (int256 legacyLeft, int256 auctionLeft) = _legacyVsDefaultPoolTake(u);
        assertEq(legacyLeft, e - int256((n * 100) / 10_000), "legacy: E - 1%");
        assertEq(auctionLeft, e - int256((n * 75) / 10_000), "auction: E - 0.75%");
        assertGt(auctionLeft, legacyLeft, "trader keeps strictly more");
        _assertBooksBalance();
    }

    /// @notice Same claim over leverage 2x..20x and every equity level from 1% up to the 2.5%
    ///         maintenance line (price chosen so E/N at mark hits `eqBps`).
    function testFuzz_DefaultPoolTake_LeavesTraderMoreThanLegacy(uint256 collateral, uint256 lev, uint256 eqBps)
        public
    {
        collateral = bound(collateral, 10e6, 10_000e6);
        lev = bound(lev, 2, 20);
        eqBps = bound(eqBps, 100, 249);
        address u = laneAddr(3, 4242);
        fund(u, collateral);
        open(u, MON, true, collateral, lev);
        // Long, fully margined: E/N = 1 - (p0/p)(1 - 1/L)  =>  p = p0 (L-1) / (L (1 - E/N)).
        _setMon((MON_PRICE * (lev - 1) * 10_000) / (lev * (10_000 - eqBps)));
        (int256 e,,, uint256 n) = ch.accountHealth(u);
        if (!ch.isLiquidatable(u) || e * 100 < int256(n)) return; // rounding at the edges
        (int256 legacyLeft, int256 auctionLeft) = _legacyVsDefaultPoolTake(u);
        assertEq(legacyLeft, e - int256((n * 100) / 10_000));
        assertEq(auctionLeft, e - int256((n * 75) / 10_000));
        assertGt(auctionLeft, legacyLeft, "trader keeps strictly more than legacy");
    }

    function test_BackstopMinDiscount_PerLane() public {
        vm.expectEmit(true, false, false, true, address(ch));
        emit ParaclrClearinghouse.BackstopMinDiscountUpdated(2, 300);
        vm.prank(admin);
        ch.setBackstopMinDiscount(2, 300);
        assertEq(ch.backstopMinDiscountBps(2), 300);
        assertEq(ch.backstopMinDiscountBps(3), 75, "other lanes untouched");
        address u = _trader(2, 1);
        _setMon(2.4e18);
        _start(u);
        vm.roll(block.number + 11);
        assertEq(ch.backstopTakeBatch(2, _one(u)), 0);
        vm.roll(block.number + 1);
        assertEq(ch.backstopTakeBatch(2, _one(u)), 1);
    }

    // ------------------------------------------------------------------
    // Interplay with the legacy path, lists, solvency
    // ------------------------------------------------------------------

    function test_LiquidateBatch_SkipsAccountsInAuction() public {
        address u = _trader(3, 1);
        address v = _trader(3, 2);
        _setMon(2.4e18);
        _start(u);
        address[] memory batch = new address[](2);
        batch[0] = u;
        batch[1] = v;
        vm.prank(keeper);
        assertEq(ch.liquidateBatch(3, batch), 1);
        (bool active,,) = ch.auctionOf(u);
        assertTrue(active);
        _assertBooksBalance();
    }

    function test_AuctionList_SwapAndPop() public {
        address[] memory us = new address[](4);
        for (uint256 i; i < 4; ++i) {
            us[i] = _trader(6, 100 + i);
        }
        _setMon(2.4e18);
        assertEq(ch.startAuctions(6, us), 4);
        vm.roll(block.number + 6);
        // Take the 2nd: the last one is moved into its slot.
        ch.backstopTakeBatch(6, _one(us[1]));
        address[] memory list = ch.getAuctionAccounts(6, 0, 10);
        assertEq(list.length, 3);
        assertEq(list[0], us[0]);
        assertEq(list[1], us[3]);
        assertEq(list[2], us[2]);
        // Paging.
        assertEq(ch.getAuctionAccounts(6, 1, 1)[0], us[3]);
        assertEq(ch.getAuctionAccounts(6, 5, 1).length, 0);
        // The moved account's index was updated: taking it later still works.
        ch.backstopTakeBatch(6, _one(us[3]));
        list = ch.getAuctionAccounts(6, 0, 10);
        assertEq(list.length, 2);
        assertEq(list[0], us[0]);
        assertEq(list[1], us[2]);
        ch.backstopTakeBatch(6, list);
        assertEq(ch.getAuctionAccounts(6, 0, 10).length, 0);
        _assertBooksBalance();
    }

    function test_Solvency_DirectTransferShowsAsSurplus() public {
        _assertBooksBalance();
        vm.prank(admin);
        ausd.ownerMint(address(ch), 7e6);
        (uint256 held, uint256 liabilities, int256 surplus, bool solvent) = ch.solvency();
        assertEq(held - liabilities, 7e6);
        assertEq(surplus, 7e6);
        assertTrue(solvent);
    }

    function test_Solvency_LedgerMatchesAccounts() public {
        address a = _trader(2, 1);
        address b = laneAddr(2, 2);
        fund(b, 500e6);
        open(b, BTC, false, 100e6, 5);
        (int256 coll,,,,) = ch.laneLedger(2);
        assertEq(coll, collateralOf(a) + collateralOf(b));
        _setMon(2.4e18);
        vm.prank(b);
        ch.closePosition(BTC);
        _start(a);
        vm.roll(block.number + 8);
        ch.backstopTakeBatch(2, _one(a));
        (coll,,,,) = ch.laneLedger(2);
        assertEq(coll, collateralOf(a) + collateralOf(b));
        _assertBooksBalance();
    }
}
