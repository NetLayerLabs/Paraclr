// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {ParaclrClearinghouseDemo} from "./ParaclrClearinghouseDemo.sol";

/// @title NaiveClearinghouseDemo
/// @notice DEMO / BENCHMARK ONLY: the deliberately naive baseline for the Conflict X-ray.
///
/// It is `ParaclrClearinghouseDemo` with `sharedState = true`: every per-lane aggregate
/// (insurance fund, bad debt, open interest, backstop pool, solvency ledger, keeper rewards owed,
/// auction list and counters) maps to ONE shared storage key, as in a textbook clearinghouse
/// with global accumulators. The code is identical — the only difference is the storage key
/// chosen by `_k(lane)` — so per-lane keeper batches that are conflict-free on Paraclr can be
/// shown to read/write the same slots here.
///
/// Behavioural consequences (by design): lane-scoped views (`getLane`, `laneLedger`,
/// `backstopNav`, `laneOpenInterest`, `auctionStats`, …) return the shared totals for every lane,
/// there is one backstop pool for all lanes, and `getAuctionAccounts(lane, …)` pages the shared
/// auction list filtered to `lane`. Account / position state and the lane account registry are
/// keyed exactly as in Paraclr.
contract NaiveClearinghouseDemo is ParaclrClearinghouseDemo {
    constructor(address initialOwner, IERC20 ausd_, IPriceOracle oracle_)
        ParaclrClearinghouseDemo(initialOwner, ausd_, oracle_, true)
    {}
}
