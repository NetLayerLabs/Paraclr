// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReviewBase} from "./ReviewBase.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @title R4-03 (Low): R3-03 residual. Exempt top-ups made in a dip became ordinary collateral after
///        the recovery. **FLIPPED INTO A REGRESSION (v5).**
/// @notice FLIPPED 2026-10-07 after the v5 fix: the 22-round oscillation can no longer pass the caps.
///         Original finding (v4): a top-up only restored IM, but nothing marked the exempt money; after
///         the price recovered it was free collateral and an increase booked it as new margin. At 10x,
///         22 round trips of ±1% took one account to 396.98 AUSD (cap 50).
///         Fix (v5): a margin-adding increase is refused while the account's collateral is above
///         `maxDepositPerAccount` (`CollateralAboveCap`), at commit AND again at fill. Exempt money
///         can then only offset the account's own losses, never fund new risk.
contract R4_03_OscillationRatchetTest is ReviewBase {
    uint8 internal constant L = 5;
    address internal u;

    function setUp() public override {
        super.setUp();
        _betaCaps(); // 50 / 500 / 10x
        vm.prank(admin);
        ch.setMarketConfig(MON, FEED_MON, 100_000e6, 5_000e6, 100); // deploy-like absolute OI cap
        u = laneAddr(L, 1);
        fund(u, 50e6);
        _open(u, MON, true, 495e6, 50e6); // ~10x
        vm.prank(admin);
        ausd.ownerMint(u, 10_000e6);
        vm.prank(u);
        ausd.approve(address(ch), type(uint256).max);
    }

    function test_R4_03_OscillationCannotPassTheCaps() public {
        uint256 margin0 = ch.getPosition(u, MON).margin;
        uint256 exemptTotal;
        uint256 refused;
        for (uint256 i; i < 22; ++i) {
            _setSpot(FEED_MON, 2.97e8); // -1% dip
            uint256 allow = ch.topUpAllowance(u);
            if (allow > 0) {
                vm.prank(u);
                ch.deposit(allow); // fully exempt (restores IM, never above)
                exemptTotal += allow;
            }
            _setSpot(FEED_MON, 3e8); // recovery
            int256 coll = collateralOf(u);
            uint256 free = uint256(coll) - ch.getPosition(u, MON).margin - 5;
            // the PoC's step: book the free (exempt) collateral as new margin at ~10x
            vm.prank(u);
            (bool ok, bytes memory ret) = address(ch).call{value: EXEC_FEE}(
                abi.encodeCall(CH.commitOrder, (MON, int256(_sizeFor((free * 99) / 10, MON)), free, type(uint128).max))
            );
            assertFalse(ok, "margin-adding increase refused");
            assertEq(ret, abi.encodeWithSelector(CH.CollateralAboveCap.selector, coll, uint256(50e6)));
            ++refused;
        }
        int256 collEnd = collateralOf(u);
        emit log_named_decimal_int("collateral after 22 rounds (cap 50)", collEnd, 6);
        emit log_named_decimal_uint("deposited outside the caps (one dip's loss)", exemptTotal, 6);
        assertEq(refused, 22);
        assertEq(ch.getPosition(u, MON).margin, margin0, "no margin booked from exempt money");
        assertLt(exemptTotal, 6e6, "exempt inflow = one 1% dip at 10x, once (was 348.95)");
        assertLe(collEnd, 50e6 + int256(exemptTotal), "collateral = cap + that one dip only");
        assertLe(ch.laneTvl(L), ch.maxTvlPerLane(), "lane within its cap");
        assertSolvent();
    }

    /// @notice The rule is re-checked at fill: an order committed while collateral is within the cap
    ///         fails if an exempt top-up has lifted collateral above the cap before execution.
    function test_R4_03b_RecheckedAtFill() public {
        address u2 = laneAddr(L, 2);
        fund(u2, 50e6);
        _open(u2, MON, true, 400e6, 40e6); // 10x on 40 of the 50: 10 of collateral headroom
        uint256 margin0 = ch.getPosition(u2, MON).margin;
        assertLe(collateralOf(u2), 50e6);
        uint256 id = _commit(u2, MON, int256(_sizeFor(45e6, MON)), 5e6, type(uint128).max);
        _setSpot(FEED_MON, 2.88e8); // -4% before execution: equity below IM, exempt top-up
        uint256 allow = ch.topUpAllowance(u2);
        assertGt(allow, 0);
        vm.prank(admin);
        ausd.ownerMint(u2, allow);
        vm.prank(u2);
        ausd.approve(address(ch), type(uint256).max);
        vm.prank(u2);
        ch.deposit(allow);
        assertGt(collateralOf(u2), 50e6, "above the cap through the exemption");
        _setSpot(FEED_MON, 3e8); // recovery
        _execute(id);
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Failed), "refused at fill");
        assertEq(ch.getPosition(u2, MON).margin, margin0, "margin unchanged");
        assertSolvent();
    }
}
