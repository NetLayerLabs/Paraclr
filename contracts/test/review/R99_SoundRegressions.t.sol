// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @notice Regression tests for properties the review checked and found SOUND. They should keep
///         passing after the fixes for R-01..R-11.
contract R99_SoundRegressionsTest is ReviewBase {
    uint8 internal constant L = 5;

    /// forge-config: default.fuzz.runs = 128
    /// @notice Rounding is never in the trader's favour: any increase / partial-reduce / close
    ///         round trip at a constant price leaves collateral <= deposit − fees, and the AUSD
    ///         solvency identity holds exactly.
    function testFuzz_RoundTripAtConstantPriceNeverProfits(uint256 notional, uint256 cuts, uint256 seed) public {
        notional = bound(notional, 20e6, 5_000e6);
        cuts = bound(cuts, 0, 4);
        address a = laneAddr(3, 1);
        fund(a, 10_000e6);
        _open(a, MON, true, notional, notional / 10 + 1);
        for (uint256 i; i < cuts; ++i) {
            uint256 size = ch.getPosition(a, MON).size;
            uint256 cut = (size * bound(uint256(keccak256(abi.encode(seed, i))), 1, 40)) / 100;
            if ((size - cut) * 3 / 1e12 < 11e6) break; // keep above the minimum size
            uint256 id = _commit(a, MON, -int256(cut), 0, 1);
            _execute(id);
        }
        _closeAll(a, MON);
        assertEq(ch.getPosition(a, MON).size, 0);
        assertLt(collateralOf(a), 10_000e6, "never profits from rounding");
        assertSolvent();
    }

    /// forge-config: default.fuzz.runs = 128
    /// @notice LP deposit followed by an immediate full withdrawal never returns more than paid in,
    ///         including into a pool holding a position with unrealised PnL.
    function testFuzz_PoolRoundTripNeverProfits(uint256 amount, int256 moveBps) public {
        amount = bound(amount, 1e6, 20_000e6);
        moveBps = bound(moveBps, -500, 500);
        _lpDeposit(makeAddr("lp1"), L, 1_000e6);
        address v = laneAddr(L, 1);
        fund(v, 100e6);
        _open(v, MON, true, 1_900e6, 95e6);
        _setSpot(FEED_MON, 2.88e8);
        ch.startAuctions(L, _one(v), _none());
        vm.roll(block.number + 3);
        ch.backstopTakeBatch(L, _one(v), _none());
        _setSpot(FEED_MON, int64(int256(2.88e8) * (10_000 + moveBps) / 10_000));
        address lp2 = makeAddr("lp2");
        uint256 shares = _lpDeposit(lp2, L, amount);
        vm.prank(lp2);
        try ch.backstopWithdraw(L, shares, _none()) returns (uint256 out) {
            assertLe(out, amount, "no free value");
        } catch {}
        assertSolvent();
    }

    /// @notice A non-zero Pyth fee is only ever paid from msg.value, never from escrowed MON.
    function test_PythFeeNeverPaidFromEscrow() public {
        address a = laneAddr(3, 1);
        fund(a, 1_000e6);
        _open(a, MON, true, 500e6, 50e6);
        _commit(a, SOL, int256(_sizeFor(100e6, SOL)), 10e6, type(uint128).max); // escrow 0.1 MON
        pyth.setFees(1 ether, 0);
        uint256 held = address(ch).balance;
        bytes[] memory u = _updAll(block.timestamp);
        vm.prank(a);
        vm.expectRevert(abi.encodeWithSelector(CH.InsufficientPythFee.selector, 0, 3 ether));
        ch.withdraw(1e6, u);
        vm.prank(a);
        ch.withdraw(1e6, _none()); // the stored-price path needs no fee
        assertEq(address(ch).balance, held);
        assertSolvent();
    }

    /// @notice Native pushes (cancel refund, fee claim, msg.value refund) cannot re-enter.
    function test_NativeRefundReentrancyBlocked() public {
        ReenteringAccount r = new ReenteringAccount(ch);
        address who = address(r);
        vm.prank(admin);
        ausd.ownerMint(who, 1_000e6);
        vm.deal(who, 1 ether);
        r.setup(address(ausd), MON, int256(_sizeFor(100e6, MON)), EXEC_FEE);
        uint256 id = ch.pendingOrderOf(who, MON);
        vm.warp(ch.getOrder(id).deadline + 1);
        ch.cancelOrder(id); // push → receive() tries withdraw → Reentrancy (push still succeeds)
        assertEq(bytes4(r.lastError()), CH.Reentrancy.selector);
        assertSolvent();
    }
}

contract ReenteringAccount {
    CH internal ch;
    bytes public lastError;

    constructor(CH ch_) {
        ch = ch_;
    }

    function setup(address ausd, bytes32 market, int256 size, uint256 fee) external {
        (bool ok,) = ausd.call(abi.encodeWithSignature("approve(address,uint256)", address(ch), type(uint256).max));
        require(ok);
        ch.deposit(1_000e6);
        ch.commitOrder{value: fee}(market, size, 10e6, type(uint128).max);
    }

    receive() external payable {
        try ch.withdraw(1, new bytes[](0)) {} catch (bytes memory e) {
            lastError = e;
        }
    }
}
