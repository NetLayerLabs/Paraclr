// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {ProdTestBase} from "../prod/ProdTestBase.sol";
import {MockPyth} from "../prod/mocks/MockPyth.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @notice Adversarial review helpers (REVIEW ONLY). Reuses the production fixture
///         (`ProdTestBase`: MockAUSD, MockPyth with the real feed ids, 3 markets, 100k AUSD of
///         insurance per lane, generous caps) and adds what the PoCs need: explicit per-feed
///         updates, "stored-only" Pyth writes (the on-chain push lagging the market), the beta caps
///         from the deploy script, LP helpers and a bare clearinghouse with custom lane funding.
abstract contract ReviewBase is ProdTestBase {
    // ------------------------------------------------------------------ prices

    /// @dev One blob with explicit prices for MON / SOL / BTC published at `t` (prev `t − 1`).
    function _upd3(int64 mon, int64 sol, int64 btc, uint256 t) internal view returns (bytes[] memory u) {
        MockPyth.Msg[] memory msgs = new MockPyth.Msg[](3);
        msgs[0] = _msg(FEED_MON, mon, t, t - 1);
        msgs[1] = _msg(FEED_SOL, sol, t, t - 1);
        msgs[2] = _msg(FEED_BTC, btc, t, t - 1);
        u = new bytes[](1);
        u[0] = abi.encode(PYTH_MAGIC, msgs);
    }

    /// @dev Every feed at spot, except MON at `mon`, published at `t`.
    function _updMon(int64 mon, uint256 t) internal view returns (bytes[] memory) {
        return _upd3(mon, spot[FEED_SOL], spot[FEED_BTC], t);
    }

    /// @dev Write ONLY the Pyth-stored price (what Pyth's on-chain push last wrote), leaving
    ///      `spot` (the test's notion of the live market) untouched.
    function _store(bytes32 feed, int64 price, uint256 t) internal {
        pyth.setStoredPrice(feed, price, conf[feed], EXPO, t);
    }

    function _one(address a) internal pure returns (address[] memory l) {
        l = new address[](1);
        l[0] = a;
    }

    // ------------------------------------------------------------------ config

    /// @dev The beta caps the deploy script applies by default (50 AUSD / account, 500 AUSD /
    ///      lane, 10x, 5 bps fee, 10 AUSD minimum position, OI multiplier 5x).
    function _betaCaps() internal {
        vm.startPrank(admin);
        ch.setCaps(50e6, 500e6, 50_000);
        ch.setRiskParams(10, 5, 10e6);
        vm.stopPrank();
    }

    /// @dev Replace `ch` with a fresh clearinghouse on the same token / Pyth, 3 markets, large
    ///      caps, and `seed[k]` AUSD of insurance in lane k (0 = unfunded).
    function _bareClearinghouse(uint256[8] memory seed) internal {
        ch = new CH(admin, IERC20(address(ausd)), IPyth(address(pyth)));
        vm.startPrank(admin);
        MON = ch.listMarket("MON/AUSD", FEED_MON, 100_000e6, 10_000_000e6, 100);
        SOL = ch.listMarket("SOL/AUSD", FEED_SOL, 100_000e6, 10_000_000e6, 100);
        BTC = ch.listMarket("BTC/AUSD", FEED_BTC, 100_000e6, 10_000_000e6, 100);
        ch.setCaps(1_000_000e6, 100_000_000e6, 50_000);
        ch.setRiskParams(10, 5, 10e6);
        ch.setGuardian(guardian);
        ausd.approve(address(ch), type(uint256).max);
        uint256 total;
        for (uint8 k; k < 8; ++k) {
            total += seed[k];
        }
        ausd.ownerMint(admin, total);
        for (uint8 k; k < 8; ++k) {
            if (seed[k] > 0) ch.fundLane(k, seed[k]);
        }
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ actors

    function _lpDeposit(address lp, uint8 lane, uint256 amount) internal returns (uint256 shares) {
        vm.prank(admin);
        ausd.ownerMint(lp, amount);
        vm.startPrank(lp);
        ausd.approve(address(ch), type(uint256).max);
        shares = ch.backstopDeposit(lane, amount, _none());
        vm.stopPrank();
    }

    function _insurance(uint8 lane) internal view returns (uint256 ins) {
        (ins,,,,) = ch.getLane(lane);
    }

    function _badDebt(uint8 lane) internal view returns (uint256 bd) {
        (, bd,,,) = ch.getLane(lane);
    }
}
