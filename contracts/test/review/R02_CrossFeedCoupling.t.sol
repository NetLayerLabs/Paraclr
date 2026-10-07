// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R-02 (Medium): one invalid feed halts every call that carries a full update.
///        **FLIPPED INTO A REGRESSION.**
/// @notice FLIPPED 2026-10-07 after the fix: these tests now assert the exploit FAILS.
///         Fix: a call parses and validates ONLY the markets it touches (the batch accounts', the
///         pool's, the account's); an unusable price is cached as unusable and only reverts where
///         that market is actually needed; batches skip accounts they cannot price
///         (`AccountSkipped`); order executions price other legs from storage / the lane price,
///         never from the supplied blob; `getLiquidatableAccounts` leaves unpriceable accounts out.
contract R02_CrossFeedCouplingTest is ReviewBase {
    uint8 internal constant L = 5;

    function setUp() public override {
        super.setUp();
        _lpDeposit(makeAddr("lp"), L, 50_000e6);
    }

    function _victim(uint256 salt) internal returns (address v) {
        v = laneAddr(L, salt);
        fund(v, 100e6);
        _open(v, MON, true, 1_900e6, 95e6);
    }

    function _widenBtc() internal {
        uint256 raw = uint256(uint64(spot[FEED_BTC]));
        conf[FEED_BTC] = uint64((raw * 3) / 100);
        _store(FEED_BTC, spot[FEED_BTC], block.timestamp);
    }

    function test_R02a_WideConfOnUnheldFeed_DoesNotBlockLiquidations() public {
        address v = _victim(1); // MON only
        _setSpot(FEED_MON, 2.88e8);
        _widenBtc();
        bytes[] memory full = _updAll(block.timestamp); // the keeper's all-feeds blob, BTC wide
        assertEq(ch.startAuctions(L, _one(v), full), 1, "BTC is not touched");
        vm.roll(block.number + 3);
        assertEq(ch.backstopTakeBatch(L, _one(v), full), 1, "pool takes with the full blob");
        // cancel / expire paths with the full blob on another victim
        address w = _victim(9); // opened at 2.88
        _setSpot(FEED_MON, 2.78e8); // equity ~33 in (0, MM ~45.9): auctioned (v3 closes E < 0 at once)
        full = _updAll(block.timestamp);
        assertEq(ch.startAuctions(L, _one(w), full), 1);
        vm.roll(block.number + 1);
        assertFalse(ch.cancelAuction(w, full), "evaluated (still underwater), no revert");
        vm.prank(admin);
        ch.setBackstopMinDiscount(L, 10_000); // keep the pool out, let it expire
        vm.roll(block.number + 20);
        assertEq(ch.expireBatch(L, _one(w), full), 1, "expiry with the full blob");
    }

    function test_R02b_WideConfOnUnheldFeed_MultiLegOrderExecutes() public {
        address a = laneAddr(3, 1);
        fund(a, 10_000e6);
        _open(a, SOL, true, 1_000e6, 100e6);
        uint256 id = _commit(a, MON, int256(_sizeFor(1_000e6, MON)), 100e6, type(uint128).max);
        CH.Order memory o = ch.getOrder(id);
        vm.warp(o.execAfter + 1);
        _refreshStored();
        _widenBtc();
        bytes[] memory first = _upd1(FEED_MON, spot[FEED_MON], o.execAfter, o.execAfter - 1);
        bytes[] memory latest = _updAll(block.timestamp);
        bytes[] memory data = new bytes[](2);
        data[0] = first[0];
        data[1] = latest[0];
        vm.prank(keeper);
        ch.executeOrder(id, data); // the keeper's exact data shape
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Executed));
    }

    function test_R02c_UnpriceableAccountIsSkipped_BatchContinues() public {
        address v = _victim(2); // MON only
        address w = laneAddr(L, 3);
        fund(w, 100e6);
        _open(w, BTC, true, 1_000e6, 50e6); // holds BTC
        _setSpot(FEED_MON, 2.88e8);
        _widenBtc();
        address[] memory batch = new address[](2);
        batch[0] = v;
        batch[1] = w;
        vm.expectEmit(true, true, false, false, address(ch));
        emit CH.AccountSkipped(L, w);
        assertEq(ch.startAuctions(L, batch, _none()), 1, "v started, w skipped");
        (bool active,,) = ch.auctionOf(v);
        assertTrue(active);
        // keeper scan view: never reverts on the bad feed
        address[] memory liq = ch.getLiquidatableAccounts(L, 0, 100);
        for (uint256 i; i < liq.length; ++i) {
            assertTrue(liq[i] != w, "unpriceable account left out");
        }
    }
}
