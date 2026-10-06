// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {ParaclrClearinghouse} from "./ParaclrClearinghouse.sol";

/// @title ParaclrClearinghouseDemo
/// @notice DEMO / BENCHMARK ONLY. Never deploy this variant with real money.
///
/// It is the production `ParaclrClearinghouse` plus one owner-only function, `seedAccounts`,
/// which creates synthetic cross-margin accounts so the flash-crash benchmark can put hundreds
/// of accounts on chain without funding hundreds of EOAs. Everything else (margin maths,
/// lane sharding, liquidation, events) is inherited unchanged, so the liquidation numbers the
/// benchmark measures are those of the real contract.
///
/// What seeding does, per account:
///   - registers the given address in its natural lane (`uint160(account) % 8`), exactly as a
///     first `deposit` would (emits `AccountRegistered` + `Deposit`);
///   - credits `collateral` AUSD;
///   - opens each listed position at the current oracle mark through the same internal path as
///     `openPosition` (same validation, same initial-margin check, emits `PositionOpened`).
/// The total collateral is pulled from the owner with one `transferFrom` and credited through the
/// same ledger path as `deposit`, so the solvency identity (see ParaclrClearinghouse) holds.
///
/// Trust caveats (why this is demo-only): the owner chooses which addresses get accounts and
/// pays for them. Seeded addresses are normally keyless (derived from a hash), so their
/// collateral can only leave through liquidation; if the owner seeded an address someone controls,
/// that person would receive owner-funded positions. Nothing here lets the owner take funds.
contract ParaclrClearinghouseDemo is ParaclrClearinghouse {
    struct SeedPosition {
        bytes32 marketId;
        bool isLong;
        uint256 margin; // AUSD 1e6
        uint256 leverage; // 1..20
    }

    struct SeedParams {
        address account;
        uint256 collateral; // AUSD 1e6, credited before positions are opened
        SeedPosition[] positions;
    }

    /// @notice One `seedAccounts` call: `accounts` seeded, `positions` opened, AUSD pulled.
    event AccountsSeeded(address indexed funder, uint256 accounts, uint256 positions, uint256 totalCollateral);

    /// @param sharedState_ false = Paraclr lanes (this contract); `NaiveClearinghouseDemo`
    ///        passes true for the X-ray baseline.
    constructor(address initialOwner, IERC20 ausd_, IPriceOracle oracle_, bool sharedState_)
        ParaclrClearinghouse(initialOwner, ausd_, oracle_, sharedState_)
    {}

    /// @notice DEMO ONLY. Create synthetic accounts with collateral and positions at the current
    ///         mark, funded by the owner (requires `AUSD.approve(this, Σcollateral)`).
    /// @dev Reverts on the same conditions as `deposit`/`openPosition` (unlisted market, bad
    ///      leverage, existing position, insufficient initial margin, stale price). Seeding an
    ///      already-registered account tops up its collateral without re-registering it.
    /// @return totalCollateral AUSD pulled from the owner.
    function seedAccounts(SeedParams[] calldata seeds)
        external
        onlyOwner
        nonReentrant
        returns (uint256 totalCollateral)
    {
        uint256 positions;
        for (uint256 i; i < seeds.length; ++i) {
            SeedParams calldata s = seeds[i];
            if (s.account == address(0)) revert ZeroAddress();
            if (s.collateral == 0) revert ZeroAmount();
            uint8 lane = _creditCollateral(s.account, s.collateral);
            emit Deposit(s.account, lane, s.collateral);
            for (uint256 j; j < s.positions.length; ++j) {
                SeedPosition calldata p = s.positions[j];
                _openPosition(s.account, p.marketId, p.isLong, p.margin, p.leverage);
            }
            totalCollateral += s.collateral;
            positions += s.positions.length;
        }
        _safeTransferFrom(msg.sender, address(this), totalCollateral);
        emit AccountsSeeded(msg.sender, seeds.length, positions, totalCollateral);
    }
}
