// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R3-03 (Low/Medium): R2-01 residual. The 110% top-up target still compounded past the caps.
///        **FLIPPED INTO A REGRESSION (v4).**
/// @notice FLIPPED 2026-10-07 after the v4 fix: the 28-order ratchet now books NOTHING.
///         Original finding (v3): a cap-exempt top-up restored equity to 110% of initial margin; the
///         extra 10% was free collateral that an ~1x increase order booked as new margin, and the
///         next 1e-8 USD down-tick re-opened the exemption: ~1.1x compounding per order, far past
///         both beta caps.
///         Fix (v4): `TOP_UP_TARGET_BPS = 10_000`: an exempt top-up restores equity to exactly the
///         initial margin, never above, so exempt money can never fund new margin. The only exempt
///         inflow left is what offsets the account's own losses.
contract R3_03_TopUpRatchetResidualTest is ReviewBase {
    uint8 internal constant L = 5;

    function setUp() public override {
        super.setUp();
        _betaCaps(); // 50 AUSD / account, 500 AUSD / lane, 10x
        vm.prank(admin);
        ch.setMarketConfig(MON, FEED_MON, 100_000e6, 5_000e6, 100); // deploy-like absolute OI cap
    }

    function test_R3_03_RatchetCannotPassEitherCap() public {
        assertEq(ch.TOP_UP_TARGET_BPS(), 10_000);
        address u = laneAddr(L, 1);
        fund(u, 50e6);
        _open(u, MON, true, 51e6, 50e6); // ~1x
        vm.prank(admin);
        ausd.ownerMint(u, 100_000e6);
        vm.prank(u);
        ausd.approve(address(ch), type(uint256).max);

        uint256 exempt;
        int64 p0 = spot[FEED_MON];
        uint256 margin0 = ch.getPosition(u, MON).margin;
        for (uint256 i; i < 28; ++i) {
            // the same down-tick hunt as the PoC
            uint256 allow;
            for (uint256 t; allow == 0 && t < 100; ++t) {
                _setSpot(FEED_MON, spot[FEED_MON] - 5);
                allow = ch.topUpAllowance(u);
            }
            assertGt(allow, 0, "equity < IM again");
            vm.prank(u);
            ch.deposit(allow); // fully exempt
            exempt += allow;
            (int256 e,, uint256 im, uint256 n) = ch.accountHealth(u);
            assertEq(e, int256(im), "exempt top-up restores equity to IM, never above");
            assertEq(ch.topUpAllowance(u), 0);
            // try to book any free collateral as new margin at ~1x (the PoC's step): it fails
            uint256 free = uint256(collateralOf(u)) - ch.getPosition(u, MON).margin;
            if (free != 0) {
                uint256 target = ((im + free) * 101) / 100; // keep margin <= notional (~1x)
                uint256 addN = target > n ? target - n : 1e6;
                uint256 id = _commit(u, MON, int256(_sizeFor(addN, MON)), free, type(uint128).max);
                _execute(id);
                assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Failed), "no new margin");
            }
            // and nothing beyond the exemption gets past the account cap
            int256 c = collateralOf(u);
            uint256 room = c < 50e6 ? uint256(50e6 - c) : 0;
            vm.prank(u);
            vm.expectPartialRevert(CH.DepositCapExceeded.selector);
            ch.deposit(room + 1);
        }
        int256 coll = collateralOf(u);
        uint256 lossUnits = uint256(int256(p0 - spot[FEED_MON]));
        emit log_named_uint("total price drift (1e-8 USD units)", lossUnits);
        emit log_named_decimal_int("one account's collateral (cap 50)", coll, 6);
        emit log_named_decimal_uint("exempt top-ups (= own losses)", exempt, 6);
        emit log_named_decimal_uint("lane TVL (cap 500)", ch.laneTvl(L), 6);
        assertEq(ch.getPosition(u, MON).margin, margin0, "no margin booked from exempt money");
        assertLe(coll, 50e6 + int256(exempt), "collateral = cap + offset losses only");
        assertLt(exempt, 1e5, "exempt inflow is only the (tiny) losses it offsets");
        assertLe(ch.laneTvl(L), ch.maxTvlPerLane(), "lane within its cap");
        assertSolvent();
    }
}
