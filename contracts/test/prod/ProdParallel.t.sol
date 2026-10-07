// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ProdTestBase} from "./ProdTestBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";
import {console2} from "forge-std/console2.sol";

/// @notice The lane guarantee on the production contract, checked with Foundry's storage-access
///         recorder (`vm.record` / `vm.accesses`, clearinghouse storage only; transient storage
///         is not recorded and creates no cross-tx conflict). From identical pre-states, a lane-3
///         tx and a lane-5 tx must have no write/write and no read/write overlap — the condition
///         under which Monad's optimistic parallel execution needs no re-execution.
contract ProdParallelTest is ProdTestBase {
    struct Access {
        bytes32[] reads;
        bytes32[] writes;
    }

    address[] internal book3;
    address[] internal book5;
    address internal k3 = makeAddr("keeper-lane3");
    address internal k5 = makeAddr("keeper-lane5");

    function setUp() public override {
        super.setUp();
        address lp = makeAddr("lp");
        vm.prank(admin);
        ausd.ownerMint(lp, 100_000e6);
        vm.startPrank(lp);
        ausd.approve(address(ch), type(uint256).max);
        ch.backstopDeposit(3, 50_000e6, _none());
        ch.backstopDeposit(5, 50_000e6, _none());
        vm.stopPrank();
        vm.deal(k3, 10 ether);
        vm.deal(k5, 10 ether);
        for (uint256 i; i < 4; ++i) {
            book3.push(_trader(3, i));
            book5.push(_trader(5, i));
        }
        // the same funding update both lanes read (the "star"), done before recording
        vm.warp(block.timestamp + 61);
        _refreshStored();
        ch.updateFunding(MON);
    }

    function _trader(uint8 lane, uint256 i) internal returns (address t) {
        t = laneAddr(lane, 1_000 + i);
        fund(t, 100e6);
        _open(t, MON, true, 1_900e6, 95e6);
    }

    /// @dev A well-collateralised trader with a MON long (for order-path recordings).
    function _rich(uint8 lane, uint256 i) internal returns (address t) {
        t = laneAddr(lane, 5_000 + i);
        fund(t, 1_000e6);
        _open(t, MON, true, 1_000e6, 100e6);
    }

    function _execAs(address k, uint256 id) internal returns (Access memory a) {
        CH.Order memory o = ch.getOrder(id);
        bytes[] memory u = _updAll(o.execAfter);
        vm.record();
        vm.prank(k);
        ch.executeOrder(id, u);
        (a.reads, a.writes) = vm.accesses(address(ch));
    }

    function test_ParallelSafety_OrderExecutionsTouchDisjointStorage() public {
        // one increase (new market) and one reduce per lane, committed in the same block
        address a3 = _rich(3, 0);
        address a5 = _rich(5, 0);
        address b3 = _rich(3, 1);
        address b5 = _rich(5, 1);
        uint256 inc3 = _commit(a3, SOL, int256(_sizeFor(100e6, SOL)), 5e6, type(uint128).max);
        uint256 inc5 = _commit(a5, SOL, int256(_sizeFor(100e6, SOL)), 5e6, type(uint128).max);
        uint256 red3 = _commit(b3, MON, -int256(ch.getPosition(b3, MON).size / 2), 0, 1);
        uint256 red5 = _commit(b5, MON, -int256(ch.getPosition(b5, MON).size / 2), 0, 1);
        vm.warp(ch.getOrder(inc3).execAfter + 1);
        _refreshStored();

        uint256 snap = vm.snapshotState();
        Access memory e3 = _execAs(k3, inc3);
        vm.revertToState(snap);
        Access memory e5 = _execAs(k5, inc5);
        vm.revertToState(snap);
        Access memory r3 = _execAs(k3, red3);
        vm.revertToState(snap);
        Access memory r5 = _execAs(k5, red5);
        vm.revertToState(snap);
        _assertNoConflict(e3, e5, "increase lane3 vs lane5");
        _assertNoConflict(r3, r5, "reduce lane3 vs lane5");
        _assertNoConflict(e3, r5, "increase lane3 vs reduce lane5");
        _assertNoConflict(r3, e5, "reduce lane3 vs increase lane5");
        // the same keeper key serving both lanes still writes disjoint (lane-keyed) fee slots
        Access memory s3 = _execAs(keeper, inc3);
        vm.revertToState(snap);
        Access memory s5 = _execAs(keeper, inc5);
        vm.revertToState(snap);
        _assertNoConflict(s3, s5, "one keeper, two lanes");
        console2.log("executeOrder writes (lane 3 increase):", e3.writes.length);
    }

    /// @notice Negative control: two order executions in the SAME lane do share slots (lane
    ///         ledger, insurance, OI), so the recorder does detect conflicts when they exist.
    function test_ParallelSafety_SameLaneExecutionsDoConflict() public {
        address a = _rich(3, 0);
        address b = _rich(3, 1);
        uint256 ia = _commit(a, SOL, int256(_sizeFor(100e6, SOL)), 5e6, type(uint128).max);
        uint256 ib = _commit(b, SOL, int256(_sizeFor(100e6, SOL)), 5e6, type(uint128).max);
        vm.warp(ch.getOrder(ia).execAfter + 1);
        _refreshStored();
        uint256 snap = vm.snapshotState();
        Access memory ea = _execAs(k3, ia);
        vm.revertToState(snap);
        Access memory eb = _execAs(k3, ib);
        vm.revertToState(snap);
        uint256 shared;
        for (uint256 i; i < ea.writes.length; ++i) {
            for (uint256 j; j < eb.writes.length; ++j) {
                if (ea.writes[i] == eb.writes[j]) ++shared;
            }
        }
        assertGt(shared, 0, "same-lane executions share lane aggregates");
    }

    function test_ParallelSafety_CommitsTouchDisjointStorage() public {
        uint256 snap = vm.snapshotState();
        address a3 = _rich(3, 0);
        address a5 = _rich(5, 0);
        snap = vm.snapshotState();
        Access memory c3 = _commitRec(a3);
        vm.revertToState(snap);
        Access memory c5 = _commitRec(a5);
        vm.revertToState(snap);
        _assertNoConflict(c3, c5, "commit lane3 vs lane5");
    }

    function _commitRec(address who) internal returns (Access memory a) {
        int256 sz = int256(_sizeFor(100e6, SOL));
        vm.record();
        vm.prank(who);
        ch.commitOrder{value: EXEC_FEE}(SOL, sz, 5e6, type(uint128).max);
        (a.reads, a.writes) = vm.accesses(address(ch));
    }

    function test_ParallelSafety_LiquidationBatchesTouchDisjointStorage() public {
        _setSpot(FEED_MON, 2.88e8); // −4%: both books under maintenance
        Access[6] memory acc;
        uint256 snap = vm.snapshotState();
        acc[0] = _batch(k3, abi.encodeCall(CH.startAuctions, (3, book3, _none())));
        vm.revertToState(snap);
        acc[1] = _batch(k5, abi.encodeCall(CH.startAuctions, (5, book5, _none())));
        vm.revertToState(snap);

        ch.startAuctions(3, book3, _none());
        ch.startAuctions(5, book5, _none());
        vm.roll(block.number + 3);
        snap = vm.snapshotState();
        acc[2] = _batch(k3, abi.encodeCall(CH.backstopTakeBatch, (3, book3, _none())));
        vm.revertToState(snap);
        acc[3] = _batch(k5, abi.encodeCall(CH.backstopTakeBatch, (5, book5, _none())));
        vm.revertToState(snap);

        // expiry path: nobody took; at the max discount the auctions expire
        vm.roll(block.number + 20);
        _refreshStored();
        snap = vm.snapshotState();
        acc[4] = _batch(k3, abi.encodeCall(CH.expireBatch, (3, book3, _none())));
        vm.revertToState(snap);
        acc[5] = _batch(k5, abi.encodeCall(CH.expireBatch, (5, book5, _none())));
        vm.revertToState(snap);

        for (uint256 i; i < 6; i += 2) {
            assertGt(acc[i].writes.length, 0);
            assertGt(acc[i + 1].writes.length, 0);
            _assertNoConflict(acc[i], acc[i + 1], "lane batch");
        }
        // every lane-3 auction tx vs every lane-5 auction tx
        for (uint256 i; i < 6; i += 2) {
            for (uint256 j = 1; j < 6; j += 2) {
                _assertNoConflict(acc[i], acc[j], "cross auction tx");
            }
        }
    }

    function test_ParallelSafety_OrderVsOtherLaneLiquidation() public {
        _setSpot(FEED_MON, 2.88e8);
        address a3 = laneAddr(3, 77);
        fund(a3, 1_000e6);
        uint256 id = _commit(a3, SOL, int256(_sizeFor(100e6, SOL)), 10e6, type(uint128).max);
        ch.startAuctions(5, book5, _none());
        vm.roll(block.number + 3);
        vm.warp(ch.getOrder(id).execAfter + 1);
        _refreshStored();
        uint256 snap = vm.snapshotState();
        Access memory e3 = _execAs(k3, id);
        vm.revertToState(snap);
        Access memory t5 = _batch(k5, abi.encodeCall(CH.backstopTakeBatch, (5, book5, _none())));
        vm.revertToState(snap);
        _assertNoConflict(e3, t5, "order lane3 vs pool take lane5");
    }

    /// @notice The documented "star": `updateFunding` writes the market's funding slot, which
    ///         trades only READ; trades never write it.
    function test_FundingUpdateIsTheOnlyWriterOfTheFundingSlot() public {
        address a3 = _rich(3, 0);
        address a5 = _rich(5, 0);
        uint256 id = _commit(a3, SOL, int256(_sizeFor(100e6, SOL)), 5e6, type(uint128).max);
        vm.warp(ch.getOrder(id).execAfter + 61);
        _refreshStored();
        uint256 snap = vm.snapshotState();
        Access memory f = _batch(keeper, abi.encodeCall(CH.updateFunding, (SOL)));
        vm.revertToState(snap);
        assertEq(f.writes.length, 1, "updateFunding writes exactly one slot");
        // the order executes after its deadline? keep in window: re-commit
        id = _commit(a5, SOL, int256(_sizeFor(100e6, SOL)), 5e6, type(uint128).max);
        vm.warp(ch.getOrder(id).execAfter + 1);
        _refreshStored();
        Access memory e = _execAs(k5, id);
        for (uint256 i; i < e.writes.length; ++i) {
            assertTrue(e.writes[i] != f.writes[0], "trade wrote the funding slot");
        }
        bool reads;
        for (uint256 i; i < e.reads.length; ++i) {
            if (e.reads[i] == f.writes[0]) reads = true;
        }
        assertTrue(reads, "trade reads the funding slot");
    }

    function _batch(address k, bytes memory data) internal returns (Access memory a) {
        vm.record();
        vm.prank(k);
        (bool ok, bytes memory ret) = address(ch).call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        (a.reads, a.writes) = vm.accesses(address(ch));
    }

    function _assertNoConflict(Access memory a, Access memory b, string memory what) internal pure {
        _disjoint(a.writes, b.writes, what);
        _disjoint(a.writes, b.reads, what);
        _disjoint(b.writes, a.reads, what);
    }

    function _disjoint(bytes32[] memory x, bytes32[] memory y, string memory what) internal pure {
        for (uint256 i; i < x.length; ++i) {
            for (uint256 j; j < y.length; ++j) {
                if (x[i] == y[j]) revert(string.concat("storage conflict: ", what));
            }
        }
    }
}
