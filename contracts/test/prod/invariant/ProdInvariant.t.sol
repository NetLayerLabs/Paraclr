// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {MockAUSD} from "../../../src/MockAUSD.sol";
import {ParaclrClearinghouseProd as CH} from "../../../src/prod/ParaclrClearinghouseProd.sol";
import {MockPyth} from "../mocks/MockPyth.sol";

/// @notice Random sequences against the production clearinghouse: deposits / withdrawals,
///         delayed orders (commit, execute with the unique Pyth update, cancel), price moves,
///         time, funding updates, auctions (start, pool take, external take, cure, expiry),
///         backstop pools (incl. full drains: operator unwind + every LP out, which exercises
///         pool resets, receivable netting and sweeps), lane funding, claims, guardian pauses /
///         timelock unpauses, feed replacements scheduled and executed through the real
///         TimelockController (live and dead old feed), and admin calls from non-owners. Every call
///         is bounded and try/caught; ghost variables record anything the invariants must never see.
contract ProdHandler is Test {
    CH public ch;
    MockAUSD public ausd;
    MockPyth public pyth;
    address public owner; // the timelock
    address public guardian;
    address public multisig; // the timelock's proposer / executor

    bytes32[] public markets;
    bytes32[] public feedIds;
    int64[] public basePx;
    mapping(bytes32 => int64) public spot; // by feed
    address[] public actors; // 2 per lane
    address[] public lps;
    address[] public keepers;
    uint256[] public orders; // every order id ever committed

    bytes4 internal constant MAGIC = 0x504e4155;

    // ghosts
    mapping(bytes32 => uint256) public calls;
    uint256 public panics;
    uint256 public capViolations;
    uint256 public pauseViolations;
    uint256 public adminViolations;
    uint256 public traderOverchargeViolations;
    uint256 public externalSubsidyViolations;
    /// @dev R-01: a lane's last-used price moved backwards in time.
    uint256 public lanePriceRegressions;
    /// @dev R-09: a pool take paid the pool more than the taken accounts' positive equity.
    uint256 public poolSubsidyViolations;
    mapping(uint8 => mapping(bytes32 => uint256)) public lastLaneTime;
    /// @dev R3-01: Σ BackstopLossAbsorbed − BackstopRepaid − BackstopReceivableNetted − forgiven
    ///      (BackstopSwept), per lane, from the events of every call.
    mapping(uint8 => uint256) public ghostReceivable;
    uint256 public receivableGhostViolations;
    /// @dev R3-01: a pool deposit / withdrawal moved value between LPs (dilution or overpayment).
    uint256 public lpValueViolations;
    /// @dev R3-01: a pool deposit succeeded with a receivable outstanding or the NAV cap binding.
    uint256 public depositGateViolations;
    /// @dev R4-01 (fair-value ghost): an exit paid more than its share of the pool's fair exit
    ///      value, computed here independently of the contract's NAV code: the pool's CASH from the
    ///      ledger. Unrealised gains, the receivable and insurance never enter an exit price (v5), so
    ///      no manipulation of them can lift what an exit is paid.
    uint256 public fairValueViolations;
    /// @dev R4-02: right after an exit that emptied a pool, the pool held a position, cash or a
    ///      receivable (checked at that moment, before any later unwind could hide it).
    uint256 public emptyPoolViolations;
    uint256 public feedNonce;
    bool internal preFillAboveCap;

    constructor(
        CH ch_,
        MockAUSD ausd_,
        MockPyth pyth_,
        address owner_,
        address guardian_,
        address multisig_,
        bytes32[] memory m,
        bytes32[] memory f
    ) {
        ch = ch_;
        ausd = ausd_;
        pyth = pyth_;
        owner = owner_;
        guardian = guardian_;
        multisig = multisig_;
        markets = m;
        feedIds = f;
        for (uint256 i; i < f.length; ++i) {
            (int64 p,,,) = _stored(f[i]);
            spot[f[i]] = p;
            basePx.push(p);
        }
        for (uint8 lane; lane < 8; ++lane) {
            for (uint256 j; j < 2; ++j) {
                uint160 base = uint160(uint256(keccak256(abi.encode("prod-inv", lane, j))));
                address a = address((base & ~uint160(7)) | uint160(lane));
                actors.push(a);
                vm.deal(a, 1_000 ether);
                vm.prank(a);
                ausd.approve(address(ch), type(uint256).max);
            }
        }
        lps.push(makeAddr("lp0"));
        lps.push(makeAddr("lp1"));
        for (uint256 i; i < lps.length; ++i) {
            vm.prank(lps[i]);
            ausd.approve(address(ch), type(uint256).max);
        }
        clockT = block.timestamp;
        clockB = block.number;
        vm.deal(address(this), 1_000_000 ether);
        keepers.push(makeAddr("keeperA"));
        keepers.push(makeAddr("keeperB"));
        for (uint256 i; i < keepers.length; ++i) {
            vm.deal(keepers[i], 1_000 ether);
        }
    }

    function _stored(bytes32 feed) internal view returns (int64 p, uint64 c, int32 e, uint256 t) {
        (bool ok, bytes memory ret) = address(pyth).staticcall(abi.encodeWithSignature("getPriceUnsafe(bytes32)", feed));
        require(ok);
        (p, c, e, t) = abi.decode(ret, (int64, uint64, int32, uint256));
    }

    /// @dev Handler-owned clock, re-applied on every call so warps / rolls persist.
    uint256 public clockT;
    uint256 public clockB;

    modifier tick(bytes32 name) {
        vm.warp(clockT);
        vm.roll(clockB);
        calls[name]++;
        _;
        clockT = block.timestamp;
        clockB = block.number;
        _checkLanePricesMonotonic();
    }

    function _checkLanePricesMonotonic() internal {
        for (uint8 lane; lane < 8; ++lane) {
            for (uint256 i; i < markets.length; ++i) {
                (, uint256 t) = ch.lanePrice(lane, markets[i]);
                if (t < lastLaneTime[lane][markets[i]]) lanePriceRegressions++;
                lastLaneTime[lane][markets[i]] = t;
            }
        }
    }

    /// @notice Setup-only: adopt the current block time / number (after the seeding warps).
    function syncClock() external {
        clockT = block.timestamp;
        clockB = block.number;
    }

    // ------------------------------------------------------------------ views for invariants

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function lpCount() external view returns (uint256) {
        return lps.length;
    }

    function keeperCount() external view returns (uint256) {
        return keepers.length;
    }

    function orderCount() external view returns (uint256) {
        return orders.length;
    }

    // ------------------------------------------------------------------ helpers

    function _refresh() internal {
        for (uint256 i; i < feedIds.length; ++i) {
            bytes32 f = feedIds[i];
            pyth.setStoredPrice(f, spot[f], uint64(uint256(int256(spot[f])) / 10_000), -8, block.timestamp);
        }
    }

    function _updAll(uint256 t) internal view returns (bytes[] memory u) {
        MockPyth.Msg[] memory msgs = new MockPyth.Msg[](feedIds.length);
        for (uint256 i; i < feedIds.length; ++i) {
            bytes32 f = feedIds[i];
            msgs[i] = MockPyth.Msg(f, spot[f], uint64(uint256(int256(spot[f])) / 10_000), -8, uint64(t), uint64(t - 1));
        }
        u = new bytes[](1);
        u[0] = abi.encode(MAGIC, msgs);
    }

    /// @dev Either no update (Pyth-stored prices) or a fresh blob for every feed.
    function _maybeUpd(uint256 seed) internal view returns (bytes[] memory) {
        return seed % 2 == 0 ? new bytes[](0) : _updAll(block.timestamp);
    }

    /// @dev First pending order from a random start (optionally only those still executable).
    function _pendingOrder(uint256 seed, bool live) internal view returns (uint256) {
        uint256 n = orders.length;
        for (uint256 k; k < n; ++k) {
            uint256 id = orders[((seed % n) + k) % n];
            CH.Order memory o = ch.getOrder(id);
            if (o.status != CH.OrderStatus.Pending) continue;
            if (live && block.timestamp > o.deadline) continue;
            return id;
        }
        return 0;
    }

    function _hasPositions(address a) internal view returns (bool) {
        (,,, bytes32[] memory open,,) = ch.getAccount(a);
        return open.length != 0;
    }

    function _isPausedErr(bytes memory ret) internal pure returns (bool) {
        return ret.length >= 4 && bytes4(ret) == CH.IsPaused.selector;
    }

    function _isPanic(bytes memory ret) internal pure returns (bool) {
        return ret.length >= 4 && bytes4(ret) == 0x4e487b71;
    }

    /// @dev Low-level call as `from` with `value`; records panics and feeds every event the call
    ///      emitted to the ghost bookkeeping.
    function _call(address from, uint256 value, bytes memory data) internal returns (bool ok, bytes memory ret) {
        vm.recordLogs();
        vm.prank(from);
        (ok, ret) = address(ch).call{value: value}(data);
        if (!ok && _isPanic(ret)) panics++;
        _processLogs(vm.getRecordedLogs());
    }

    /// @dev Foundry's recordLogs also returns logs of call frames that REVERTED. The only internal
    ///      try/catch with state changes is `executeOrder`'s self-call `selfFill`: when it fails,
    ///      everything it emitted precedes `OrderFailed` and was rolled back, so it is skipped.
    function _processLogs(Vm.Log[] memory logs) internal {
        uint256 from;
        for (uint256 k; k < logs.length; ++k) {
            if (logs[k].emitter == address(ch) && logs[k].topics.length != 0 && logs[k].topics[0] == CH.OrderFailed.selector) {
                from = k + 1;
            }
        }
        for (uint256 k = from; k < logs.length; ++k) {
            Vm.Log memory l = logs[k];
            if (l.emitter != address(ch) || l.topics.length == 0) continue;
            bytes32 t0 = l.topics[0];
            if (t0 == CH.AuctionStarted.selector) {
                // R2-07: an auction never starts on negative equity (AuctionStarted.equity >= 0)
                (, int256 eqAtStart,) = abi.decode(l.data, (uint256, int256, uint256));
                if (eqAtStart < 0) negativeEquityAuctions++;
                continue;
            }
            if (t0 == CH.BackstopPoolReset.selector) {
                calls["pool.reset"]++;
                continue;
            }
            uint8 lane = l.topics.length > 1 ? uint8(uint256(l.topics[1])) : 0;
            if (t0 == CH.BackstopLossAbsorbed.selector) {
                ghostReceivable[lane] += abi.decode(l.data, (uint256));
                calls["receivable.absorbed"]++;
            } else if (t0 == CH.BackstopRepaid.selector) {
                _ghostReceivableDown(lane, abi.decode(l.data, (uint256)));
                calls["receivable.repaid"]++;
            } else if (t0 == CH.BackstopReceivableNetted.selector) {
                _ghostReceivableDown(lane, abi.decode(l.data, (uint256)));
                calls["pool.netted"]++;
            } else if (t0 == CH.BackstopSwept.selector) {
                (uint256 cash, uint256 forgiven) = abi.decode(l.data, (uint256, uint256));
                _ghostReceivableDown(lane, forgiven);
                calls["pool.swept"]++;
                if (forgiven != 0) calls["pool.sweptForgiven"]++;
                if (cash != 0) calls["pool.sweptCash"]++;
            }
        }
    }

    function _ghostReceivableDown(uint8 lane, uint256 amount) internal {
        if (amount > ghostReceivable[lane]) receivableGhostViolations++;
        else ghostReceivable[lane] -= amount;
    }

    /// @dev Pool NAV and share supply by the view (false when a pool leg cannot be priced).
    function _nav(uint8 lane) internal view returns (bool ok, int256 eq, uint256 supply) {
        try ch.backstopNav(lane) returns (int256 e, int256, int256, uint256 s) {
            return (true, e, s);
        } catch {
            return (false, 0, 0);
        }
    }

    function _laneActors(uint8 lane) internal view returns (address[] memory a) {
        a = new address[](2);
        a[0] = actors[lane * 2];
        a[1] = actors[lane * 2 + 1];
    }

    // ------------------------------------------------------------------ collateral

    function deposit(uint256 actorSeed, uint256 amount) external tick("deposit") {
        address a = actors[actorSeed % actors.length];
        amount = bound(amount, 1e6, 3_000e6);
        vm.prank(address(this));
        ausd.ownerMint(a, amount);
        bool holder = _hasPositions(a);
        if (holder && actorSeed % 3 == 0) return _depositWithPrice(a, amount);
        bool paused = ch.paused();
        uint8 lane = ch.laneOf(a);
        // v3 (R2-01): only `topUpAllowance` may bypass the caps; the rest obeys them
        uint256 allowance = ch.topUpAllowance(a);
        uint256 capped = amount > allowance ? amount - allowance : 0;
        (int256 collBefore,,,,,) = ch.getAccount(a);
        uint256 tvlBefore = ch.laneTvl(lane);
        (bool ok, bytes memory ret) = _call(a, 0, abi.encodeCall(CH.deposit, (amount)));
        if (ok) {
            calls["deposit.ok"]++;
            if (paused && !holder) pauseViolations++;
            if (allowance > 0) calls["deposit.topUp"]++;
            if (!holder && allowance != 0) capViolations++; // no exemption without positions
            if (capped > 0) {
                if (collBefore + int256(capped) > int256(ch.maxDepositPerAccount())) capViolations++;
                if (tvlBefore + capped > ch.maxTvlPerLane()) capViolations++;
            }
        } else if (_isPausedErr(ret) && (!paused || holder)) {
            pauseViolations++;
        }
    }

    /// @dev R3-04: `depositWithPrice` with a fresh update (the stored price may be stale). The
    ///      exemption is reconstructed AFTER the call (prices are fresh then): a deposit only adds
    ///      to equity, so allowance = max(0, IM − (equity_after − amount)); the rest obeys the caps.
    function _depositWithPrice(address a, uint256 amount) internal {
        uint8 lane = ch.laneOf(a);
        (int256 collBefore,,,,,) = ch.getAccount(a);
        uint256 tvlBefore = ch.laneTvl(lane);
        (bool ok, bytes memory ret) =
            _call(a, 1 ether, abi.encodeCall(CH.depositWithPrice, (amount, _updAll(block.timestamp))));
        if (!ok) {
            if (_isPausedErr(ret)) pauseViolations++; // holders may always deposit
            return;
        }
        calls["deposit.withPrice"]++;
        (int256 e,, uint256 im,) = ch.accountHealth(a); // fresh lane prices: never reverts here
        int256 eBefore = e - int256(amount);
        uint256 allowance = eBefore < int256(im) ? uint256(int256(im) - eBefore) : 0;
        uint256 capped = amount > allowance ? amount - allowance : 0;
        if (allowance != 0) calls["deposit.withPrice.topUp"]++;
        if (capped > 0) {
            if (collBefore + int256(capped) > int256(ch.maxDepositPerAccount())) capViolations++;
            if (tvlBefore + capped > ch.maxTvlPerLane()) capViolations++;
        }
    }

    function _marginSum(address a) internal view returns (uint256 sum) {
        (,,, bytes32[] memory open,,) = ch.getAccount(a);
        for (uint256 i; i < open.length; ++i) {
            sum += ch.getPosition(a, open[i]).margin;
        }
    }

    function withdraw(uint256 actorSeed, uint256 frac, uint256 updSeed) external tick("withdraw") {
        address a = actors[actorSeed % actors.length];
        uint256 free;
        try ch.freeCollateral(a) returns (uint256 f) {
            free = f;
        } catch {
            return;
        }
        if (free == 0) return;
        uint256 amount = (free * bound(frac, 1, 100)) / 100;
        if (amount == 0) return;
        (bool ok, bytes memory ret) = _call(a, 0, abi.encodeCall(CH.withdraw, (amount, _maybeUpd(updSeed))));
        if (ok) calls["withdraw.ok"]++;
        else if (_isPausedErr(ret)) pauseViolations++;
    }

    // ------------------------------------------------------------------ orders

    function commit(uint256 actorSeed, uint256 marketSeed, bool buy, uint256 notional, uint256 lev, uint256 slip)
        external
        tick("commit")
    {
        address a = actors[actorSeed % actors.length];
        bytes32 m = markets[marketSeed % markets.length];
        bytes32 f = feedIds[marketSeed % markets.length];
        uint256 px = uint256(int256(spot[f])) * 1e10;
        CH.Position memory p = ch.getPosition(a, m);
        int256 size;
        uint256 margin;
        bool increase = p.size == 0 || p.isLong == buy;
        if (increase) {
            notional = bound(notional, 5e6, 3_000e6);
            lev = bound(lev, 1, 12); // sometimes above the 10x cap
            margin = notional / lev;
            if (p.size == 0 && margin == 0) margin = 1;
            size = int256((notional * 1e30) / px);
        } else {
            // reduce: a fraction of the position, sometimes all of it, sometimes too much (flip)
            uint256 s = (p.size * bound(notional, 1, 105)) / 100;
            size = int256(s);
        }
        if (size == 0) return;
        if (!buy) size = -size;
        // acceptable price: within ±slip of spot (sometimes tight enough to fail)
        uint256 s2 = bound(slip, 0, 300);
        uint256 acceptable = buy ? (px * (10_000 + s2)) / 10_000 : (px * (10_000 - s2)) / 10_000;
        bool paused = ch.paused();
        bool aboveCap = _aboveCap(a); // R4-03: no new margin while collateral is above the cap
        (bool ok, bytes memory ret) =
            _call(a, 0.1 ether, abi.encodeCall(CH.commitOrder, (m, size, margin, acceptable)));
        if (ok) {
            orders.push(abi.decode(ret, (uint256)));
            calls["commit.ok"]++;
            if (paused && increase) pauseViolations++;
            if (increase && margin != 0 && aboveCap) capViolations++;
        } else if (_isPausedErr(ret) && !(paused && increase)) {
            pauseViolations++;
        } else if (ret.length >= 4 && bytes4(ret) == CH.CollateralAboveCap.selector) {
            calls["commit.refusedAboveCap"]++;
        }
    }

    function _aboveCap(address a) internal view returns (bool) {
        (int256 c,,,,,) = ch.getAccount(a);
        return c > int256(ch.maxDepositPerAccount());
    }

    function execute(uint256 orderSeed, uint256 keeperSeed, uint256 lateSeed) external tick("execute") {
        uint256 id = _pendingOrder(orderSeed, true);
        if (id == 0) return;
        CH.Order memory o = ch.getOrder(id);
        if (block.timestamp < o.execAfter + 1) {
            uint256 to = o.execAfter + 1 + bound(lateSeed, 0, 20);
            if (to > o.deadline) to = o.deadline;
            vm.warp(to);
            vm.roll(block.number + 1);
            _refresh();
        }
        CH.Position memory p = ch.getPosition(o.account, o.market);
        bool increase = p.size == 0 || p.isLong == (o.sizeDelta > 0);
        bool paused = ch.paused();
        address k = keepers[keeperSeed % keepers.length];
        bytes[] memory u = _updAll(o.execAfter);
        preFillAboveCap = _aboveCap(o.account);
        (bool ok, bytes memory ret) = _call(k, 1 ether, abi.encodeCall(CH.executeOrder, (id, u)));
        if (!ok) {
            if (_isPausedErr(ret) && !(paused && increase)) pauseViolations++;
            return;
        }
        CH.OrderStatus st = ch.getOrder(id).status;
        if (st == CH.OrderStatus.Executed) {
            calls["execute.filled"]++;
            if (paused && increase) pauseViolations++;
            if (increase) _checkIncreaseCaps(o);
            // R4-03: a margin-adding increase never fills while collateral is above the cap
            if (increase && o.marginDelta != 0 && preFillAboveCap) capViolations++;
        } else {
            calls["execute.failed"]++;
        }
    }

    /// @dev Right after an increase fill: leverage, min size and the lane OI cap held.
    function _checkIncreaseCaps(CH.Order memory o) internal {
        address a = o.account;
        bytes32 m = o.market;
        CH.Position memory p = ch.getPosition(a, m);
        uint256 idx;
        for (uint256 i; i < markets.length; ++i) {
            if (markets[i] == m) idx = i;
        }
        uint256 px = uint256(int256(spot[feedIds[idx]])) * 1e10;
        uint256 notional = (p.size * px) / 1e30;
        // leverage is checked on the gross margin: the fee of this fill is paid out of the margin
        uint256 absDelta = o.sizeDelta >= 0 ? uint256(int256(o.sizeDelta)) : uint256(-int256(o.sizeDelta));
        uint256 fee = (((absDelta * px) / 1e30) * ch.tradingFeeBps() + 9_999) / 10_000;
        uint256 feeFromMargin = fee < o.marginDelta ? fee : o.marginDelta;
        if (notional > (p.margin + feeFromMargin) * ch.maxLeverage()) capViolations++;
        // v3 (R2-01): an order adding margin never leaves margin above notional
        if (o.marginDelta != 0 && p.margin + feeFromMargin > notional) capViolations++;
        if (notional < ch.minPositionNotional()) capViolations++;
        uint8 lane = ch.laneOf(a);
        (uint256 l, uint256 s) = ch.laneOpenInterest(lane, m);
        uint256 cap = ch.laneOiCap(lane, m);
        if ((p.isLong ? l : s) > cap) capViolations++;
    }

    function cancel(uint256 orderSeed, uint256 callerSeed) external tick("cancel") {
        uint256 id = _pendingOrder(orderSeed, false);
        if (id == 0) return;
        CH.Order memory o = ch.getOrder(id);
        if (block.timestamp <= o.deadline) {
            vm.warp(o.deadline + 1);
            vm.roll(block.number + 1);
            _refresh();
        }
        (bool ok, bytes memory ret) = _call(actors[callerSeed % actors.length], 0, abi.encodeCall(CH.cancelOrder, (id)));
        if (ok) calls["cancel.ok"]++;
        else if (_isPausedErr(ret)) pauseViolations++;
    }

    // ------------------------------------------------------------------ market + time

    function movePrice(uint256 feedSeed, uint256 bps) external tick("movePrice") {
        uint256 i = feedSeed % feedIds.length;
        bytes32 f = feedIds[i];
        int256 p = (int256(spot[f]) * int256(bound(bps, 6_500, 13_500))) / 10_000;
        int256 lo = (int256(basePx[i]) * 4) / 10;
        int256 hi = (int256(basePx[i]) * 25) / 10;
        if (p < lo) p = lo;
        if (p > hi) p = hi;
        spot[f] = int64(p);
        _refresh();
    }

    /// @dev A sharp move (−3% .. −20% or +3% .. +20%) on one feed: drives liquidations.
    function crash(uint256 feedSeed, uint256 bps, bool up) external tick("crash") {
        uint256 i = feedSeed % feedIds.length;
        bytes32 f = feedIds[i];
        uint256 move = bound(bps, 300, 2_000); // small gaps land in (0, MM): auctions; large: close-outs
        int256 p = (int256(spot[f]) * int256(up ? 10_000 + move : 10_000 - move)) / 10_000;
        int256 lo = (int256(basePx[i]) * 4) / 10;
        int256 hi = (int256(basePx[i]) * 25) / 10;
        if (p < lo) p = lo;
        if (p > hi) p = hi;
        spot[f] = int64(p);
        _refresh();
    }

    function advanceTime(uint256 secs, uint256 stale) external tick("advanceTime") {
        vm.warp(block.timestamp + bound(secs, 1, 120));
        vm.roll(block.number + bound(secs, 1, 12));
        if (stale % 5 != 0) _refresh(); // sometimes leave Pyth-stored prices stale
    }

    function updateFunding(uint256 marketSeed) external tick("updateFunding") {
        (bool ok, bytes memory ret) =
            _call(keepers[0], 0, abi.encodeCall(CH.updateFunding, (markets[marketSeed % markets.length])));
        if (ok) calls["updateFunding.ok"]++;
        else if (_isPausedErr(ret)) pauseViolations++;
    }

    // ------------------------------------------------------------------ auctions

    function startAuctions(uint256 updSeed) external tick("startAuctions") {
        for (uint8 lane; lane < 8; ++lane) {
            (,,,, uint256 expBefore) = ch.auctionStats(lane);
            address[] memory la = _laneActors(lane);
            // (R2-07, negative equity never auctioned: checked on every AuctionStarted in _call)
            (bool ok, bytes memory ret) =
                _call(keepers[lane % 2], 0, abi.encodeCall(CH.startAuctions, (lane, la, _maybeUpd(updSeed))));
            if (ok) {
                calls["startAuctions.started"] += abi.decode(ret, (uint256));
                (,,,, uint256 expAfter) = ch.auctionStats(lane);
                calls["startAuctions.closedOut"] += expAfter - expBefore;
            } else if (_isPausedErr(ret)) {
                pauseViolations++;
            }
        }
    }

    function backstopTake(uint256 wait, uint256 updSeed) external tick("backstopTake") {
        vm.roll(block.number + bound(wait, 0, 9));
        for (uint8 lane; lane < 8; ++lane) {
            address[] memory list = ch.getAuctionAccounts(lane, 0, 50);
            if (list.length == 0) continue;
            (int256[] memory eq, uint256[] memory pay) = _preTake(list);
            uint256 eqPos;
            for (uint256 k; k < eq.length; ++k) {
                if (eq[k] > 0 && eq[k] != type(int256).max) eqPos += uint256(eq[k]);
            }
            (, uint256 earnedBefore,) = ch.backstopStats(lane);
            (bool ok, bytes memory ret) =
                _call(keepers[lane % 2], 0, abi.encodeCall(CH.backstopTakeBatch, (lane, list, _maybeUpd(updSeed))));
            if (ok) calls["backstopTake.taken"] += abi.decode(ret, (uint256));
            else if (_isPausedErr(ret)) pauseViolations++;
            (, uint256 earnedAfter,) = ch.backstopStats(lane);
            if (earnedAfter - earnedBefore > eqPos) poolSubsidyViolations++; // R-09
            _postTake(list, eq, pay);
        }
    }

    function externalTake(uint256 victimSeed, uint256 topUp) external tick("externalTake") {
        address v;
        for (uint256 k; k < actors.length; ++k) {
            address c = actors[((victimSeed % actors.length) + k) % actors.length];
            (bool on,,) = ch.auctionOf(c);
            if (on) {
                v = c;
                break;
            }
        }
        if (v == address(0)) return;
        uint8 lane = ch.laneOf(v);
        address t = actors[lane * 2] == v ? actors[lane * 2 + 1] : actors[lane * 2];
        topUp = bound(topUp, 0, 2_000e6);
        if (topUp > 0 && !ch.paused()) {
            vm.prank(address(this));
            ausd.ownerMint(t, topUp);
            _call(t, 0, abi.encodeCall(CH.deposit, (topUp)));
        }
        address[] memory list = new address[](1);
        list[0] = v;
        (int256[] memory eq, uint256[] memory pay) = _preTake(list);
        ExtSnap memory x = _extSnap(v, t, lane);
        (bool ok, bytes memory ret) = _call(t, 0, abi.encodeCall(CH.take, (v, new bytes[](0))));
        if (ok) {
            calls["externalTake.taken"]++;
            _checkExternal(x, eq[0], pay[0], abi.decode(ret, (uint256)));
        } else if (_isPausedErr(ret)) {
            pauseViolations++;
        }
        _postTake(list, eq, pay);
    }

    struct ExtSnap {
        address taker;
        uint8 lane;
        int256 victimColl;
        int256 takerColl;
        int256 laneNet;
    }

    function _extSnap(address v, address t, uint8 lane) internal view returns (ExtSnap memory x) {
        x.taker = t;
        x.lane = lane;
        (x.victimColl,,,,,) = ch.getAccount(v);
        (x.takerColl,,,,,) = ch.getAccount(t);
        x.laneNet = _laneNet(lane);
    }

    /// @dev The lane's loss-absorbing layers net of debt: insurance + pool cash − bad debt.
    function _laneNet(uint8 lane) internal view returns (int256) {
        (,, int256 cash,, uint256 debt,,) = ch.laneLedger(lane);
        (uint256 ins,,,,) = ch.getLane(lane);
        return int256(ins) + cash - int256(debt);
    }

    /// @dev Paid exactly min(P, max(E, 0)); the lane's net change is the trader's realized loss
    ///      (incl. settled funding, = collateral − E) minus the negative-equity write-off.
    function _checkExternal(ExtSnap memory x, int256 e, uint256 p, uint256 paid) internal {
        uint256 cap = e <= 0 ? 0 : (uint256(e) < p ? uint256(e) : p);
        (int256 tAfter,,,,,) = ch.getAccount(x.taker);
        int256 laneDelta = _laneNet(x.lane) - x.laneNet;
        int256 expectedLane = (x.victimColl - e) - (e < 0 ? -e : int256(0));
        if (paid != cap || tAfter - x.takerColl != int256(paid) || laneDelta != expectedLane) {
            externalSubsidyViolations++;
        }
    }

    function cure(uint256 updSeed) external tick("cure") {
        for (uint256 i; i < actors.length; ++i) {
            (bool ok, bytes memory ret) = _call(keepers[0], 0, abi.encodeCall(CH.cancelAuction, (actors[i], _maybeUpd(updSeed))));
            if (ok && abi.decode(ret, (bool))) calls["cure.cancelled"]++;
            else if (!ok && _isPausedErr(ret)) pauseViolations++;
        }
    }

    function expire(uint256 updSeed) external tick("expire") {
        for (uint8 lane; lane < 8; ++lane) {
            address[] memory list = ch.getAuctionAccounts(lane, 0, 50);
            if (list.length == 0) continue;
            (bool ok, bytes memory ret) =
                _call(keepers[lane % 2], 0, abi.encodeCall(CH.expireBatch, (lane, list, _maybeUpd(updSeed))));
            if (ok) calls["expire.expired"] += abi.decode(ret, (uint256));
            else if (_isPausedErr(ret)) pauseViolations++;
        }
    }

    function _preTake(address[] memory list) internal returns (int256[] memory eq, uint256[] memory pay) {
        eq = new int256[](list.length);
        pay = new uint256[](list.length);
        for (uint256 i; i < list.length; ++i) {
            try ch.accountHealth(list[i]) returns (int256 e, uint256, uint256, uint256 n) {
                (,, uint16 d) = ch.auctionOf(list[i]);
                eq[i] = e;
                pay[i] = (n * d) / 10_000;
            } catch (bytes memory ret) {
                if (_isPanic(ret)) panics++;
                eq[i] = type(int256).min; // unknown (stale price): the take reverts as well
            }
        }
    }

    function _postTake(address[] memory list, int256[] memory eq, uint256[] memory pay) internal {
        for (uint256 i; i < list.length; ++i) {
            if (eq[i] == type(int256).min) continue;
            (bool active,,) = ch.auctionOf(list[i]);
            if (active) continue;
            (int256 coll,,, bytes32[] memory mkts,,) = ch.getAccount(list[i]);
            if (mkts.length != 0) continue; // cured and re-opened is impossible in one step
            int256 expected = eq[i] > int256(pay[i]) ? eq[i] - int256(pay[i]) : int256(0);
            if (coll < 0 || coll != expected) traderOverchargeViolations++;
        }
    }

    // ------------------------------------------------------------------ backstop + lanes

    function backstopDeposit(uint256 lpSeed, uint256 laneSeed, uint256 amount, uint256 updSeed)
        external
        tick("backstopDeposit")
    {
        address lp = lps[lpSeed % lps.length];
        amount = bound(amount, 1e6, 5_000e6);
        vm.prank(address(this));
        ausd.ownerMint(lp, amount);
        uint8 lane = uint8(laneSeed % 8);
        PoolSnap memory pre = _poolSnap(lane);
        (bool ok, bytes memory ret) =
            _call(lp, 0, abi.encodeCall(CH.backstopDeposit, (lane, amount, _maybeUpd(updSeed))));
        if (ok) {
            _afterPoolDeposit(lane, pre, amount, abi.decode(ret, (uint256)));
        } else if (ret.length >= 4) {
            bytes4 sel = bytes4(ret);
            if (sel == CH.BackstopReceivableOutstanding.selector) calls["poolDeposit.refusedReceivable"]++;
            if (sel == CH.BackstopGainCapBinding.selector) calls["poolDeposit.refusedGainCap"]++;
        }
    }

    function _afterPoolDeposit(uint8 lane, PoolSnap memory pre, uint256 amount, uint256 shares) internal {
        calls["backstopDeposit.ok"]++;
        if (pre.paused) pauseViolations++;
        if (ch.laneTvl(lane) > ch.maxTvlPerLane()) capViolations++;
        bool reset = ch.backstopEpoch(lane) != pre.epoch;
        // R3-01: never with a receivable outstanding or the NAV cap binding (a reset in the same
        // call starts a fresh epoch at 1:1 and is the one legitimate way past a stale view)
        if (ch.backstopReceivable(lane) != 0 || (!pre.gateOpen && !reset)) depositGateViolations++;
        (bool navOk1, int256 eq1, uint256 sup1) = _nav(lane);
        if (pre.navOk && navOk1 && !reset && pre.sup != 0) _checkLpDeposit(pre.eq, pre.sup, eq1, sup1, amount, shares);
    }

    struct PoolSnap {
        bool paused;
        bool navOk;
        int256 eq;
        uint256 sup;
        bool gateOpen;
        uint256 epoch;
    }

    function _poolSnap(uint8 lane) internal view returns (PoolSnap memory x) {
        x.paused = ch.paused();
        (x.navOk, x.eq, x.sup) = _nav(lane);
        x.gateOpen = true;
        try ch.backstopDepositStatus(lane) returns (bool open, uint256, int256, uint256) {
            x.gateOpen = open;
        } catch {}
        x.epoch = ch.backstopEpoch(lane);
    }

    /// @dev LP value conservation on a deposit: NAV grows by exactly the deposit, old LPs' value
    ///      per share does not fall, and the new LP's shares are worth at most what it paid.
    function _checkLpDeposit(int256 eq0, uint256 sup0, int256 eq1, uint256 sup1, uint256 amount, uint256 shares)
        internal
    {
        calls["lpConservation.deposit"]++;
        if (eq0 <= 0 || eq1 != eq0 + int256(amount) || sup1 != sup0 + shares) {
            lpValueViolations++;
            return;
        }
        if (uint256(eq1) * sup0 < uint256(eq0) * sup1) lpValueViolations++;
        if (shares * uint256(eq1) > amount * sup1) lpValueViolations++;
    }

    /// @dev LP value conservation on a withdrawal: the exiting LP is paid at most its NAV share
    ///      (gross, before any lane haircut) and the LPs who stay are not worse off per share.
    function _checkLpWithdraw(int256 eq0, uint256 sup0, int256 eq1, uint256 sup1, uint256 shares, uint256 paid)
        internal
    {
        calls["lpConservation.withdraw"]++;
        if (eq0 <= 0 || sup1 + shares != sup0) {
            lpValueViolations++;
            return;
        }
        if (paid * sup0 > shares * uint256(eq0)) lpValueViolations++;
        if (sup1 != 0 && (eq1 < 0 || uint256(eq1) * sup0 < uint256(eq0) * sup1)) lpValueViolations++;
    }

    /// @dev Step 2 of an LP exit with the conservation checks around it.
    function _lpExit(address lp, uint8 lane, uint256 sh, bytes[] memory upd) internal returns (bool ok) {
        ExitSnap memory x = _exitSnap(lane);
        bytes memory ret;
        (ok, ret) = _call(lp, 0, abi.encodeCall(CH.backstopWithdraw, (lane, sh, upd)));
        if (!ok) {
            if (_isPausedErr(ret)) pauseViolations++;
            if (ret.length >= 4 && bytes4(ret) == CH.BackstopPositionsOpen.selector) calls["poolExit.refusedOpen"]++;
            return false;
        }
        calls["backstopWithdraw.ok"]++;
        _afterLpExit(lane, x, sh, abi.decode(ret, (uint256)));
    }

    struct ExitSnap {
        bool navOk;
        int256 eq;
        uint256 sup;
        uint256 fairCash; // the pool's ledger cash (>= 0): the fair-value ghost's exit value
        uint256 supply; // share supply from the holders, without pricing
    }

    function _exitSnap(uint8 lane) internal view returns (ExitSnap memory x) {
        (x.navOk, x.eq, x.sup) = _nav(lane);
        (,, int256 cash,,,,) = ch.laneLedger(lane);
        x.fairCash = cash > 0 ? uint256(cash) : 0;
        x.supply = _supplyOf(lane);
    }

    function _afterLpExit(uint8 lane, ExitSnap memory x, uint256 sh, uint256 paid) internal {
        _checkFairValue(paid, sh, x.fairCash, x.supply);
        if (_supplyOf(lane) == 0) {
            (bytes32[] memory pm,,) = ch.backstopPositions(lane);
            (,, int256 cash,,,,) = ch.laneLedger(lane);
            if (pm.length != 0 || cash != 0 || ch.backstopReceivable(lane) != 0) emptyPoolViolations++;
        }
        (bool navOk1, int256 eq1, uint256 sup1) = _nav(lane);
        if (x.navOk && navOk1) _checkLpWithdraw(x.eq, x.sup, eq1, sup1, sh, paid);
    }

    /// @dev Fair-value ghost (R4-01): an exit is paid at most its share of the pool's cash.
    function _checkFairValue(uint256 paid, uint256 shares, uint256 fair, uint256 supply) internal {
        calls["fairValue.checked"]++;
        if (paid * supply > shares * fair) fairValueViolations++;
    }

    /// @dev Share supply from the holders the handler knows (all of them), without pricing.
    function _supplyOf(uint8 lane) internal view returns (uint256 supply) {
        for (uint256 i; i < lps.length; ++i) {
            supply += ch.backstopSharesOf(lane, lps[i]);
        }
    }

    function backstopWithdraw(uint256 lpSeed, uint256 laneSeed, uint256 frac, uint256 updSeed)
        external
        tick("backstopWithdraw")
    {
        address lp = lps[lpSeed % lps.length];
        uint8 lane = uint8(laneSeed % 8);
        (uint256 req, uint256 readyAt,) = ch.backstopWithdrawRequest(lane, lp);
        if (req == 0) {
            // step 1: request a fraction of the shares (works while paused)
            uint256 owned = ch.backstopSharesOf(lane, lp);
            if (owned == 0) return;
            uint256 shares = (owned * bound(frac, 1, 100)) / 100;
            if (shares == 0) return;
            (bool okReq, bytes memory retReq) = _call(lp, 0, abi.encodeCall(CH.backstopRequestWithdraw, (lane, shares)));
            if (okReq) calls["backstopWithdraw.requested"]++;
            else if (_isPausedErr(retReq)) pauseViolations++;
            return;
        }
        // step 2: an early attempt must fail; then wait and withdraw at the NAV of that time
        if (block.timestamp < readyAt) {
            (bool early,) = _call(lp, 0, abi.encodeCall(CH.backstopWithdraw, (lane, req, new bytes[](0))));
            if (early) earlyWithdrawals++;
            vm.warp(readyAt);
            vm.roll(block.number + 1);
            _refresh();
        }
        uint256 sh = (req * bound(frac, 1, 100)) / 100;
        if (sh == 0) return;
        _lpExit(lp, lane, sh, _maybeUpd(updSeed));
    }

    /// @dev A full drain of one lane's pool: the operator unwinds every pool position (a flat pool
    ///      with cash + receivable <= 0 resets; a negative cash nets the receivable first), then
    ///      every LP requests everything, waits, and exits (the last one out sweeps the pool).
    function drainPool(uint256 laneSeed, uint256 updSeed) external tick("drainPool") {
        uint8 lane = uint8(laneSeed % 8);
        // a third of the drains first unwind to a DUST remainder (R4-02): the last exit must be
        // refused until the operator closes it, so the sweep always runs
        if (updSeed % 3 == 0 && _drainOnce(lane, _maybeUpd(updSeed), true)) {
            calls["drainPool.dust"]++;
        }
        _drainOnce(lane, _maybeUpd(updSeed), false);
    }

    function _drain(uint8 lane, bytes[] memory upd) internal {
        _drainOnce(lane, upd, false);
    }

    /// @return dusted whether a dust remainder was left in the pool
    function _drainOnce(uint8 lane, bytes[] memory upd, bool dust) internal returns (bool dusted) {
        (bytes32[] memory pm, int256[] memory sz,) = ch.backstopPositions(lane);
        for (uint256 k; k < pm.length; ++k) {
            uint256 abs = sz[k] >= 0 ? uint256(sz[k]) : uint256(-sz[k]);
            uint256 size = dust && abs > 1e11 ? abs - 1e11 : type(uint256).max;
            (bool okR, bytes memory retR) =
                _call(keepers[0], 1 ether, abi.encodeCall(CH.backstopReduce, (lane, pm[k], size, upd)));
            if (okR) calls["backstopReduce.ok"]++;
            else if (_isPausedErr(retR)) pauseViolations++;
            if (okR && size != type(uint256).max) dusted = true;
        }
        bool any;
        for (uint256 i; i < lps.length; ++i) {
            uint256 owned = ch.backstopSharesOf(lane, lps[i]);
            if (owned == 0) continue;
            (bool okQ,) = _call(lps[i], 0, abi.encodeCall(CH.backstopRequestWithdraw, (lane, owned)));
            any = any || okQ;
        }
        if (!any) return dusted;
        vm.warp(block.timestamp + ch.backstopWithdrawDelay());
        vm.roll(block.number + 1);
        _refresh();
        for (uint256 i; i < lps.length; ++i) {
            (uint256 req,,) = ch.backstopWithdrawRequest(lane, lps[i]);
            if (req != 0) _lpExit(lps[i], lane, req, upd.length == 0 ? upd : _updAll(block.timestamp));
        }
        (bool navOk,, uint256 supply) = _nav(lane);
        if (navOk && supply == 0) calls["drainPool.emptied"]++;
    }

    /// @dev A large winner against its own lane: an actor tops up to its cap, opens up to the
    ///      lane's remaining OI capacity at ~2x, the market moves 10–60% its way (up to 150% for a
    ///      long, within the 2.5x price clamp), and it closes. The
    ///      realised profit drains insurance, then pool cash (the pool's receivable), sometimes into
    ///      bad debt, which drives the R3-01 paths (absorb, repay, refuse, net, forgive).
    function bigWinner(uint256 laneSeed, uint256 moveBps) external tick("bigWinner") {
        uint8 lane = uint8(laneSeed % 8);
        _bigWinner(lane, lane * 2 + (moveBps % 2), (laneSeed / 8) % markets.length, (laneSeed / 24) % 2 == 0, moveBps);
    }

    function _bigWinner(uint8 lane, uint256 actorIdx, uint256 mi, bool longIfFlat, uint256 moveBps) internal {
        address a = actors[actorIdx];
        CH.Position memory p = ch.getPosition(a, markets[mi]);
        bool isLong = p.size != 0 ? p.isLong : longIfFlat;
        _refresh();
        (int256 coll,,,,,) = ch.getAccount(a);
        if (coll > int256(ch.maxDepositPerAccount())) {
            // take profits above the cap out first (R4-03: no new margin above it)
            uint256 excess = uint256(coll - int256(ch.maxDepositPerAccount()));
            uint256 free;
            try ch.freeCollateral(a) returns (uint256 f) {
                free = f;
            } catch {}
            if (free > 0) _call(a, 0, abi.encodeCall(CH.withdraw, (excess < free ? excess : free, new bytes[](0))));
            (coll,,,,,) = ch.getAccount(a);
        }
        int256 room = int256(ch.maxDepositPerAccount()) - coll;
        if (room > 1e6) {
            vm.prank(address(this));
            ausd.ownerMint(a, uint256(room));
            _call(a, 0, abi.encodeCall(CH.deposit, (uint256(room))));
        }
        if (!_bigOpen(a, lane, mi, isLong)) return;
        calls["bigWinner.opened"]++;
        _moveSpot(mi, isLong, bound(moveBps, 1_000, isLong ? 15_000 : 6_000)); // the market moves its way
        p = ch.getPosition(a, markets[mi]);
        if (p.size == 0) return;
        uint256 id =
            _bigCommit(a, markets[mi], p.isLong ? -int256(p.size) : int256(p.size), 0, p.isLong ? 1 : type(uint128).max);
        if (id != 0 && _bigExecute(id)) calls["bigWinner.closed"]++;
    }

    /// @dev Move market `mi` up or down by `bps` (clamped to 0.4x..2.5x of its base price).
    function _moveSpot(uint256 mi, bool up, uint256 bps) internal {
        bytes32 f = feedIds[mi];
        int256 px = (int256(spot[f]) * int256(up ? 10_000 + bps : 10_000 - bps)) / 10_000;
        int256 lo = (int256(basePx[mi]) * 4) / 10;
        int256 hi = (int256(basePx[mi]) * 25) / 10;
        spot[f] = int64(px < lo ? lo : (px > hi ? hi : px));
        _refresh();
    }

    /// @dev Scripted pool stress in one lane, to reach the R3-01 pool paths the random walk rarely
    ///      combines. The pool first inherits a liquidated position (if it holds none), then:
    ///      mode 0: the LPs withdraw down to the pool margin and the market gaps against the pool;
    ///              the operator unwinds and everyone exits (a pool reset);
    ///      mode 1: a winner on another market takes part of lane insurance, the pool's market
    ///              moves its way, and an LP tries to deposit (the NAV cap binds: refused);
    ///      mode 2: as 1, but the pool's market gaps against it and the pool is drained (cash < 0
    ///              with a receivable outstanding: netting, then a reset if it runs out).
    function poolStress(uint256 laneSeed, uint256 moveBps, uint256 mode) external tick("poolStress") {
        uint8 lane = uint8(laneSeed % 8);
        mode = mode % 3;
        _refresh();
        (bytes32[] memory pm, int256[] memory sz,) = ch.backstopPositions(lane);
        if (pm.length == 0) {
            _forcePoolTake(lane, laneSeed / 8);
            (pm, sz,) = ch.backstopPositions(lane);
            if (pm.length == 0) return;
        }
        calls["poolStress.poolHolds"]++;
        uint256 pmi = _marketIndex(pm[0]);
        bool poolLong = sz[0] > 0;
        if (mode == 0) {
            _lpWithdrawToMargin(lane);
        } else {
            uint256 other = (pmi + 1 + (laneSeed / 64) % 2) % markets.length;
            // mode 1: a ~12% win takes part of insurance (no receivable); mode 2: a win of up to
            // 150% drains insurance and pool cash, often into bad debt
            _bigWinner(lane, lane * 2 + (laneSeed / 16) % 2, other, (laneSeed / 32) % 2 == 0, mode == 1 ? 1_200 : 15_000);
        }
        bool poolGains = mode == 1;
        _moveSpot(pmi, poolGains == poolLong, bound(moveBps, 2_500, 6_000));
        if (mode == 1) {
            vm.prank(address(this));
            ausd.ownerMint(lps[0], 1e6);
            PoolSnap memory pre = _poolSnap(lane);
            (bool ok, bytes memory ret) = _call(lps[0], 0, abi.encodeCall(CH.backstopDeposit, (lane, 1e6, new bytes[](0))));
            if (ok) _afterPoolDeposit(lane, pre, 1e6, abi.decode(ret, (uint256)));
            else if (ret.length >= 4 && bytes4(ret) == CH.BackstopGainCapBinding.selector) calls["poolDeposit.refusedGainCap"]++;
            else if (ret.length >= 4 && bytes4(ret) == CH.BackstopReceivableOutstanding.selector) calls["poolDeposit.refusedReceivable"]++;
        } else {
            _drain(lane, new bytes[](0));
        }
    }

    function _marketIndex(bytes32 m) internal view returns (uint256 i) {
        for (; i < markets.length; ++i) {
            if (markets[i] == m) return i;
        }
    }

    /// @dev A ~9x position in `lane` gaps into auction and the pool takes it.
    function _forcePoolTake(uint8 lane, uint256 seed) internal {
        address v = actors[lane * 2 + seed % 2];
        uint256 mi = (seed / 2) % markets.length;
        for (uint256 k; k < markets.length && ch.getPosition(v, markets[mi]).size != 0; ++k) {
            mi = (mi + 1) % markets.length; // a market the victim has no position in
        }
        if (ch.getPosition(v, markets[mi]).size != 0) return;
        (bool on,,) = ch.auctionOf(v);
        if (on) return;
        (int256 coll,,,,,) = ch.getAccount(v);
        if (coll < 300e6 && int256(ch.maxDepositPerAccount()) - coll > 300e6) {
            vm.prank(address(this));
            ausd.ownerMint(v, 300e6);
            _call(v, 0, abi.encodeCall(CH.deposit, (300e6)));
        }
        uint256 notional = _victimNotional(v, lane, mi);
        if (notional < 50e6) return;
        int256 size = int256((notional * 1e30) / (uint256(int256(spot[feedIds[mi]])) * 1e10));
        uint256 id = _bigCommit(v, markets[mi], size, notional / 9, type(uint128).max);
        if (id == 0 || !_bigExecute(id)) return;
        // the market slides 1% at a time until the account is below maintenance (equity > 0)
        for (uint256 k; k < 30 && !_liquidatable(v); ++k) {
            _moveSpot(mi, false, 100);
        }
        _auctionAndPoolTake(lane, v);
    }

    function _liquidatable(address v) internal view returns (bool) {
        try ch.isLiquidatable(v) returns (bool liq) {
            return liq;
        } catch {
            return false;
        }
    }

    /// @dev ~9x on the account's whole free collateral (cross margin: smaller would stay healthy).
    function _victimNotional(address v, uint8 lane, uint256 mi) internal view returns (uint256 notional) {
        (uint256 l,) = ch.laneOpenInterest(lane, markets[mi]);
        uint256 cap = ch.laneOiCap(lane, markets[mi]);
        if (cap <= l + 60e6) return 0;
        notional = cap - l - 10e6;
        uint256 free;
        try ch.freeCollateral(v) returns (uint256 f) {
            free = f;
        } catch {}
        if (notional > free * 9) notional = free * 9;
        if (notional > 3_000e6) notional = 3_000e6;
    }

    function _auctionAndPoolTake(uint8 lane, address v) internal {
        address[] memory list = new address[](1);
        list[0] = v;
        _call(keepers[0], 1 ether, abi.encodeCall(CH.startAuctions, (lane, list, _updAll(block.timestamp))));
        vm.roll(block.number + 20); // the auction discount ramps past the pool's minimum
        (int256[] memory eq, uint256[] memory pay) = _preTake(list);
        (bool ok, bytes memory ret) =
            _call(keepers[0], 1 ether, abi.encodeCall(CH.backstopTakeBatch, (lane, list, _updAll(block.timestamp))));
        if (ok) calls["backstopTake.taken"] += abi.decode(ret, (uint256));
        _postTake(list, eq, pay);
    }

    /// @dev Every LP of `lane` withdraws as much as the pool margin allows (95% of the room).
    function _lpWithdrawToMargin(uint8 lane) internal {
        for (uint256 i; i < lps.length; ++i) {
            (bool navOk, int256 eq, uint256 sup) = _nav(lane);
            if (!navOk || eq <= 0 || sup == 0) return;
            (, uint256 exposure) = _poolExposure(lane);
            uint256 required = (exposure * 1_000 + 9_999) / 10_000;
            if (uint256(eq) <= required) return;
            uint256 owned = ch.backstopSharesOf(lane, lps[i]);
            uint256 sh = (((uint256(eq) - required) * 95) / 100) * sup / uint256(eq);
            if (sh > owned) sh = owned;
            if (sh == 0) continue;
            (bool okQ,) = _call(lps[i], 0, abi.encodeCall(CH.backstopRequestWithdraw, (lane, sh)));
            if (!okQ) continue;
            vm.warp(block.timestamp + ch.backstopWithdrawDelay());
            vm.roll(block.number + 1);
            _refresh();
            _lpExit(lps[i], lane, sh, new bytes[](0));
        }
    }

    function _poolExposure(uint8 lane) internal view returns (bool ok, uint256 exposure) {
        (bytes32[] memory pm, int256[] memory sz,) = ch.backstopPositions(lane);
        for (uint256 k; k < pm.length; ++k) {
            uint256 abs = sz[k] >= 0 ? uint256(sz[k]) : uint256(-sz[k]);
            exposure += (abs * uint256(int256(spot[feedIds[_marketIndex(pm[k])]])) * 1e10) / 1e30;
        }
        ok = true;
    }

    function _bigOpen(address a, uint8 lane, uint256 mi, bool isLong) internal returns (bool) {
        uint256 notional = _bigNotional(a, lane, markets[mi], isLong);
        if (notional < 20e6) return false;
        int256 size = int256((notional * 1e30) / (uint256(int256(spot[feedIds[mi]])) * 1e10));
        uint256 id = _bigCommit(
            a, markets[mi], isLong ? size : -size, notional / 2 - notional / 50, isLong ? type(uint128).max : 1
        );
        return id != 0 && _bigExecute(id);
    }

    /// @dev Up to the lane's remaining OI capacity on that side, at ~2x of free collateral.
    function _bigNotional(address a, uint8 lane, bytes32 m, bool isLong) internal view returns (uint256 notional) {
        (uint256 l, uint256 sh) = ch.laneOpenInterest(lane, m);
        uint256 used = isLong ? l : sh;
        uint256 cap = ch.laneOiCap(lane, m);
        if (cap <= used + 20e6) return 0;
        notional = cap - used - 10e6;
        uint256 free;
        try ch.freeCollateral(a) returns (uint256 f) {
            free = f;
        } catch {
            return 0;
        }
        if (notional > free * 2) notional = free * 2;
    }

    function _bigCommit(address a, bytes32 m, int256 size, uint256 margin, uint256 acceptable) internal returns (uint256 id) {
        (bool ok, bytes memory ret) = _call(a, 0.1 ether, abi.encodeCall(CH.commitOrder, (m, size, margin, acceptable)));
        if (!ok) return 0;
        id = abi.decode(ret, (uint256));
        orders.push(id);
    }

    function _bigExecute(uint256 id) internal returns (bool) {
        CH.Order memory o = ch.getOrder(id);
        if (block.timestamp < o.execAfter + 1) {
            vm.warp(o.execAfter + 1);
            vm.roll(block.number + 1);
        }
        _refresh();
        _call(keepers[0], 1 ether, abi.encodeCall(CH.executeOrder, (id, _updAll(o.execAfter))));
        return ch.getOrder(id).status == CH.OrderStatus.Executed;
    }

    // ------------------------------------------------------------------ feed replacement

    /// @dev The old feed's lane markers are reset with it: the monotonic ghost restarts too.
    function _afterFeedSwap(bytes32 m) internal {
        for (uint8 lane; lane < 8; ++lane) {
            lastLaneTime[lane][m] = 0;
            (uint256 lp, uint256 lt) = ch.lanePrice(lane, m);
            if (lp != 0 || lt != 0) lanePriceRegressions++; // must have been reset
        }
    }

    /// @dev R2-02 / R3-02 recovery, through the REAL TimelockController: the multisig schedules
    ///      `replaceMarketFeed`, the 24 h delay passes, the multisig executes. `dead`: the old feed
    ///      gets no update during the delay (provably dead on chain: the bound may reach 50%) and
    ///      the new feed is up to 40% away; otherwise the old feed stays live (bound 10%) and the new
    ///      one is up to 9% away. A rejected swap (deviation vs a lane's last price) revives the old
    ///      feed. On success the handler follows the market to the new feed.
    function replaceFeed(uint256 marketSeed, uint256 moveBps, bool dead) external tick("replaceFeed") {
        uint256 i = marketSeed % markets.length;
        bytes32 m = markets[i];
        bytes32 oldF = feedIds[i];
        bytes32 nf = keccak256(abi.encode("prod-inv-feed", i, ++feedNonce));
        int64 p = _swapPrice(i, oldF, moveBps, dead);
        bytes memory data = abi.encodeCall(CH.replaceMarketFeed, (m, nf, dead ? 5_000 : 1_000));
        TimelockController tl = TimelockController(payable(owner));
        uint256 delay = tl.getMinDelay();
        vm.prank(multisig);
        tl.schedule(address(ch), 0, data, bytes32(0), bytes32(feedNonce), delay);
        vm.warp(block.timestamp + delay + 1);
        vm.roll(block.number + 1_000);
        spot[nf] = p;
        feedIds[i] = nf; // _refresh now writes the new feed, and the old one only if live
        _refresh();
        if (!dead) pyth.setStoredPrice(oldF, spot[oldF], uint64(uint256(int256(spot[oldF])) / 10_000), -8, block.timestamp);
        // a third of the dead-feed swaps face a ZOMBIE old feed (R4-04): fresh but unusable (5% conf)
        bool zombie = dead && (moveBps / 2) % 3 == 0;
        if (zombie) pyth.setStoredPrice(oldF, spot[oldF], uint64(uint256(int256(spot[oldF])) / 20), -8, block.timestamp);
        vm.prank(multisig);
        (bool ok, bytes memory ret) = address(tl).call(
            abi.encodeCall(TimelockController.execute, (address(ch), 0, data, bytes32(0), bytes32(feedNonce)))
        );
        if (ok) {
            calls["replaceFeed.ok"]++;
            if (dead) calls["replaceFeed.okDead"]++;
            if (zombie) calls["replaceFeed.okZombie"]++;
            _afterFeedSwap(m);
        } else {
            if (_isPanic(ret)) panics++;
            calls["replaceFeed.rejected"]++;
            feedIds[i] = oldF; // Pyth revives the old feed
            _refresh();
        }
    }

    function _swapPrice(uint256 i, bytes32 oldF, uint256 moveBps, bool dead) internal view returns (int64) {
        uint256 mv = bound(moveBps, 0, dead ? 4_000 : 900);
        int256 p = (int256(spot[oldF]) * int256(moveBps % 2 == 0 ? 10_000 + mv : 10_000 - mv)) / 10_000;
        int256 lo = (int256(basePx[i]) * 4) / 10;
        int256 hi = (int256(basePx[i]) * 25) / 10;
        if (p < lo) p = lo;
        if (p > hi) p = hi;
        return int64(p);
    }

    /// @dev Delayed LP withdrawals: executing before `readyAt` must never succeed.
    uint256 public earlyWithdrawals;
    /// @dev R2-07: an account with negative equity entered an auction.
    uint256 public negativeEquityAuctions;

    function backstopReduce(uint256 laneSeed, uint256 marketSeed, uint256 frac) external tick("backstopReduce") {
        uint8 lane;
        bytes32[] memory pm;
        int256[] memory sz;
        for (uint256 k; k < 8; ++k) {
            lane = uint8(((laneSeed % 8) + k) % 8);
            (pm, sz,) = ch.backstopPositions(lane);
            if (pm.length != 0) break;
        }
        if (pm.length == 0) return;
        uint256 i = marketSeed % pm.length;
        uint256 abs = sz[i] >= 0 ? uint256(sz[i]) : uint256(-sz[i]);
        uint256 size = (abs * bound(frac, 1, 110)) / 100;
        if (size == 0) return;
        (bool ok, bytes memory ret) = _call(keepers[0], 0, abi.encodeCall(CH.backstopReduce, (lane, pm[i], size, new bytes[](0))));
        if (ok) calls["backstopReduce.ok"]++;
        else if (_isPausedErr(ret)) pauseViolations++;
    }

    function fundLane(uint256 laneSeed, uint256 amount) external tick("fundLane") {
        amount = bound(amount, 1e6, 2_000e6);
        vm.prank(address(this));
        ausd.ownerMint(lps[0], amount);
        (bool ok, bytes memory ret) = _call(lps[0], 0, abi.encodeCall(CH.fundLane, (uint8(laneSeed % 8), amount)));
        if (!ok && _isPausedErr(ret)) pauseViolations++;
    }

    function claims(uint256 seed) external tick("claims") {
        address k = keepers[seed % keepers.length];
        if (ch.keeperRewards(k) > 0) {
            (bool ok,) = _call(k, 0, abi.encodeCall(CH.claimKeeperRewards, ()));
            if (!ok) pauseViolations++; // claims must always work
        }
        if (ch.executionFeesOwed(k) > 0) {
            (bool ok,) = _call(k, 0, abi.encodeCall(CH.claimExecutionFees, ()));
            if (!ok) pauseViolations++;
        }
    }

    // ------------------------------------------------------------------ governance

    function togglePause(uint256 seed) external tick("togglePause") {
        if (!ch.paused()) {
            if (seed % 3 != 0) return; // pause less often than unpause: keep activity flowing
            vm.prank(seed % 2 == 0 ? guardian : owner);
            ch.pause();
        } else {
            // the timelock executing a scheduled unpause
            vm.prank(owner);
            ch.unpause();
        }
    }

    /// @dev Non-owners (actors, keepers, guardian, LPs) try every admin function.
    function attackAdmin(uint256 callerSeed, uint256 fnSeed, uint256 value) external tick("attackAdmin") {
        address[] memory who = new address[](4);
        who[0] = actors[callerSeed % actors.length];
        who[1] = keepers[callerSeed % keepers.length];
        who[2] = guardian;
        who[3] = lps[callerSeed % lps.length];
        address from = who[(callerSeed / 7) % 4];
        uint8 lane = uint8(value % 8);
        bytes[] memory c = new bytes[](14);
        c[0] = abi.encodeCall(CH.unpause, ());
        c[1] = abi.encodeCall(CH.setGuardian, (from));
        c[2] = abi.encodeCall(CH.setPyth, (IPyth(address(pyth))));
        c[3] = abi.encodeCall(CH.listMarket, ("X/AUSD", bytes32(value | 1), 1e6, 1e6, 1));
        c[4] = abi.encodeCall(CH.setMarketConfig, (markets[0], feedIds[0], 1, value, 1));
        c[5] = abi.encodeCall(CH.setRiskParams, (20, 0, 0));
        c[6] = abi.encodeCall(CH.setCaps, (type(uint256).max, type(uint256).max, type(uint256).max));
        c[7] = abi.encodeCall(CH.setOracleParams, (60, 60, 500));
        c[8] = abi.encodeCall(CH.setOrderParams, (1, 3_600, 0));
        c[9] = abi.encodeCall(CH.setFundingParams, (10));
        c[10] = abi.encodeCall(CH.setAuctionParams, (1, 5_000));
        c[11] = abi.encodeCall(CH.setBackstopMinDiscount, (lane, 0));
        c[12] = abi.encodeCall(CH.setBackstopOperator, (from, lane, true));
        c[13] = abi.encodeWithSignature("transferOwnership(address)", from);
        (bool ok,) = _call(from, 0, c[fnSeed % c.length]);
        if (ok) adminViolations++;
    }
}

