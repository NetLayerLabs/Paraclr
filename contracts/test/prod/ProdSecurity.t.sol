// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ProdTestBase} from "./ProdTestBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {MockPyth, ReentrantPyth} from "./mocks/MockPyth.sol";
import {HookToken} from "./mocks/TestTokens.sol";

/// @notice Reentrancy (through Pyth and through the token), fee-on-transfer / over-debit
///         resistance, frozen-contract behaviour, decimals check, self-call guard, and
///         gas-starvation never turning a fillable order into a failed one.
contract ProdSecurityTest is ProdTestBase {
    address internal alice = laneAddr(3, 1);

    function test_Constructor_RejectsNon6DecimalToken() public {
        HookToken t18 = new HookToken(18);
        vm.expectRevert(CH.InvalidParam.selector);
        new CH(admin, IERC20(address(t18)), IPyth(address(pyth)));
        vm.expectRevert(CH.InvalidParam.selector);
        new CH(admin, IERC20(address(t18)), IPyth(address(0xdead))); // no code
    }

    function test_SelfFill_OnlySelf() public {
        vm.expectRevert(CH.Unauthorized.selector);
        ch.selfFill(1, 3e18);
    }

    // ------------------------------------------------------------------ reentrancy

    function test_Reentrancy_ThroughPyth_Blocked() public {
        ReentrantPyth rp = new ReentrantPyth();
        for (uint256 i; i < feeds.length; ++i) {
            rp.setStoredPrice(feeds[i], spot[feeds[i]], 1, EXPO, block.timestamp);
        }
        vm.prank(admin);
        ch.setPyth(IPyth(address(rp)));
        fund(alice, 1_000e6);
        _open(alice, MON, true, 500e6, 50e6);
        // during the price parse inside withdraw, Pyth re-enters withdraw
        rp.arm(address(ch), abi.encodeCall(CH.withdraw, (1e6, new bytes[](0))));
        bytes[] memory u = _updAll(block.timestamp);
        vm.prank(alice);
        ch.withdraw(1e6, u);
        assertFalse(rp.reentered());
        assertEq(bytes4(rp.reentryError()), CH.Reentrancy.selector);
        // and inside executeOrder's unique parse, re-entering cancelOrder / executeOrder
        uint256 id = _commit(alice, MON, int256(_sizeFor(100e6, MON)), 10e6, type(uint128).max);
        rp.arm(address(ch), abi.encodeCall(CH.executeOrder, (id, new bytes[](0))));
        _execute(id);
        assertEq(bytes4(rp.reentryError()), CH.Reentrancy.selector);
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Executed));
    }

    function test_Reentrancy_ThroughToken_Blocked() public {
        (CH c, HookToken t) = _hookClearinghouse();
        t.mint(alice, 1_000e6);
        vm.prank(alice);
        t.approve(address(c), type(uint256).max);
        t.armReentry(address(c), abi.encodeCall(CH.deposit, (1e6)));
        vm.prank(alice);
        c.deposit(100e6);
        assertFalse(t.reenterOk());
        assertEq(bytes4(t.reenterResult()), CH.Reentrancy.selector);
        (int256 coll,,,,,) = c.getAccount(alice);
        assertEq(coll, 100e6);
    }

    // ------------------------------------------------------------------ token behaviour

    function test_FeeOnTransfer_CreditsReceived_IdentityHolds() public {
        (CH c, HookToken t) = _hookClearinghouse();
        t.setFeeBps(100); // 1%
        t.mint(alice, 1_000e6);
        vm.prank(alice);
        t.approve(address(c), type(uint256).max);
        vm.prank(alice);
        c.deposit(100e6);
        (int256 coll,,,,,) = c.getAccount(alice);
        assertEq(coll, 99e6, "credited what arrived");
        (uint256 held, uint256 liab, int256 surplus,) = c.solvency();
        assertEq(held, liab);
        assertEq(surplus, 0);
        // withdraw: the contract's balance drops by exactly the amount (user receives less)
        vm.prank(alice);
        c.withdraw(50e6, new bytes[](0));
        (held, liab, surplus,) = c.solvency();
        assertEq(surplus, 0);
        assertEq(t.balanceOf(alice), 900e6 + 49.5e6);
    }

    function test_OverDebitingToken_Reverts() public {
        (CH c, HookToken t) = _hookClearinghouse();
        t.mint(alice, 1_000e6);
        vm.prank(alice);
        t.approve(address(c), type(uint256).max);
        vm.prank(alice);
        c.deposit(100e6);
        t.mint(address(c), 10e6); // donation, so the over-debit can be served
        t.setExtraDebit(1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CH.TransferAmountMismatch.selector, 50e6, 50e6 + 1));
        c.withdraw(50e6, new bytes[](0));
    }

    function test_FrozenClearinghouse_TransfersFail_TradingContinues() public {
        (CH c, HookToken t) = _hookClearinghouse();
        t.mint(alice, 1_000e6);
        vm.prank(alice);
        t.approve(address(c), type(uint256).max);
        vm.prank(alice);
        c.deposit(500e6);
        t.setFrozen(address(c), true); // issuer freezes the contract (Agora FREEZER_ROLE)
        vm.prank(alice);
        vm.expectRevert(bytes("frozen"));
        c.withdraw(1e6, new bytes[](0));
        vm.prank(alice);
        vm.expectRevert(bytes("frozen"));
        c.deposit(1e6);
        // internal trading still works (no token movement)
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        uint256 id = c.commitOrder{value: EXEC_FEE}(MON, int256(_sizeFor(100e6, MON)), 10e6, type(uint128).max);
        CH.Order memory o = c.getOrder(id);
        vm.warp(o.execAfter + 1);
        bytes[] memory u = _updAll(o.execAfter);
        vm.prank(keeper);
        c.executeOrder(id, u);
        assertEq(uint8(c.getOrder(id).status), uint8(CH.OrderStatus.Executed));
    }

    // ------------------------------------------------------------------ gas griefing

    /// @notice Whatever gas an executor supplies, a fillable order is either Executed or the
    ///         whole call reverts (order stays Pending). It is never turned into Failed.
    function test_GasStarvation_NeverFailsAFillableOrder() public {
        fund(alice, 5_000e6);
        _open(alice, BTC, true, 1_000e6, 100e6); // another leg → cross-margin reads in the fill
        uint256 id = _commit(alice, MON, int256(_sizeFor(1_000e6, MON)), 100e6, type(uint128).max);
        CH.Order memory o = ch.getOrder(id);
        vm.warp(o.execAfter + 1);
        _refreshStored();
        // Only the order's feed in the update: the BTC leg is priced from Pyth storage (the path
        // where an uncached nested read could be gas-starved inside the fill).
        bytes[] memory u = _upd1(FEED_MON, spot[FEED_MON], o.execAfter, o.execAfter - 1);
        _starve(id, abi.encodeCall(CH.executeOrder, (id, u)));
        // Every feed in the update (fresh path).
        u = _updAll(o.execAfter);
        _starve(id, abi.encodeCall(CH.executeOrder, (id, u)));
    }

    function _starve(uint256 id, bytes memory data) internal {
        uint256 snap = vm.snapshotState();
        bool executed;
        for (uint256 g = 60_000; g < 1_200_000; g += 7_000) {
            vm.revertToState(snap);
            vm.prank(keeper);
            (bool ok,) = address(ch).call{gas: g}(data);
            CH.OrderStatus st = ch.getOrder(id).status;
            assertTrue(st != CH.OrderStatus.Failed, "gas starvation produced a Failed order");
            if (ok) {
                assertEq(uint8(st), uint8(CH.OrderStatus.Executed));
                executed = true;
            } else {
                assertEq(uint8(st), uint8(CH.OrderStatus.Pending));
            }
        }
        assertTrue(executed, "some gas level executes");
        vm.revertToState(snap);
    }

    // ------------------------------------------------------------------ helpers

    function _hookClearinghouse() internal returns (CH c, HookToken t) {
        t = new HookToken(6);
        c = new CH(admin, IERC20(address(t)), IPyth(address(pyth)));
        vm.startPrank(admin);
        c.listMarket("MON/AUSD", FEED_MON, 100_000e6, 10_000_000e6, 100);
        c.setCaps(1_000_000e6, 100_000_000e6, 50_000);
        vm.stopPrank();
        t.mint(admin, 800_000e6);
        vm.startPrank(admin);
        t.approve(address(c), type(uint256).max);
        for (uint8 lane; lane < 8; ++lane) {
            c.fundLane(lane, 100_000e6);
        }
        vm.stopPrank();
    }
}
