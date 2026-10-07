// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ProdTestBase} from "./ProdTestBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {MockPyth} from "./mocks/MockPyth.sol";

/// @notice Owner = OpenZeppelin TimelockController (multisig proposer/executor, self-administered);
///         guardian = pause only; exact pause semantics.
contract ProdAdminTest is ProdTestBase {
    TimelockController internal timelock;
    address internal multisig = makeAddr("multisig");
    uint256 internal constant DELAY = 1 days;

    address internal trader = laneAddr(3, 1);
    address internal lp = laneAddr(5, 2);

    function setUp() public override {
        super.setUp();
        fund(trader, 5_000e6);
        address[] memory roles = new address[](1);
        roles[0] = multisig;
        timelock = new TimelockController(DELAY, roles, roles, address(0));
        vm.prank(admin);
        ch.transferOwnership(address(timelock));
    }

    // ------------------------------------------------------------------ timelock

    function _adminCalls() internal view returns (bytes[] memory c) {
        c = new bytes[](16);
        c[0] = abi.encodeCall(CH.unpause, ());
        c[1] = abi.encodeCall(CH.setGuardian, (address(1)));
        c[2] = abi.encodeCall(CH.setPyth, (IPyth(address(pyth))));
        c[3] = abi.encodeCall(CH.listMarket, ("ETH/AUSD", bytes32(uint256(5)), 1e6, 1e6, 1));
        c[4] = abi.encodeCall(CH.setMarketConfig, (MON, FEED_MON, 1e6, 1e6, 1));
        c[5] = abi.encodeCall(CH.setRiskParams, (5, 5, 10e6));
        c[6] = abi.encodeCall(CH.setCaps, (1, 1, 1));
        c[7] = abi.encodeCall(CH.setOracleParams, (30, 15, 100));
        c[8] = abi.encodeCall(CH.setOrderParams, (3, 90, 1));
        c[9] = abi.encodeCall(CH.setFundingParams, (120));
        c[10] = abi.encodeCall(CH.setAuctionParams, (10, 300));
        c[11] = abi.encodeCall(CH.setBackstopMinDiscount, (1, 50));
        c[12] = abi.encodeCall(CH.setBackstopOperator, (address(2), 0, true));
        c[13] = abi.encodeCall(Ownable.transferOwnership, (address(3)));
        c[14] = abi.encodeCall(Ownable.renounceOwnership, ());
        c[15] = abi.encodeCall(CH.setBackstopParams, (120));
    }

    function test_OnlyTimelockCanAdmin() public {
        bytes[] memory calls = _adminCalls();
        address[4] memory who = [admin, guardian, multisig, keeper];
        for (uint256 i; i < calls.length; ++i) {
            for (uint256 j; j < who.length; ++j) {
                vm.prank(who[j]);
                (bool ok, bytes memory ret) = address(ch).call(calls[i]);
                assertFalse(ok, "non-owner admin call succeeded");
                assertEq(bytes4(ret), Ownable.OwnableUnauthorizedAccount.selector);
            }
        }
        assertEq(ch.owner(), address(timelock));
    }

    function test_TimelockChangesParamsOnlyAfterDelay() public {
        bytes memory data = abi.encodeCall(CH.setRiskParams, (5, 7, 20e6));
        bytes32 salt = keccak256("risk");
        vm.prank(multisig);
        timelock.schedule(address(ch), 0, data, bytes32(0), salt, DELAY);
        vm.warp(block.timestamp + DELAY - 1);
        vm.prank(multisig);
        vm.expectRevert();
        timelock.execute(address(ch), 0, data, bytes32(0), salt);
        vm.warp(block.timestamp + 1);
        vm.prank(keeper); // not an executor
        vm.expectRevert();
        timelock.execute(address(ch), 0, data, bytes32(0), salt);
        vm.prank(multisig);
        timelock.execute(address(ch), 0, data, bytes32(0), salt);
        assertEq(ch.maxLeverage(), 5);
        assertEq(ch.tradingFeeBps(), 7);
        assertEq(ch.minPositionNotional(), 20e6);
    }

    function test_TimelockIsSelfAdministered_DeployerHasNoRole() public view {
        bytes32 adminRole = timelock.DEFAULT_ADMIN_ROLE();
        assertTrue(timelock.hasRole(adminRole, address(timelock)));
        assertFalse(timelock.hasRole(adminRole, address(this)));
        assertFalse(timelock.hasRole(adminRole, admin));
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), multisig));
        assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), multisig));
        assertFalse(timelock.hasRole(timelock.EXECUTOR_ROLE(), address(0)), "no open executor");
    }

    function test_RenounceDisabledEvenForOwner() public {
        vm.prank(address(timelock));
        vm.expectRevert(CH.RenounceDisabled.selector);
        ch.renounceOwnership();
    }

    function test_ParamBounds() public {
        vm.startPrank(address(timelock));
        vm.expectRevert(CH.InvalidParam.selector);
        ch.setRiskParams(21, 5, 0);
        vm.expectRevert(CH.InvalidParam.selector);
        ch.setRiskParams(0, 5, 0);
        vm.expectRevert(CH.InvalidParam.selector);
        ch.setRiskParams(10, 101, 0);
        vm.expectRevert(CH.InvalidParam.selector);
        ch.setOracleParams(4, 15, 100);
        vm.expectRevert(CH.InvalidParam.selector);
        ch.setOracleParams(61, 15, 100); // supplied-update age <= 60 s (review I-2)
        vm.expectRevert(CH.InvalidParam.selector);
        ch.setOracleParams(30, 61, 100); // stored-price age <= 60 s (R-08)
        vm.expectRevert(CH.InvalidParam.selector);
        ch.setOracleParams(30, 4, 100);
        vm.expectRevert(CH.InvalidParam.selector);
        ch.setOracleParams(30, 15, 501); // confidence <= 5% (I-2)
        vm.expectRevert(CH.InvalidParam.selector);
        ch.setCaps(1, 1, 100_001); // OI multiplier <= 10x (I-2)
        vm.expectRevert(CH.InvalidParam.selector);
        ch.setBackstopParams(59);
        vm.expectRevert(CH.InvalidParam.selector);
        ch.setBackstopParams(7 days + 1);
        vm.expectRevert(CH.InvalidParam.selector);
        ch.setOrderParams(0, 60, 0);
        vm.expectRevert(CH.InvalidParam.selector);
        ch.setOrderParams(10, 14, 0);
        vm.expectRevert(CH.InvalidParam.selector);
        ch.setFundingParams(9);
        vm.expectRevert(CH.InvalidBps.selector);
        ch.setAuctionParams(0, 100);
        vm.expectRevert(CH.InvalidBps.selector);
        ch.setAuctionParams(10, 501); // max discount <= 5% (R-08)
        vm.expectRevert(abi.encodeWithSelector(CH.InvalidLane.selector, uint8(8)));
        ch.setBackstopMinDiscount(8, 1);
        vm.stopPrank();
    }

    function test_SetPyth_RequiresEveryListedFeed() public {
        MockPyth other = new MockPyth();
        other.setStoredPrice(FEED_MON, 3e8, 1, -8, block.timestamp);
        vm.prank(address(timelock));
        vm.expectRevert(abi.encodeWithSelector(CH.FeedNotOnPyth.selector, FEED_SOL));
        ch.setPyth(IPyth(address(other)));
        other.setStoredPrice(FEED_SOL, 180e8, 1, -8, block.timestamp);
        other.setStoredPrice(FEED_BTC, 100_000e8, 1, -8, block.timestamp);
        vm.prank(address(timelock));
        ch.setPyth(IPyth(address(other)));
        assertEq(address(ch.pyth()), address(other));
    }

    // ------------------------------------------------------------------ pause

    function test_GuardianPausesOnly_TimelockUnpauses() public {
        vm.prank(keeper);
        vm.expectRevert(CH.Unauthorized.selector);
        ch.pause();
        vm.prank(guardian);
        ch.pause();
        assertTrue(ch.paused());
        vm.prank(guardian);
        vm.expectRevert(CH.IsPaused.selector);
        ch.pause();
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        ch.unpause();
        bytes memory data = abi.encodeCall(CH.unpause, ());
        vm.prank(multisig);
        timelock.schedule(address(ch), 0, data, bytes32(0), bytes32(0), DELAY);
        vm.warp(block.timestamp + DELAY);
        vm.prank(multisig);
        timelock.execute(address(ch), 0, data, bytes32(0), bytes32(0));
        assertFalse(ch.paused());
    }

    /// @notice Paused: blocks deposits (accounts without positions), pool deposits, committing
    ///         and executing increase orders. Everything else keeps working.
    function test_PauseSemantics_Exact() public {
        // book before the pause: trader long MON, a pending increase, an LP, an underwater account
        _open(trader, MON, true, 1_000e6, 100e6);
        uint256 pendingIncrease = _commit(trader, BTC, int256(_sizeFor(500e6, BTC)), 50e6, type(uint128).max);
        vm.prank(admin);
        ausd.ownerMint(lp, 20_000e6);
        vm.startPrank(lp);
        ausd.approve(address(ch), type(uint256).max);
        ch.backstopDeposit(5, 10_000e6, _none());
        vm.stopPrank();
        address victim = laneAddr(5, 9);
        fund(victim, 100e6);
        _open(victim, MON, true, 1_900e6, 95e6);
        address fresh = laneAddr(3, 50);
        vm.prank(admin);
        ausd.ownerMint(fresh, 100e6);
        vm.prank(fresh);
        ausd.approve(address(ch), type(uint256).max);

        vm.prank(guardian);
        ch.pause();

        // ---- blocked
        vm.prank(fresh);
        vm.expectRevert(CH.IsPaused.selector);
        ch.deposit(10e6);
        vm.prank(lp);
        vm.expectRevert(CH.IsPaused.selector);
        ch.backstopDeposit(5, 1e6, _none());
        vm.prank(trader);
        vm.expectRevert(CH.IsPaused.selector);
        ch.commitOrder{value: EXEC_FEE}(SOL, int256(_sizeFor(100e6, SOL)), 10e6, type(uint128).max);
        vm.prank(trader);
        vm.expectRevert(CH.IsPaused.selector); // increasing an existing position
        ch.commitOrder{value: EXEC_FEE}(MON, int256(_sizeFor(100e6, MON)), 10e6, type(uint128).max);
        CH.Order memory o = ch.getOrder(pendingIncrease);
        vm.warp(o.execAfter + 1);
        _refreshStored();
        bytes[] memory u = _updAll(o.execAfter);
        vm.prank(keeper);
        vm.expectRevert(CH.IsPaused.selector);
        ch.executeOrder(pendingIncrease, u);

        // ---- allowed
        vm.prank(admin);
        ausd.ownerMint(trader, 10e6);
        vm.prank(trader);
        ch.deposit(10e6); // holds a position: margin top-up
        vm.prank(trader);
        ch.withdraw(10e6, _none());
        uint256 half = ch.getPosition(trader, MON).size / 2;
        uint256 reduceId = _commit(trader, MON, -int256(half), 0, 1);
        _execute(reduceId);
        assertEq(uint8(ch.getOrder(reduceId).status), uint8(CH.OrderStatus.Executed), "reduce while paused");
        // the paused increase can be cancelled after its deadline, fee refunded
        vm.warp(o.deadline + 1);
        _refreshStored();
        ch.cancelOrder(pendingIncrease);
        // liquidation path keeps working
        _setSpot(FEED_MON, 2.88e8);
        address[] memory accts = new address[](1);
        accts[0] = victim;
        assertEq(ch.startAuctions(5, accts, _none()), 1);
        vm.roll(block.number + 3);
        _refreshStored();
        assertEq(ch.backstopTakeBatch(5, accts, _none()), 1);
        // pool ops other than deposits
        (bytes32[] memory pm, int256[] memory sz,) = ch.backstopPositions(5);
        vm.prank(address(timelock));
        ch.backstopReduce(5, pm[0], uint256(sz[0]) / 2, _none());
        _lpWithdraw(lp, 5, 1_000e6); // request + withdraw both work while paused
        // funding, claims, lane funding
        vm.warp(block.timestamp + 61);
        _refreshStored();
        ch.updateFunding(MON);
        vm.prank(keeper);
        ch.claimExecutionFees();
        vm.prank(admin);
        ausd.ownerMint(admin, 1e6);
        vm.prank(admin);
        ch.fundLane(0, 1e6);
        // full close while paused
        _closeAll(trader, MON);
        assertEq(ch.getPosition(trader, MON).size, 0);
        assertSolvent();
    }
}
