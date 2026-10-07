// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R2-04 (Low): pool NAV counted gains the lane could only pay from the pool's own cash;
///        first LP out won, new LPs overpaid; a standing request was a 24 h exit option.
///        **FLIPPED INTO A REGRESSION (v3).**
/// @notice FLIPPED 2026-10-07 after the v3 fix.
///         Fix: the pool's unrealised GAINS count in NAV only up to the lane's insurance (what the
///         lane can pay without touching the pool's own cash); withdrawal requests are single-use
///         (any withdrawal consumes them) with a 1 h execution window.
///         UPDATED v5 (R4-01): exits now count unrealised gains as 0 until realised (the cap followed
///         insurance, which a hedged pair can lift for one block); 04a and 04b assert that rule.
contract R2_04_PoolNavFirstExitTest is ReviewBase {
    uint8 internal constant L = 5;
    address internal lp1 = makeAddr("lp1");
    address internal lp2 = makeAddr("lp2");

    function setUp() public override {
        super.setUp();
        uint256[8] memory seed;
        seed[L] = 100e6;
        _bareClearinghouse(seed);
        _lpDeposit(lp1, L, 1_000e6);
        _lpDeposit(lp2, L, 1_000e6);
        address v = laneAddr(L, 1);
        fund(v, 50e6);
        _open(v, MON, true, 400e6, 40e6);
        _setSpot(FEED_MON, 2.65e8);
        ch.startAuctions(L, _one(v), _none());
        vm.roll(block.number + 3);
        assertEq(ch.backstopTakeBatch(L, _one(v), _none()), 1);
    }

    function test_R2_04a_FirstLpExitsAtFairNav_SecondLpWhole() public {
        uint256 s1 = ch.backstopSharesOf(L, lp1);
        vm.prank(lp1);
        ch.backstopRequestWithdraw(L, s1);
        vm.warp(block.timestamp + 1 hours + 1);
        _setSpot(FEED_MON, 4.2e8); // the pool's gain (~206.7) exceeds lane insurance (~146.9)
        (int256 nav, int256 cash,,) = ch.backstopNav(L);
        // UPDATED v5 (R4-01): an exit counts unrealised gains as 0 (v3-v4: up to insurance)
        assertEq(nav, cash, "unrealised gain counts 0 on exit");
        vm.prank(lp1);
        uint256 out1 = ch.backstopWithdraw(L, s1, _none());
        assertEq(out1, uint256(cash) / 2, "LP1 paid half the cash, no unrealised gain");
        vm.prank(admin);
        ch.backstopReduce(L, MON, type(uint256).max, _none());
        (int256 lp2Value,,,) = ch.backstopNav(L);
        uint256 rec = ch.backstopReceivable(L);
        emit log_named_decimal_uint("LP1 paid", out1, 6);
        emit log_named_decimal_int("LP2 left with", lp2Value, 6);
        emit log_named_decimal_uint("plus the receivable LP2 holds", rec, 6);
        assertGe(uint256(lp2Value), out1, "the one who stays is not worse off");
        assertGt(uint256(lp2Value) + rec, out1 + 200e6, "the realised gain went to the LP who stayed");
    }

    /// @notice UPDATED v4 (R3-01d): while the NAV cap binds (pool gain > lane insurance) NAV
    ///         understates what existing LPs own, so a deposit is refused outright; once the gain is
    ///         within insurance, a new LP is priced at the full NAV: neither side is diluted.
    function test_R2_04b_NewLpDepositNotDiluted() public {
        _setSpot(FEED_MON, 4.2e8); // gain ~206.7 > insurance ~146.9: the cap binds
        address lp3 = makeAddr("lp3");
        vm.prank(admin);
        ausd.ownerMint(lp3, 1_000e6);
        vm.startPrank(lp3);
        ausd.approve(address(ch), type(uint256).max);
        vm.expectPartialRevert(CH.BackstopGainCapBinding.selector);
        ch.backstopDeposit(L, 1_000e6, _none());
        vm.stopPrank();

        _setSpot(FEED_MON, 3.5e8); // gain ~113 <= insurance: the deposit is priced at the full NAV
        (int256 eq0, int256 cash0,, uint256 supply0) = ch.backstopNav(L);
        (,, int256 unr,) = ch.backstopDepositStatus(L);
        uint256 shares3 = _lpDeposit(lp3, L, 1_000e6);
        assertEq(shares3, (1_000e6 * supply0) / uint256(cash0 + unr), "priced at cash + the full gain");
        (int256 eq1,,, uint256 supply1) = ch.backstopNav(L);
        assertEq(eq1, eq0 + 1_000e6, "exit NAV grows by exactly the deposit");
        // UPDATED v5 (R4-01): the exit NAV counts the gain as 0, so old LPs' exit value per share
        // RISES on a deposit priced at the full NAV (it was unchanged in v4)
        assertGe((supply0 * uint256(eq1)) / supply1, uint256(eq0), "old LPs' value not diluted");
        vm.prank(admin);
        ch.backstopReduce(L, MON, type(uint256).max, _none());
        (int256 eq,,, uint256 supply) = ch.backstopNav(L);
        uint256 value3 = (shares3 * uint256(eq)) / supply;
        emit log_named_decimal_uint("LP3 deposited 1000, now worth", value3, 6);
        assertGe(value3, 999e6, "priced at a NAV the lane can actually pay");
        assertSolvent();
    }

    function test_R2_04c_RequestIsSingleUse_ShortWindow() public {
        uint256 s1 = ch.backstopSharesOf(L, lp1);
        vm.prank(lp1);
        ch.backstopRequestWithdraw(L, s1);
        // the window is 1 h after ripening: +23 h is far outside it
        vm.warp(block.timestamp + 23 hours);
        _refreshStored();
        vm.prank(lp1);
        vm.expectRevert();
        ch.backstopWithdraw(L, s1 / 2, _none());
        // inside the window, one (partial) exit consumes the request
        vm.prank(lp1);
        ch.backstopRequestWithdraw(L, s1);
        vm.warp(block.timestamp + 1 hours);
        _refreshStored();
        vm.prank(lp1);
        ch.backstopWithdraw(L, s1 / 2, _none());
        vm.prank(lp1);
        vm.expectRevert(abi.encodeWithSelector(CH.NoWithdrawRequest.selector, L, lp1));
        ch.backstopWithdraw(L, s1 / 2, _none()); // second exit needs a new request + delay
        assertEq(ch.backstopSharesOf(L, lp1), s1 - s1 / 2);
    }
}