contract ProdInvariantTest is StdInvariant, Test {
    MockAUSD internal ausd;
    MockPyth internal pyth;
    CH internal ch;
    ProdHandler internal handler;
    TimelockController internal timelock;
    address internal guardian = makeAddr("guardian");
    address internal multisig = makeAddr("multisig");
    bytes32[] internal markets;

    // parameter snapshot (only the timelock may change these; the handler never schedules it)
    bytes32 internal paramsHash;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.roll(1_000);
        ausd = new MockAUSD(address(this));
        pyth = new MockPyth();
        pyth.setFees(1, 0); // non-zero Pyth fee: exercises fee metering and refunds
        bytes32[] memory feeds = new bytes32[](3);
        feeds[0] = 0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1;
        feeds[1] = 0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d;
        feeds[2] = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
        pyth.setStoredPrice(feeds[0], 3e8, 3e4, -8, block.timestamp);
        pyth.setStoredPrice(feeds[1], 180e8, 180e4, -8, block.timestamp);
        pyth.setStoredPrice(feeds[2], 100_000e8, 100_000e4, -8, block.timestamp);

        // deployCode (from the artifact) keeps the clearinghouse's 48 KB of creation code out of this
        // test contract, which would otherwise exceed the 128 KB code-size limit itself.
        ch = CH(deployCode("ParaclrClearinghouseProd.sol:ParaclrClearinghouseProd", abi.encode(address(this), address(ausd), address(pyth))));
        markets.push(ch.listMarket("MON/AUSD", feeds[0], 20_000e6, 6_000e6, 200));
        markets.push(ch.listMarket("SOL/AUSD", feeds[1], 20_000e6, 6_000e6, 200));
        markets.push(ch.listMarket("BTC/AUSD", feeds[2], 20_000e6, 6_000e6, 200));
        ch.setCaps(4_000e6, 12_000e6, 50_000); // caps get hit regularly
        ch.setGuardian(guardian);
        ausd.ownerMint(address(this), 8 * 3_000e6);
        ausd.approve(address(ch), type(uint256).max);
        for (uint8 lane; lane < 8; ++lane) {
            ch.fundLane(lane, 1_000e6);
        }
        address[] memory roles = new address[](1);
        roles[0] = multisig;
        timelock = TimelockController(
            payable(deployCode("TimelockController.sol:TimelockController", abi.encode(1 days, roles, roles, address(0))))
        );

        handler = new ProdHandler(ch, ausd, pyth, address(timelock), guardian, multisig, markets, feeds);
        // pool liquidity is held by the handler's LPs (not this contract), so pools can be emptied
        for (uint8 lane; lane < 8; ++lane) {
            address lp = handler.lps(lane % 2);
            ausd.ownerMint(lp, 2_000e6);
            vm.prank(lp);
            ch.backstopDeposit(lane, 2_000e6, new bytes[](0));
        }
        _seedBook(feeds);
        handler.syncClock();
        ausd.transferOwnership(address(handler)); // handler mints
        for (uint8 lane; lane < 8; ++lane) {
            ch.setBackstopOperator(handler.keepers(0), lane, true); // test keeper: all lanes
        }
        ch.setBackstopParams(1 minutes); // the minimum withdrawal delay, so LP exits happen often
        ch.transferOwnership(address(timelock));
        paramsHash = _paramsHash();

        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](38);
        sel[0] = ProdHandler.deposit.selector;
        sel[1] = ProdHandler.deposit.selector;
        sel[2] = ProdHandler.withdraw.selector;
        sel[3] = ProdHandler.commit.selector;
        sel[4] = ProdHandler.commit.selector;
        sel[5] = ProdHandler.commit.selector;
        sel[6] = ProdHandler.execute.selector;
        sel[7] = ProdHandler.execute.selector;
        sel[8] = ProdHandler.execute.selector;
        sel[9] = ProdHandler.cancel.selector;
        sel[10] = ProdHandler.movePrice.selector;
        sel[11] = ProdHandler.movePrice.selector;
        sel[12] = ProdHandler.advanceTime.selector;
        sel[13] = ProdHandler.updateFunding.selector;
        sel[14] = ProdHandler.startAuctions.selector;
        sel[15] = ProdHandler.backstopTake.selector;
        sel[16] = ProdHandler.externalTake.selector;
        sel[17] = ProdHandler.cure.selector;
        sel[18] = ProdHandler.expire.selector;
        sel[19] = ProdHandler.backstopDeposit.selector;
        sel[20] = ProdHandler.backstopWithdraw.selector;
        sel[21] = ProdHandler.backstopReduce.selector;
        sel[22] = ProdHandler.fundLane.selector;
        sel[23] = ProdHandler.claims.selector;
        sel[24] = ProdHandler.togglePause.selector;
        sel[25] = ProdHandler.attackAdmin.selector;
        sel[26] = ProdHandler.startAuctions.selector;
        sel[27] = ProdHandler.backstopTake.selector;
        sel[28] = ProdHandler.crash.selector;
        sel[29] = ProdHandler.crash.selector;
        sel[30] = ProdHandler.expire.selector;
        sel[31] = ProdHandler.drainPool.selector;
        sel[32] = ProdHandler.replaceFeed.selector;
        sel[33] = ProdHandler.backstopDeposit.selector;
        sel[34] = ProdHandler.bigWinner.selector;
        sel[35] = ProdHandler.drainPool.selector;
        sel[36] = ProdHandler.poolStress.selector;
        sel[37] = ProdHandler.poolStress.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    /// @dev Every run starts from a two-sided book (all markets, both sides, 4x..10x) built
    ///      through the real commit → execute path.
    function _seedBook(bytes32[] memory feeds) internal {
        uint256 n = handler.actorCount();
        uint256[] memory ids = new uint256[](n);
        int64[3] memory px = [int64(3e8), int64(180e8), int64(100_000e8)];
        for (uint256 i; i < n; ++i) {
            address a = handler.actors(i);
            uint256 notional = 400e6 + (i % 4) * 400e6;
            uint256 lev = 4 + (i % 4) * 2;
            // collateral ≈ margin + fees + 2%: liquidatable after a ~(1/lev − 4.5%) move
            uint256 coll = notional / lev + (notional * 2) / 100;
            ausd.ownerMint(a, coll);
            vm.deal(a, 10 ether);
            vm.startPrank(a);
            ch.deposit(coll);
            int256 size = int256((notional * 1e30) / (uint256(int256(px[i % 3])) * 1e10));
            ids[i] = ch.commitOrder{value: 0.1 ether}(markets[i % 3], i % 2 == 0 ? size : -size, notional / lev, i % 2 == 0 ? type(uint128).max : 1);
            vm.stopPrank();
        }
        uint256 t = block.timestamp + ch.minExecDelay();
        vm.warp(t + 1);
        MockPyth.Msg[] memory msgs = new MockPyth.Msg[](3);
        for (uint256 j; j < 3; ++j) {
            msgs[j] = MockPyth.Msg(feeds[j], px[j], uint64(uint256(int256(px[j])) / 10_000), -8, uint64(t), uint64(t - 1));
            pyth.setStoredPrice(feeds[j], px[j], uint64(uint256(int256(px[j])) / 10_000), -8, block.timestamp);
        }
        bytes[] memory u = new bytes[](1);
        u[0] = abi.encode(bytes4(0x504e4155), msgs);
        address k = handler.keepers(0); // credits must be visible to the ledger invariant
        for (uint256 i; i < n; ++i) {
            vm.prank(k);
            ch.executeOrder{value: 1 ether}(ids[i], u);
            require(ch.getOrder(ids[i]).status == CH.OrderStatus.Executed, "seed fill");
        }
    }

    function _paramsHash() internal view returns (bytes32) {
        bytes memory a = abi.encode(
            ch.owner(),
            address(ch.pyth()),
            ch.guardian(),
            ch.maxLeverage(),
            ch.tradingFeeBps(),
            ch.minPositionNotional(),
            ch.maxDepositPerAccount(),
            ch.maxTvlPerLane(),
            ch.oiCapMultiplierBps()
        );
        bytes memory b = abi.encode(
            ch.maxPriceAge(),
            ch.maxStoredPriceAge(),
            ch.backstopWithdrawDelay(),
            ch.maxConfBps(),
            ch.minExecDelay(),
            ch.maxExecDelay(),
            ch.minExecutionFee(),
            ch.fundingUpdateInterval(),
            ch.auctionStepBps(),
            ch.auctionMaxDiscountBps()
        );
        bytes memory c;
        for (uint256 i; i < markets.length; ++i) {
            // the feed id is excluded: the handler replaces feeds through the timelock
            // (invariant_MarketFeedsFollowGovernance pins it to the handler's record instead)
            (bool listed, string memory sym,, uint256 skew, uint256 maxOi, uint256 maxF) = ch.getMarket(markets[i]);
            c = abi.encode(c, listed, sym, skew, maxOi, maxF);
        }
        for (uint8 lane; lane < 8; ++lane) {
            c = abi.encode(c, ch.backstopMinDiscountBps(lane));
        }
        (bytes32[] memory ids,,) = ch.getMarkets();
        for (uint8 lane; lane < 8; ++lane) {
            c = abi.encode(c, ch.isBackstopOperator(handler.keepers(0), lane), ch.isBackstopOperator(handler.keepers(1), lane));
        }
        return keccak256(abi.encode(a, b, c, ids.length));
    }

    // ------------------------------------------------------------------ invariants

    /// @notice AUSD.balanceOf(ch) == Σ lanes (collateral + insurance + pool cash + keeper
    ///         rewards − bad debt), exactly; and the native-MON books balance exactly.
    function invariant_SolvencyIdentity() public view {
        (uint256 held, uint256 liabilities, int256 surplus, bool solvent) = ch.solvency();
        assertEq(held, ausd.balanceOf(address(ch)), "held");
        assertEq(surplus, 0, "AUSD surplus");
        assertEq(liabilities, held, "AUSD liabilities");
        assertTrue(solvent);
        (uint256 nHeld, uint256 nLiab, bool nSolvent) = ch.nativeSolvency();
        assertEq(nHeld, address(ch).balance);
        assertEq(nLiab, nHeld, "native liabilities == balance");
        assertTrue(nSolvent);
    }

    /// @notice The ledgers equal the same sums recomputed from accounts, keepers, pools and
    ///         pending orders.
    function invariant_LedgersMatchUnderlyingState() public view {
        int256 ledgerColl;
        uint256 ledgerKeeper;
        uint256 ledgerOwed;
        uint256[8] memory escrow;
        for (uint8 lane; lane < 8; ++lane) {
            (int256 coll,,, uint256 kr,, uint256 esc, uint256 owed) = ch.laneLedger(lane);
            ledgerColl += coll;
            ledgerKeeper += kr;
            ledgerOwed += owed;
            escrow[lane] = esc;
        }
        int256 accounts;
        for (uint256 i; i < handler.actorCount(); ++i) {
            (int256 c,,,,,) = ch.getAccount(handler.actors(i));
            accounts += c;
        }
        assertEq(ledgerColl, accounts, "collateral ledger");
        uint256 rewards;
        uint256 owedSum;
        for (uint256 i; i < handler.keeperCount(); ++i) {
            rewards += ch.keeperRewards(handler.keepers(i));
            owedSum += ch.executionFeesOwed(handler.keepers(i));
        }
        for (uint256 i; i < handler.actorCount(); ++i) {
            owedSum += ch.executionFeesOwed(handler.actors(i));
        }
        assertEq(ledgerKeeper, rewards, "keeper rewards ledger");
        assertEq(ledgerOwed, owedSum, "native owed ledger");
        // escrow per lane == Σ fees of pending orders; reserved margin == Σ pending marginDelta
        uint256[8] memory pendingFees;
        uint256 n = handler.orderCount();
        for (uint256 i; i < n; ++i) {
            CH.Order memory o = ch.getOrder(handler.orders(i));
            if (o.status == CH.OrderStatus.Pending) pendingFees[ch.laneOf(o.account)] += o.executionFee;
        }
        for (uint8 lane; lane < 8; ++lane) {
            assertEq(escrow[lane], pendingFees[lane], "native escrow == pending fees");
        }
    }

    function invariant_ReservedMarginAndPendingIndex() public view {
        uint256 n = handler.orderCount();
        for (uint256 a; a < handler.actorCount(); ++a) {
            address acct = handler.actors(a);
            uint256 reservedSum;
            for (uint256 i; i < n; ++i) {
                uint256 id = handler.orders(i);
                CH.Order memory o = ch.getOrder(id);
                if (o.account != acct) continue;
                bool pending = o.status == CH.OrderStatus.Pending;
                if (pending) reservedSum += o.marginDelta;
                assertEq(ch.pendingOrderOf(acct, o.market) == id, pending, "pending index");
            }
            (,,,, uint256 reserved,) = ch.getAccount(acct);
            assertEq(reserved, reservedSum, "reserved margin == pending escrow");
        }
    }

    /// @notice Lane OI == Σ positions' entry notional + Σ pools' booked notional, per side.
    function invariant_OpenInterestMatchesPositions() public view {
        for (uint8 lane; lane < 8; ++lane) {
            for (uint256 m; m < markets.length; ++m) {
                uint256 longSum;
                uint256 shortSum;
                for (uint256 j; j < 2; ++j) {
                    CH.Position memory p = ch.getPosition(handler.actors(lane * 2 + j), markets[m]);
                    if (p.size == 0) continue;
                    if (p.isLong) longSum += p.entryNotional;
                    else shortSum += p.entryNotional;
                }
                (bytes32[] memory pm, int256[] memory sz, uint256[] memory ep) = ch.backstopPositions(lane);
                for (uint256 k; k < pm.length; ++k) {
                    if (pm[k] != markets[m]) continue;
                    uint256 abs = sz[k] >= 0 ? uint256(sz[k]) : uint256(-sz[k]);
                    uint256 booked = (abs * ep[k]) / 1e30;
                    if (sz[k] > 0) longSum += booked;
                    else shortSum += booked;
                }
                (uint256 l, uint256 s) = ch.laneOpenInterest(lane, markets[m]);
                assertEq(l, longSum, "long OI");
                assertEq(s, shortSum, "short OI");
            }
        }
    }

    function invariant_BackstopSharesSumToSupply() public view {
        for (uint8 lane; lane < 8; ++lane) {
            uint256 supply;
            try ch.backstopNav(lane) returns (int256, int256, int256, uint256 s) {
                supply = s;
            } catch {
                continue; // NAV needs fresh prices; supply is re-checked on the next call
            }
            uint256 sum = ch.backstopSharesOf(lane, address(this));
            for (uint256 i; i < handler.lpCount(); ++i) {
                sum += ch.backstopSharesOf(lane, handler.lps(i));
            }
            assertEq(sum, supply, "shares");
        }
    }

    function invariant_AuctionListConsistent() public view {
        uint256 listed;
        for (uint8 lane; lane < 8; ++lane) {
            address[] memory list = ch.getAuctionAccounts(lane, 0, 100);
            listed += list.length;
            for (uint256 i; i < list.length; ++i) {
                (bool active,,) = ch.auctionOf(list[i]);
                assertTrue(active);
                assertEq(ch.laneOf(list[i]), lane);
                assertEq(ch.freeCollateral(list[i]), 0, "frozen");
            }
        }
        uint256 activeCount;
        for (uint256 i; i < handler.actorCount(); ++i) {
            (bool a,,) = ch.auctionOf(handler.actors(i));
            if (a) ++activeCount;
        }
        assertEq(listed, activeCount);
    }

    /// @notice No account ever loses more than its equity in a take; external takers are
    ///         paid only from the trader's equity.
    function invariant_NoAccountLosesMoreThanEquity() public view {
        assertEq(handler.traderOverchargeViolations(), 0, "overcharge");
        assertEq(handler.externalSubsidyViolations(), 0, "external subsidy");
        // and no account is left with negative collateral while flat
        for (uint256 i; i < handler.actorCount(); ++i) {
            (int256 c,,, bytes32[] memory open,,) = ch.getAccount(handler.actors(i));
            if (open.length == 0) assertGe(c, 0, "flat account with negative collateral");
        }
    }

    /// @notice R-05: per lane, AUSD held == collateral + insurance + pool cash + keeper rewards −
    ///         bad debt (exact), and Σ lanes == the token balance. No lane pays another lane.
    function invariant_PerLaneIdentity() public view {
        uint256 sumHeld;
        for (uint8 lane; lane < 8; ++lane) {
            (int256 coll, uint256 ins, int256 cash, uint256 kr, uint256 debt,,) = ch.laneLedger(lane);
            (uint256 held, int256 claims, int256 surplus,,,) = ch.laneSolvency(lane);
            assertEq(int256(held), coll + int256(ins) + cash + int256(kr) - int256(debt), "lane identity");
            assertEq(claims, coll + cash + int256(kr), "lane claims");
            assertEq(surplus, int256(ins) - int256(debt), "lane surplus");
            assertTrue(ins == 0 || debt == 0, "insurance and bad debt never both positive");
            sumHeld += held;
        }
        assertEq(sumHeld, ausd.balanceOf(address(ch)), "sum of lanes == AUSD held");
    }

    /// @notice R-01: a lane's last-used price never moves back in time. R-09: the pool is never
    ///         paid more than the taken accounts' positive equity. LP withdrawals are delayed.
    function invariant_PricesMonotonicPoolUnsubsidisedLpDelayed() public view {
        assertEq(handler.lanePriceRegressions(), 0, "lane price regressed");
        assertEq(handler.poolSubsidyViolations(), 0, "pool subsidised");
        assertEq(handler.earlyWithdrawals(), 0, "LP withdrew before the delay");
        assertEq(handler.negativeEquityAuctions(), 0, "negative equity auctioned (R2-07)");
    }

    /// @notice R3-01: the receivable equals Σ absorbed − repaid − netted − forgiven from the
    ///         events (exactly), it never coexists with insurance (inflows repay it before
    ///         insurance; the pool only lends once insurance is 0), and an EMPTY pool (no shares)
    ///         holds nothing: no cash, no receivable, no positions.
    function invariant_PoolReceivableBookkeeping() public view {
        assertEq(handler.receivableGhostViolations(), 0, "receivable decreased below the ghost");
        assertEq(handler.emptyPoolViolations(), 0, "an exit emptied a pool that still held something (R4-02)");
        for (uint8 lane; lane < 8; ++lane) {
            uint256 rec = ch.backstopReceivable(lane);
            assertEq(rec, handler.ghostReceivable(lane), "receivable == event ghost");
            (, uint256 ins, int256 cash,,,,) = ch.laneLedger(lane);
            assertTrue(ins == 0 || rec == 0, "insurance and a receivable never both positive");
            uint256 supply = ch.backstopSharesOf(lane, address(this));
            for (uint256 i; i < handler.lpCount(); ++i) {
                supply += ch.backstopSharesOf(lane, handler.lps(i));
            }
            if (supply == 0) {
                (bytes32[] memory pm,,) = ch.backstopPositions(lane);
                assertEq(pm.length, 0, "empty pool holds no positions");
                assertEq(cash, 0, "empty pool holds no cash");
                assertEq(rec, 0, "empty pool is owed nothing");
            }
        }
    }

    /// @notice R3-01: LP deposits and withdrawals never move value between LPs, and a deposit
    ///         never succeeds with a receivable outstanding or the NAV cap binding. R4-01: no exit is
    ///         paid above its share of the pool's fair exit value (the handler's independent bound:
    ///         the pool's cash; unrealised gains, the receivable and insurance never count).
    function invariant_LpValueConserved() public view {
        assertEq(handler.lpValueViolations(), 0, "LP value moved between LPs");
        assertEq(handler.depositGateViolations(), 0, "pool deposit past the R3-01 gate");
        assertEq(handler.fairValueViolations(), 0, "an exit was paid above its share of the pool's cash (R4-01)");
    }

    /// @notice R2-02 / R3-02: every market's feed is the one governance last set (the handler
    ///         follows successful timelocked replacements; rejected ones change nothing).
    function invariant_MarketFeedsFollowGovernance() public view {
        for (uint256 i; i < markets.length; ++i) {
            (,, bytes32 feed,,,) = ch.getMarket(markets[i]);
            assertEq(feed, handler.feedIds(i), "market feed");
        }
    }

    function invariant_CapsNeverExceeded() public view {
        assertEq(handler.capViolations(), 0);
    }

    function invariant_PauseBlocksExactlyWhatItShould() public view {
        assertEq(handler.pauseViolations(), 0);
    }

    function invariant_OnlyTimelockChangesParams() public view {
        assertEq(handler.adminViolations(), 0, "a non-owner admin call succeeded");
        assertEq(_paramsHash(), paramsHash, "parameters changed");
        assertEq(ch.owner(), address(timelock));
    }

    function invariant_NoPanics() public view {
        assertEq(handler.panics(), 0);
    }

    /// @notice Coverage check: a deterministic crash sequence drives the handler through every
    ///         liquidation path, so the invariants above are not vacuous.
    function test_HandlerCoverage_CrashSequence() public {
        for (uint256 i; i < 3; ++i) {
            handler.crash(i, 1_000, i % 2 == 0); // MON −10%, SOL +10%, BTC −10%: 10x books into auction
        }
        handler.startAuctions(0);
        assertGt(handler.calls("startAuctions.started"), 0, "auctions started");
        for (uint256 i; i < 3; ++i) {
            handler.crash(i, 1_500, i % 2 == 0); // a further gap: negative equity → closed out at once
        }
        handler.startAuctions(0);
        assertGt(handler.calls("startAuctions.closedOut"), 0, "negative-equity accounts closed out (R2-07)");
        handler.externalTake(0, 2_000e6);
        handler.backstopTake(5, 1);
        handler.backstopTake(9, 0);
        handler.advanceTime(30, 1);
        handler.startAuctions(1);
        handler.advanceTime(60, 1);
        handler.advanceTime(60, 1);
        handler.expire(0);
        handler.cure(0);
        handler.commit(3, 0, true, 500e6, 5, 100);
        handler.execute(0, 0, 0);
        handler.updateFunding(0);
        handler.backstopReduce(0, 0, 50);
        console2.log("started", handler.calls("startAuctions.started"));
        console2.log("pool taken", handler.calls("backstopTake.taken"));
        console2.log("external taken", handler.calls("externalTake.taken"));
        console2.log("expired", handler.calls("expire.expired"));
        console2.log("closed out at start", handler.calls("startAuctions.closedOut"));
        assertGt(handler.calls("backstopTake.taken") + handler.calls("externalTake.taken"), 0, "takes");
        invariant_SolvencyIdentity();
        invariant_LedgersMatchUnderlyingState();
        invariant_OpenInterestMatchesPositions();
        invariant_NoAccountLosesMoreThanEquity();
        invariant_PauseBlocksExactlyWhatItShould();
        invariant_CapsNeverExceeded();
        invariant_NoPanics();
    }

    /// @notice Coverage check for the v4 paths: deterministic sequences drive feed replacement
    ///         through the timelock (live and dead old feed), the R3-01 receivable life cycle
    ///         (absorb, refuse, repay, net, forgive) and pool resets / sweeps, then re-check the
    ///         invariants, so none of them is vacuous.
    function test_HandlerCoverage_PoolsFeedsReceivable() public {
        handler.replaceFeed(1, 300, false); // SOL, +3%, old feed live: <= 10%
        handler.replaceFeed(0, 2_601, true); // MON, -26%, old feed dead for the 24 h delay: <= 50%
        handler.replaceFeed(2, 600, true); // BTC, +6%, old feed a fresh but unusable ZOMBIE (R4-04)
        assertEq(handler.calls("replaceFeed.ok"), 3, "all three feed swaps executed by the timelock");
        assertEq(handler.calls("replaceFeed.okDead"), 2);
        assertEq(handler.calls("replaceFeed.okZombie"), 1);
        _checkAll();
        string[12] memory must = [
            "receivable.absorbed",
            "receivable.repaid",
            "poolDeposit.refusedReceivable",
            "poolDeposit.refusedGainCap",
            "pool.netted",
            "pool.reset",
            "pool.sweptForgiven",
            "lpConservation.deposit",
            "lpConservation.withdraw",
            "fairValue.checked",
            "drainPool.dust",
            "poolExit.refusedOpen"
        ];
        uint256[12] memory hits;
        // each stress mode from the same state, in every lane: a reset (0), the NAV cap binding
        // (1), netting (2); then a winner, a refused / accepted LP deposit, a lane inflow (repays
        // the receivable) and a full drain (sweep, forgiving what is still owed)
        for (uint256 mode; mode < 3; ++mode) {
            uint256 snap = vm.snapshotState();
            for (uint256 l; l < 8; ++l) {
                handler.poolStress(l + 16, 6_000, mode);
                handler.bigWinner(l + 8, 15_000);
                handler.backstopDeposit(l % 2, l, 1_000e6, 0);
                handler.fundLane(l, 300e6);
                handler.drainPool(l, 0);
            }
            _checkAll();
            for (uint256 i; i < must.length; ++i) {
                hits[i] += handler.calls(bytes32(bytes(must[i])));
            }
            vm.revertToStateAndDelete(snap);
        }
        for (uint256 i; i < must.length; ++i) {
            console2.log(must[i], hits[i]);
            assertGt(hits[i], 0, must[i]);
        }
    }

    function _checkAll() internal view {
        invariant_SolvencyIdentity();
        invariant_PerLaneIdentity();
        invariant_PoolReceivableBookkeeping();
        invariant_LpValueConserved();
        invariant_MarketFeedsFollowGovernance();
        invariant_PricesMonotonicPoolUnsubsidisedLpDelayed();
        invariant_OpenInterestMatchesPositions();
        invariant_LedgersMatchUnderlyingState();
        invariant_NoAccountLosesMoreThanEquity();
        invariant_CapsNeverExceeded();
        invariant_PauseBlocksExactlyWhatItShould();
        invariant_NoPanics();
    }

    /// @dev Per-run path counters, logged and (when PROD_INV_COVERAGE is set) appended as one
    ///      CSV line to that file under ./cache, so coverage can be summed across all runs.
    function afterInvariant() external {
        string[55] memory names = [
            "crash",
            "deposit.ok",
            "withdraw.ok",
            "commit",
            "commit.ok",
            "execute",
            "execute.filled",
            "execute.failed",
            "cancel.ok",
            "movePrice",
            "advanceTime",
            "updateFunding.ok",
            "startAuctions.started",
            "backstopTake.taken",
            "externalTake.taken",
            "cure.cancelled",
            "expire.expired",
            "backstopDeposit.ok",
            "backstopWithdraw.ok",
            "backstopWithdraw.requested",
            "startAuctions.closedOut",
            "deposit.topUp",
            "backstopReduce.ok",
            "togglePause",
            "attackAdmin",
            "claims",
            "deposit.withPrice",
            "deposit.withPrice.topUp",
            "replaceFeed",
            "replaceFeed.ok",
            "replaceFeed.okDead",
            "replaceFeed.rejected",
            "drainPool",
            "pool.reset",
            "pool.netted",
            "pool.swept",
            "pool.sweptForgiven",
            "pool.sweptCash",
            "receivable.absorbed",
            "receivable.repaid",
            "poolDeposit.refusedReceivable",
            "poolDeposit.refusedGainCap",
            "lpConservation.deposit",
            "lpConservation.withdraw",
            "drainPool.emptied",
            "bigWinner.opened",
            "bigWinner.closed",
            "bigWinner",
            "poolStress",
            "poolStress.poolHolds",
            "fairValue.checked",
            "poolExit.refusedOpen",
            "drainPool.dust",
            "commit.refusedAboveCap",
            "replaceFeed.okZombie"
        ];
        string memory line;
        for (uint256 i; i < names.length; ++i) {
            uint256 v = handler.calls(bytes32(bytes(names[i])));
            console2.log(names[i], v);
            line = string.concat(line, i == 0 ? "" : ",", names[i], "=", vm.toString(v));
        }
        string memory path = vm.envOr("PROD_INV_COVERAGE", string(""));
        if (bytes(path).length != 0) vm.writeLine(path, line);
    }
}
