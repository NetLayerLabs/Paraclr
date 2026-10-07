// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R3-01 (Medium): the R2-08 pool receivable was left out of share accounting, so LP value
///        moved between LP generations. **FLIPPED INTO A REGRESSION (v4).**
/// @notice FLIPPED 2026-10-07 after the v4 fix; every attack below now FAILS.
///         Original finding (v3): a) NAV excluded the receivable, so a deposit made while it was
///         outstanding bought a share of it at zero; b) once the last LP had exited, the lane's
///         repayment landed in a share-less pool and the next depositor took it at 1:1; c) an
///         operator unwind at a small loss reset the pool and wiped a receivable larger than the
///         deficit; d) the NAV gain cap (= lane insurance) could be depressed for a moment by a
///         hedged pair draining insurance, letting a deposit buy the capped gain cheaply.
///         Fix (v4): a) `backstopDeposit` is refused while a receivable is outstanding
///         (`BackstopReceivableOutstanding`); d) and while the pool's uncapped unrealised gain
///         exceeds lane insurance (`BackstopGainCapBinding`), so a deposit is only ever priced at
///         the full, uncapped NAV and later cap movements can only lower NAV, never transfer value
///         to the new LP; c) a flat pool with cash <= 0 first nets its receivable against the deficit
///         (`BackstopReceivableNetted`) and is reset only if cash + receivable <= 0; b) when supply
///         reaches 0, orphaned cash goes to the lane and the receivable is forgiven
///         (`BackstopSwept`), so nothing is left for a next depositor.
contract R3_01_ReceivableNavTest is ReviewBase {
    uint8 internal constant L = 5;
    address internal oldLp = makeAddr("oldLp");
    address internal attackerLp = makeAddr("attackerLp");
    address internal w; // short (wins on a drop)
    address internal x; // long (loses on a drop)

    event BackstopReceivableNetted(uint8 indexed lane, uint256 amount);
    event BackstopSwept(uint8 indexed lane, uint256 cash, uint256 receivableForgiven);

    function setUp() public override {
        super.setUp();
        uint256[8] memory seed;
        seed[L] = 100e6; // lane insurance 100 (OI cap 500 per side)
        _bareClearinghouse(seed);
        w = laneAddr(L, 1);
        x = laneAddr(L, 2);
    }

    /// @dev Hedged pair on SOL: w short 500, x long 500 (x well collateralised).
    function _pair() internal {
        fund(w, 100e6);
        fund(x, 400e6);
        _open(w, SOL, false, 500e6, 50e6);
        _open(x, SOL, true, 500e6, 50e6);
    }

    function _mintApprove(address lp, uint256 amount) internal {
        vm.prank(admin);
        ausd.ownerMint(lp, amount);
        vm.prank(lp);
        ausd.approve(address(ch), type(uint256).max);
    }

    function test_R3_01a_DepositRefusedWhileReceivableOutstanding() public {
        _lpDeposit(oldLp, L, 400e6);
        _pair();
        _setSpot(FEED_SOL, 126e8); // -30%: w +150, x -150
        _closeAll(w, SOL); // drains insurance (~100), then ~50 of pool cash
        uint256 rec = ch.backstopReceivable(L);
        assertGt(rec, 45e6, "pool lent ~50 to the lane");
        (,,,, uint256 debt,) = ch.laneSolvency(L);
        assertEq(debt, 0, "no bad debt");
        (bool open, uint256 recView,,) = ch.backstopDepositStatus(L);
        assertFalse(open, "status view: closed");
        assertEq(recView, rec);
        _mintApprove(attackerLp, 3_500e6);
        vm.prank(attackerLp);
        vm.expectRevert(abi.encodeWithSelector(CH.BackstopReceivableOutstanding.selector, L, rec));
        ch.backstopDeposit(L, 3_500e6, _none());

        _closeAll(x, SOL); // the loser's loss repays the pool first
        assertEq(ch.backstopReceivable(L), 0);
        (open,,,) = ch.backstopDepositStatus(L);
        assertTrue(open, "status view: open again");
        (int256 nav0,,, uint256 supply0) = ch.backstopNav(L);
        assertApproxEqAbs(uint256(nav0), 400e6, 2, "old LP's receivable was repaid to the pool");
        vm.prank(attackerLp);
        uint256 sA = ch.backstopDeposit(L, 3_500e6, _none()); // now priced on a complete NAV
        (int256 nav1,,, uint256 supply1) = ch.backstopNav(L);
        assertEq(nav1, nav0 + 3_500e6, "NAV grows by exactly the deposit");
        assertApproxEqAbs((supply0 * uint256(nav1)) / supply1, uint256(nav0), 1, "old LP value conserved");
        uint256 outA = _lpWithdraw(attackerLp, L, sA);
        uint256 outOld = _lpWithdraw(oldLp, L, ch.backstopSharesOf(L, oldLp));
        emit log_named_decimal_uint("receivable outstanding at the refused deposit", rec, 6);
        emit log_named_decimal_uint("attacker LP gets back (deposited 3500)", outA, 6);
        emit log_named_decimal_uint("old LP gets back (deposited 400)", outOld, 6);
        assertLe(outA, 3_500e6, "no profit for the new LP");
        assertApproxEqAbs(outOld, 400e6, 2, "old LP whole");
        assertSolvent();
    }

    function test_R3_01b_LastLpOutForgivesReceivable_NothingForNextDepositor() public {
        uint256 s = _lpDeposit(oldLp, L, 400e6);
        _pair();
        _setSpot(FEED_SOL, 126e8);
        _closeAll(w, SOL);
        uint256 rec = ch.backstopReceivable(L);
        assertGt(rec, 45e6);
        _requestAndWait(oldLp, L, s);
        vm.expectEmit(true, false, false, true, address(ch));
        emit BackstopSwept(L, 0, rec);
        vm.prank(oldLp);
        uint256 outOld = ch.backstopWithdraw(L, s, _none()); // exits at NAV without the receivable
        (, int256 cash0,, uint256 supply) = ch.backstopNav(L);
        assertEq(supply, 0, "pool empty");
        assertEq(cash0, 0, "no orphaned cash");
        assertEq(ch.backstopReceivable(L), 0, "receivable forgiven explicitly");
        uint256 insBefore = _insurance(L);
        _closeAll(x, SOL); // the loser's loss now stays with the lane
        (, int256 cash,,) = ch.backstopNav(L);
        assertEq(cash, 0, "nothing lands in the share-less pool");
        assertGt(_insurance(L), insBefore + rec, "the lane (insurance) keeps the repayment");
        uint256 sA = _lpDeposit(attackerLp, L, 1e6); // supply 0: 1:1
        uint256 outA = _lpWithdraw(attackerLp, L, sA);
        emit log_named_decimal_uint("old LP exited with", outOld, 6);
        emit log_named_decimal_uint("1 AUSD depositor withdraws", outA, 6);
        assertLe(outA, 1e6, "1 AUSD in, at most 1 AUSD out");
        assertSolvent();
    }

    function test_R3_01c_OperatorUnwindNetsReceivable_NoReset() public {
        _lpDeposit(oldLp, L, 100e6);
        // the pool takes a liquidated MON long
        address v = laneAddr(L, 3);
        fund(v, 50e6);
        _open(v, MON, true, 400e6, 40e6);
        _setSpot(FEED_MON, 2.65e8);
        ch.startAuctions(L, _one(v), _none());
        vm.roll(block.number + 3);
        assertEq(ch.backstopTakeBatch(L, _one(v), _none()), 1);
        // a hedged SOL pair then drains insurance and all pool cash
        fund(w, 100e6);
        fund(x, 400e6);
        _open(w, SOL, false, 700e6, 70e6);
        _open(x, SOL, true, 700e6, 70e6);
        _setSpot(FEED_SOL, 113e8); // -37%: w's gain exceeds insurance + pool cash (small bad debt)
        _closeAll(w, SOL);
        uint256 rec = ch.backstopReceivable(L);
        assertGt(rec, 100e6, "the whole pool (~102) is owed back to it");
        // routine unwind of the pool's MON long at a 0.4% loss: cash (0) goes slightly negative
        _setSpot(FEED_MON, 2.64e8);
        vm.recordLogs();
        vm.prank(admin);
        ch.backstopReduce(L, MON, type(uint256).max, _none());
        assertEq(ch.backstopEpoch(L), 0, "no reset: cash + receivable > 0");
        uint256 recNetted = ch.backstopReceivable(L);
        uint256 netted = rec - recNetted;
        assertGt(netted, 0, "the deficit was netted against the receivable");
        assertLt(netted, 2e6, "only the small unwind loss");
        bool sawNetted;
        bytes32 sig = keccak256("BackstopReceivableNetted(uint8,uint256)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == sig) {
                sawNetted = true;
                assertEq(abi.decode(logs[i].data, (uint256)), netted);
            }
        }
        assertTrue(sawNetted, "BackstopReceivableNetted emitted");
        (, int256 cash0,, uint256 supply0) = ch.backstopNav(L);
        assertEq(cash0, 0);
        assertGt(supply0, 0, "old LP's shares survive");

        _closeAll(x, SOL); // the loser's loss repays bad debt, then the old LPs' receivable
        uint256 recAfter = ch.backstopReceivable(L);
        (, int256 cash1,,) = ch.backstopNav(L);
        assertEq(uint256(cash1), recNetted - recAfter, "repayment went to the pool");
        assertGt(cash1, 50e6, "a large part of the receivable came back");
        uint256 outOld = _lpWithdraw(oldLp, L, ch.backstopSharesOf(L, oldLp));
        emit log_named_decimal_uint("receivable before the unwind", rec, 6);
        emit log_named_decimal_uint("netted against the unwind deficit", netted, 6);
        emit log_named_decimal_uint("old LP gets back", outOld, 6);
        assertEq(outOld, uint256(cash1), "old LP collects the repayment");
        assertSolvent();
    }

    /// @notice Still resettable when truly insolvent: a deficit LARGER than the receivable uses
    ///         the whole receivable, then the remainder is written off and the shares are retired.
    function test_R3_01e_DeficitBeyondReceivable_NetsThenResets() public {
        _lpDeposit(oldLp, L, 100e6);
        address v = laneAddr(L, 3);
        fund(v, 50e6);
        _open(v, MON, true, 400e6, 40e6);
        _setSpot(FEED_MON, 2.65e8);
        ch.startAuctions(L, _one(v), _none());
        vm.roll(block.number + 3);
        assertEq(ch.backstopTakeBatch(L, _one(v), _none()), 1);
        fund(w, 100e6);
        fund(x, 400e6);
        _open(w, SOL, false, 700e6, 70e6);
        _open(x, SOL, true, 700e6, 70e6);
        _setSpot(FEED_SOL, 113e8);
        _closeAll(w, SOL);
        uint256 rec = ch.backstopReceivable(L);
        assertGt(rec, 100e6);
        _setSpot(FEED_MON, 1.8e8); // the pool's MON long now loses ~113 > the ~103 receivable
        // (the pool's realised loss is a lane inflow: it repays bad debt, then the receivable, and
        // whatever is still owed after that is netted against the remaining deficit)
        vm.prank(admin);
        ch.backstopReduce(L, MON, type(uint256).max, _none());
        assertEq(ch.backstopReceivable(L), 0, "fully netted");
        assertEq(ch.backstopEpoch(L), 1, "then reset: cash + receivable < 0");
        (, int256 cash,, uint256 supply) = ch.backstopNav(L);
        assertEq(cash, 0);
        assertEq(supply, 0);
        assertEq(ch.backstopSharesOf(L, oldLp), 0);
        assertSolvent();
    }

    function test_R3_01d_DepositRefusedWhileNavCapBinds() public {
        _lpDeposit(oldLp, L, 1_000e6);
        // the pool takes a liquidated MON long, which then gains (capped at insurance in NAV)
        address v = laneAddr(L, 3);
        fund(v, 50e6);
        _open(v, MON, true, 400e6, 40e6);
        _setSpot(FEED_MON, 2.65e8);
        ch.startAuctions(L, _one(v), _none());
        vm.roll(block.number + 3);
        ch.backstopTakeBatch(L, _one(v), _none());
        _setSpot(FEED_MON, 3.8e8); // pool gain ~153 > insurance ~147: the cap binds already
        _mintApprove(attackerLp, 3_000e6);
        vm.prank(attackerLp);
        vm.expectPartialRevert(CH.BackstopGainCapBinding.selector);
        ch.backstopDeposit(L, 3_000e6, _none());
        // hedged SOL pair: the winner drains insurance to ~7 (no pool cash touched)
        fund(w, 100e6);
        fund(x, 400e6);
        _open(w, SOL, false, 700e6, 70e6);
        _open(x, SOL, true, 700e6, 70e6);
        _setSpot(FEED_SOL, 144e8); // -20%: w +140
        _closeAll(w, SOL);
        (bool open,, int256 unr, uint256 ins) = ch.backstopDepositStatus(L);
        assertFalse(open);
        assertGt(unr, int256(ins), "NAV depressed by the cap");
        vm.prank(attackerLp);
        vm.expectRevert(abi.encodeWithSelector(CH.BackstopGainCapBinding.selector, L, unr, ins));
        ch.backstopDeposit(L, 3_000e6, _none());

        _closeAll(x, SOL); // insurance refilled (~148), still below the ~153 gain: still refused
        (open,,,) = ch.backstopDepositStatus(L);
        assertFalse(open);
        _setSpot(FEED_MON, 3.7e8); // gain ~140 <= insurance: NAV is uncapped
        (open,, unr, ins) = ch.backstopDepositStatus(L);
        assertTrue(open);
        assertLe(unr, int256(ins));
        (int256 nav0, int256 cash0,, uint256 supply0) = ch.backstopNav(L);
        // UPDATED v5 (R4-01): backstopNav is the EXIT NAV (gains count 0 until realised); deposits
        // are still priced at the full, uncapped NAV
        assertEq(nav0, cash0, "exit NAV: the unrealised gain counts 0");
        vm.prank(attackerLp);
        uint256 sA = ch.backstopDeposit(L, 3_000e6, _none());
        assertEq(sA, (3_000e6 * supply0) / uint256(cash0 + unr), "deposit priced at the full, uncapped NAV");
        (int256 nav1,,, uint256 supply1) = ch.backstopNav(L);
        uint256 valueA = (sA * uint256(nav1)) / supply1;
        assertLe(valueA, 3_000e6, "no cheap capped gain");
        assertGe((supply0 * uint256(nav1)) / supply1, uint256(nav0), "old LP value not diluted");
        emit log_named_decimal_uint("attacker LP value right after deposit", valueA, 6);
        assertSolvent();
    }
}
