// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {console2} from "forge-std/console2.sol";
import {MockAUSD} from "../../src/MockAUSD.sol";
import {MockOracle} from "../../src/oracles/MockOracle.sol";
import {ParaclrClearinghouse} from "../../src/ParaclrClearinghouse.sol";
import {ParaclrClearinghouseDemo} from "../../src/ParaclrClearinghouseDemo.sol";
import {NaiveClearinghouseDemo} from "../../src/NaiveClearinghouseDemo.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";

/// @notice Drives random sequences of deposit / withdraw / open / close / price moves / block
///         progress / auctions (start, backstop take, external take, cancel, expire) / legacy
///         liquidations / backstop deposit / withdraw / reduce / lane funding / reward claims.
///         Every action is bounded to plausible inputs and wrapped in try/catch so the sequence
///         keeps going; the invariant contract then checks the books after every call.
contract SolvencyHandler is Test {
    ParaclrClearinghouse public ch;
    MockAUSD public ausd;
    MockOracle public oracle;
    address public admin;

    bytes32[] public markets;
    uint256[] public basePrices;
    address[] public actors; // 2 per lane
    address[] public lps;
    address[] public keepers;

    /// @dev Handler-owned block clock (re-applied on every call so it persists across calls).
    uint256 public blockNumber;

    // Ghost counters: which paths the run actually exercised.
    mapping(bytes32 => uint256) public calls;
    /// @dev Set if a take ever left a trader with negative collateral or more than max(0, E-P).
    uint256 public traderOverchargeViolations;
    /// @dev Arithmetic/assert panics inside the clearinghouse (a bug even if the handler caught it).
    uint256 public panics;
    /// @dev Set if an external take paid anything but min(P, max(E, 0)) or the lane funded more
    ///      than the negative equity.
    uint256 public externalSubsidyViolations;

    constructor(ParaclrClearinghouse ch_, MockAUSD ausd_, MockOracle oracle_, address admin_, bytes32[] memory m) {
        ch = ch_;
        ausd = ausd_;
        oracle = oracle_;
        admin = admin_;
        markets = m;
        for (uint256 i; i < m.length; ++i) {
            (uint256 p,) = oracle.getPrice(m[i]);
            basePrices.push(p);
        }
        for (uint8 lane; lane < 8; ++lane) {
            for (uint256 j; j < 2; ++j) {
                uint160 base = uint160(uint256(keccak256(abi.encode("inv-actor", lane, j))));
                actors.push(address((base & ~uint160(7)) | uint160(lane)));
            }
        }
        lps.push(admin_); // the seed LP of every pool
        lps.push(makeAddr("lp1"));
        lps.push(makeAddr("lp2"));
        keepers.push(makeAddr("keeperA"));
        keepers.push(makeAddr("keeperB"));
        blockNumber = block.number;
        for (uint256 i; i < actors.length; ++i) {
            vm.prank(actors[i]);
            ausd.approve(address(ch), type(uint256).max);
        }
        for (uint256 i; i < lps.length; ++i) {
            vm.prank(lps[i]);
            ausd.approve(address(ch), type(uint256).max);
        }
    }

    modifier tick(bytes32 name) {
        vm.roll(blockNumber);
        calls[name]++;
        _;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function lpCount() external view returns (uint256) {
        return lps.length;
    }

    function keeperCount() external view returns (uint256) {
        return keepers.length;
    }

    function _mint(address to, uint256 amount) internal {
        vm.prank(admin);
        ausd.ownerMint(to, amount);
    }

    function _laneActors(uint8 lane) internal view returns (address[] memory a) {
        a = new address[](2);
        a[0] = actors[lane * 2];
        a[1] = actors[lane * 2 + 1];
    }

    // ------------------------------------------------------------------ trading

    function deposit(uint256 actorSeed, uint256 amount) external tick("deposit") {
        address a = actors[actorSeed % actors.length];
        amount = bound(amount, 1e6, 20_000e6);
        _mint(a, amount);
        vm.prank(a);
        ch.deposit(amount);
    }

    function withdraw(uint256 actorSeed, uint256 amount) external tick("withdraw") {
        address a = actors[actorSeed % actors.length];
        uint256 free = ch.freeCollateral(a);
        if (free == 0) return;
        amount = bound(amount, 1, free);
        vm.prank(a);
        ch.withdraw(amount);
    }

    function open(uint256 actorSeed, uint256 marketSeed, bool isLong, uint256 margin, uint256 lev)
        external
        tick("open")
    {
        address a = actors[actorSeed % actors.length];
        uint256 free = ch.freeCollateral(a);
        if (free < 1e6) return;
        margin = bound(margin, 1e6, free);
        lev = bound(lev, 3, 20);
        vm.prank(a);
        try ch.openPosition(markets[marketSeed % markets.length], isLong, margin, lev) {}
        catch Panic(uint256) {
            panics++;
        } catch {}
    }

    function close(uint256 actorSeed, uint256 marketSeed) external tick("close") {
        address a = actors[actorSeed % actors.length];
        vm.prank(a);
        try ch.closePosition(markets[marketSeed % markets.length]) {}
        catch Panic(uint256) {
            panics++;
        } catch {}
    }

    /// @dev Price moves within [0.4x, 2.5x] of the starting price, at most ±35% per step.
    function movePrice(uint256 marketSeed, uint256 bps) external tick("movePrice") {
        uint256 i = marketSeed % markets.length;
        (uint256 p,) = oracle.getPrice(markets[i]);
        p = (p * bound(bps, 6_500, 13_500)) / 10_000;
        uint256 lo = (basePrices[i] * 4) / 10;
        uint256 hi = (basePrices[i] * 25) / 10;
        if (p < lo) p = lo;
        if (p > hi) p = hi;
        vm.prank(admin);
        oracle.setPrice(markets[i], p);
    }

    function advanceBlocks(uint256 n) external tick("advanceBlocks") {
        blockNumber += bound(n, 1, 12);
        vm.roll(blockNumber);
    }

    // ------------------------------------------------------------------ auctions

    /// @dev The keeper sweep: every lane, one tx each.
    function startAuctions() external tick("startAuctions") {
        for (uint8 lane; lane < 8; ++lane) {
            try ch.startAuctions(lane, _laneActors(lane)) returns (uint256 n) {
                calls["startAuctions.started"] += n;
            } catch Panic(uint256) {
                panics++;
            } catch {}
        }
    }

    /// @dev The keeper sweep a few blocks later (0..9), every lane.
    function backstopTake(uint256 keeperSeed, uint256 wait) external tick("backstopTake") {
        blockNumber += bound(wait, 0, 9);
        vm.roll(blockNumber);
        for (uint8 lane; lane < 8; ++lane) {
            address[] memory list = ch.getAuctionAccounts(lane, 0, 50);
            if (list.length == 0) continue;
            (int256[] memory eq, uint256[] memory pay) = _preTake(list);
            vm.prank(keepers[keeperSeed % keepers.length]);
            try ch.backstopTakeBatch(lane, list) returns (uint256 n) {
                calls["backstopTake.taken"] += n;
            } catch Panic(uint256) {
                panics++;
            } catch {}
            _postTake(list, eq, pay);
        }
    }

    function externalTake(uint256 victimSeed, uint256 takerSeed) external tick("externalTake") {
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
        // The other actor of the victim's lane (external takers must be in the same lane);
        // top it up so it can usually carry the inherited legs.
        address t = actors[lane * 2] == v ? actors[lane * 2 + 1] : actors[lane * 2];
        uint256 topUp = bound(takerSeed, 0, 5_000e6);
        if (topUp > 0) {
            _mint(t, topUp);
            vm.prank(t);
            ch.deposit(topUp);
        }
        address[] memory list = new address[](1);
        list[0] = v;
        (int256[] memory eq, uint256[] memory pay) = _preTake(list);
        ExtSnap memory snap = _extSnap(v, t, lane);
        vm.prank(t);
        try ch.take(v) returns (uint256 paid) {
            calls["externalTake.taken"]++;
            _checkExternal(snap, eq[0], pay[0], paid);
        } catch Panic(uint256) {
            panics++;
        } catch {
            calls["externalTake.reverted"]++;
        }
        _postTake(list, eq, pay);
    }

    function cancel() external tick("cancel") {
        for (uint256 i; i < actors.length; ++i) {
            try ch.cancelAuction(actors[i]) returns (bool ok) {
                if (ok) calls["cancel.cancelled"]++;
            } catch Panic(uint256) {
                panics++;
            } catch {}
        }
    }

    function expire(uint256 keeperSeed) external tick("expire") {
        for (uint8 lane; lane < 8; ++lane) {
            address[] memory list = ch.getAuctionAccounts(lane, 0, 50);
            if (list.length == 0) continue;
            vm.prank(keepers[keeperSeed % keepers.length]);
            try ch.expireBatch(lane, list) returns (uint256 n) {
                calls["expire.expired"] += n;
            } catch Panic(uint256) {
                panics++;
            } catch {}
        }
    }

    function liquidate(uint256 laneSeed, uint256 keeperSeed) external tick("liquidate") {
        uint8 lane = uint8(laneSeed % 8);
        vm.prank(keepers[keeperSeed % keepers.length]);
        try ch.liquidateBatch(lane, _laneActors(lane)) returns (uint256 n) {
            calls["liquidate.liquidated"] += n;
        } catch Panic(uint256) {
            panics++;
        } catch {}
    }

    struct ExtSnap {
        address taker;
        uint8 lane;
        int256 victimColl;
        int256 takerColl;
        int256 laneNet; // insurance - badDebt
    }

    function _extSnap(address v, address t, uint8 lane) internal view returns (ExtSnap memory x) {
        x.taker = t;
        x.lane = lane;
        (x.victimColl,,,) = ch.getAccount(v);
        (x.takerColl,,,) = ch.getAccount(t);
        (uint256 ins, uint256 debt,,,) = ch.getLane(lane);
        x.laneNet = int256(ins) - int256(debt);
    }

    /// @dev External takes are paid only from the trader's equity: the taker gets exactly
    ///      min(P, max(E, 0)) and the lane's only outflow is the negative equity max(0, -E)
    ///      (its inflow is the trader's realized loss, collateral - E).
    function _checkExternal(ExtSnap memory x, int256 e, uint256 p, uint256 paid) internal {
        uint256 cap = e <= 0 ? 0 : (uint256(e) < p ? uint256(e) : p);
        (int256 takerColl,,,) = ch.getAccount(x.taker);
        (uint256 ins, uint256 debt,,,) = ch.getLane(x.lane);
        int256 laneDelta = int256(ins) - int256(debt) - x.laneNet;
        int256 expectedLane = (x.victimColl - e) - (e < 0 ? -e : int256(0));
        if (paid != cap || takerColl - x.takerColl != int256(paid) || laneDelta != expectedLane) {
            externalSubsidyViolations++;
        }
    }

    /// @dev Snapshot E and P of accounts about to be taken (to check "never more than E").
    function _preTake(address[] memory list) internal returns (int256[] memory eq, uint256[] memory pay) {
        eq = new int256[](list.length);
        pay = new uint256[](list.length);
        for (uint256 i; i < list.length; ++i) {
            try ch.accountHealth(list[i]) returns (int256 e, uint256, uint256, uint256 n) {
                (,, uint16 d) = ch.auctionOf(list[i]);
                eq[i] = e;
                pay[i] = (n * d) / 10_000;
            } catch Panic(uint256) {
                panics++;
            } catch {}
        }
    }

    function _postTake(address[] memory list, int256[] memory eq, uint256[] memory pay) internal {
        for (uint256 i; i < list.length; ++i) {
            (bool active,,) = ch.auctionOf(list[i]);
            if (active) continue; // not taken
            (int256 coll,,, bytes32[] memory mkts) = ch.getAccount(list[i]);
            int256 expected = eq[i] > int256(pay[i]) ? eq[i] - int256(pay[i]) : int256(0);
            if (coll < 0 || coll != expected || mkts.length != 0) traderOverchargeViolations++;
        }
    }

    // ------------------------------------------------------------------ backstop + lanes

    function backstopDeposit(uint256 lpSeed, uint256 laneSeed, uint256 amount) external tick("backstopDeposit") {
        address lp = lps[lpSeed % lps.length];
        amount = bound(amount, 1e6, 50_000e6);
        _mint(lp, amount);
        vm.prank(lp);
        try ch.backstopDeposit(uint8(laneSeed % 8), amount) {}
        catch Panic(uint256) {
            panics++;
        } catch {}
    }

    function backstopWithdraw(uint256 lpSeed, uint256 laneSeed, uint256 frac) external tick("backstopWithdraw") {
        address lp = lps[lpSeed % lps.length];
        uint8 lane = uint8(laneSeed % 8);
        uint256 owned = ch.backstopSharesOf(lane, lp);
        if (owned == 0) return;
        uint256 shares = (owned * bound(frac, 1, 100)) / 100;
        if (shares == 0) return;
        vm.prank(lp);
        try ch.backstopWithdraw(lane, shares) {
            calls["backstopWithdraw.ok"]++;
        } catch Panic(uint256) {
            panics++;
        } catch {}
    }

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
        uint256 size = (abs * bound(frac, 1, 110)) / 100; // > 100% exercises the cap
        if (size == 0) return;
        vm.prank(admin);
        try ch.backstopReduce(lane, pm[i], size) {
            calls["backstopReduce.ok"]++;
        } catch Panic(uint256) {
            panics++;
        } catch {}
    }

    function fundLane(uint256 laneSeed, uint256 amount) external tick("fundLane") {
        amount = bound(amount, 1e6, 20_000e6);
        _mint(admin, amount);
        vm.prank(admin);
        ch.fundLane(uint8(laneSeed % 8), amount);
    }

    function claimKeeperRewards(uint256 keeperSeed) external tick("claimKeeperRewards") {
        address k = keepers[keeperSeed % keepers.length];
        if (ch.keeperRewards(k) == 0) return;
        vm.prank(k);
        ch.claimKeeperRewards();
    }
}

/// @notice Solvency identity under random sequences, for Paraclr (lane-keyed storage).
contract ParaclrSolvencyInvariantTest is StdInvariant, Test {
    MockAUSD internal ausd;
    MockOracle internal oracle;
    ParaclrClearinghouse internal ch;
    SolvencyHandler internal handler;
    address internal admin = makeAddr("admin");

    function _shared() internal pure virtual returns (bool) {
        return false;
    }

    function setUp() public {
        vm.warp(1_700_000_000);
        vm.roll(100);
        ausd = new MockAUSD(admin);
        oracle = new MockOracle(admin);
        ch = _shared()
            ? ParaclrClearinghouse(address(new NaiveClearinghouseDemo(admin, ausd, IPriceOracle(address(oracle)))))
            : ParaclrClearinghouse(
                address(new ParaclrClearinghouseDemo(admin, ausd, IPriceOracle(address(oracle)), false))
            );

        bytes32[] memory m = new bytes32[](3);
        vm.startPrank(admin);
        m[0] = ch.listMarket("MON/AUSD");
        m[1] = ch.listMarket("SOL/AUSD");
        m[2] = ch.listMarket("BTC/AUSD");
        oracle.setPrice(m[0], 3e18);
        oracle.setPrice(m[1], 180e18);
        oracle.setPrice(m[2], 100_000e18);
        // Small insurance + pools so that shortfalls, bad debt and empty-pool expiry all happen.
        ausd.ownerMint(admin, 8 * 3_000e6);
        ausd.approve(address(ch), type(uint256).max);
        for (uint8 lane; lane < 8; ++lane) {
            ch.fundLane(lane, 1_000e6);
            ch.backstopDeposit(lane, 2_000e6);
        }
        vm.stopPrank();

        handler = new SolvencyHandler(ch, ausd, oracle, admin, m);
        // Every run starts from a two-sided book (both directions, all markets, 5x..20x) so any
        // price move pushes some accounts under maintenance and the auction paths get exercised.
        for (uint256 i; i < handler.actorCount(); ++i) {
            address a = handler.actors(i);
            vm.prank(admin);
            ausd.ownerMint(a, 1_000e6);
            vm.startPrank(a);
            ch.deposit(1_000e6);
            ch.openPosition(m[i % 3], i % 2 == 0, 100e6 + (i % 4) * 50e6, 5 + (i % 4) * 5);
            vm.stopPrank();
        }
        targetContract(address(handler));
        // Repeated selectors weight the mix toward trading, price moves and the auction sweep.
        bytes4[] memory sel = new bytes4[](25);
        sel[0] = SolvencyHandler.deposit.selector;
        sel[1] = SolvencyHandler.withdraw.selector;
        sel[2] = SolvencyHandler.open.selector;
        sel[3] = SolvencyHandler.open.selector;
        sel[4] = SolvencyHandler.open.selector;
        sel[5] = SolvencyHandler.close.selector;
        sel[6] = SolvencyHandler.movePrice.selector;
        sel[7] = SolvencyHandler.movePrice.selector;
        sel[8] = SolvencyHandler.movePrice.selector;
        sel[9] = SolvencyHandler.advanceBlocks.selector;
        sel[10] = SolvencyHandler.startAuctions.selector;
        sel[11] = SolvencyHandler.startAuctions.selector;
        sel[12] = SolvencyHandler.backstopTake.selector;
        sel[13] = SolvencyHandler.backstopTake.selector;
        sel[14] = SolvencyHandler.externalTake.selector;
        sel[15] = SolvencyHandler.externalTake.selector;
        sel[16] = SolvencyHandler.cancel.selector;
        sel[17] = SolvencyHandler.expire.selector;
        sel[18] = SolvencyHandler.liquidate.selector;
        sel[19] = SolvencyHandler.backstopDeposit.selector;
        sel[20] = SolvencyHandler.backstopWithdraw.selector;
        sel[21] = SolvencyHandler.backstopReduce.selector;
        sel[22] = SolvencyHandler.backstopReduce.selector;
        sel[23] = SolvencyHandler.fundLane.selector;
        sel[24] = SolvencyHandler.claimKeeperRewards.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    /// @notice AUSD.balanceOf(ch) == Σ(collateral + insurance + backstopCash + keeperRewards − badDebt),
    ///         exactly (no one donates AUSD in the handler), and `solvency()` reports it.
    function invariant_SolvencyIdentity() public view {
        (uint256 held, uint256 liabilities, int256 surplus, bool solvent) = ch.solvency();
        assertEq(held, ausd.balanceOf(address(ch)), "held");
        assertEq(surplus, 0, "surplus");
        assertEq(liabilities, held, "liabilities");
        assertTrue(solvent, "solvent");
    }

    /// @notice The maintained ledgers equal the same sums recomputed from account/keeper/pool
    ///         state, so the identity is not just self-consistent bookkeeping.
    function invariant_LedgersMatchUnderlyingState() public view {
        uint8 keys = _shared() ? 1 : 8;
        int256 ledgerColl;
        uint256 ledgerKeeper;
        int256 ledgerCash;
        int256 net;
        for (uint8 lane; lane < keys; ++lane) {
            (int256 coll, uint256 ins, int256 cash, uint256 kr, uint256 debt) = ch.laneLedger(lane);
            ledgerColl += coll;
            ledgerKeeper += kr;
            ledgerCash += cash;
            net += coll + int256(ins) + cash + int256(kr) - int256(debt);
            (, int256 navCash,,) = ch.backstopNav(lane);
            assertEq(navCash, cash, "pool cash");
        }
        int256 accounts;
        for (uint256 i; i < handler.actorCount(); ++i) {
            (int256 c,,,) = ch.getAccount(handler.actors(i));
            accounts += c;
        }
        assertEq(ledgerColl, accounts, "sum ledger collateral == sum account collateral");
        uint256 rewards;
        for (uint256 i; i < handler.keeperCount(); ++i) {
            rewards += ch.keeperRewards(handler.keepers(i));
        }
        assertEq(ledgerKeeper, rewards, "sum ledger keeper rewards == sum keeper balances");
        assertEq(net, int256(ausd.balanceOf(address(ch))), "identity from laneLedger");
    }

    /// @notice Pool shares: Σ LP balances == supply (admin seeded every lane).
    function invariant_BackstopSharesSumToSupply() public view {
        uint8 keys = _shared() ? 1 : 8;
        for (uint8 lane; lane < keys; ++lane) {
            (,,, uint256 supply) = ch.backstopNav(lane);
            uint256 sum; // lps[0] is admin, the seed LP
            for (uint256 i; i < handler.lpCount(); ++i) {
                sum += ch.backstopSharesOf(lane, handler.lps(i));
            }
            assertEq(sum, supply, "shares");
        }
    }

    /// @notice Every listed auction is active, every active account is listed exactly once, and
    ///         auctioned accounts are frozen (freeCollateral == 0).
    function invariant_AuctionListConsistent() public view {
        uint256 listed;
        for (uint8 lane; lane < 8; ++lane) {
            address[] memory list = ch.getAuctionAccounts(lane, 0, 100);
            listed += list.length;
            for (uint256 i; i < list.length; ++i) {
                (bool active,,) = ch.auctionOf(list[i]);
                assertTrue(active, "listed => active");
                assertEq(ch.laneOf(list[i]), lane, "list lane");
                assertEq(ch.freeCollateral(list[i]), 0, "frozen");
            }
        }
        uint256 activeCount;
        for (uint256 i; i < handler.actorCount(); ++i) {
            (bool a,,) = ch.auctionOf(handler.actors(i));
            if (a) ++activeCount;
        }
        assertEq(listed, activeCount, "active == listed");
    }

    /// @notice A take never charged a trader more than their equity E.
    function invariant_TraderNeverLosesMoreThanEquity() public view {
        assertEq(handler.traderOverchargeViolations(), 0);
    }

    /// @notice An external taker is paid only from the trader's own equity (min(P, max(E, 0)));
    ///         the lane funds nothing beyond the negative-equity write-off. Closes the
    ///         self-liquidation exploit (bankrupt account + same-lane taker).
    function invariant_ExternalTakerNeverPaidByLane() public view {
        assertEq(handler.externalSubsidyViolations(), 0);
    }

    /// @notice No clearinghouse call ever panicked (underflow/overflow/assert), even where the
    ///         handler tolerates ordinary reverts.
    function invariant_NoPanics() public view {
        assertEq(handler.panics(), 0);
    }

    function afterInvariant() external view {
        string[21] memory names = [
            "deposit",
            "withdraw",
            "open",
            "close",
            "movePrice",
            "advanceBlocks",
            "startAuctions",
            "startAuctions.started",
            "backstopTake.taken",
            "externalTake.taken",
            "externalTake.reverted",
            "cancel.cancelled",
            "expire.expired",
            "liquidate.liquidated",
            "backstopDeposit",
            "backstopWithdraw.ok",
            "backstopReduce.ok",
            "fundLane",
            "claimKeeperRewards",
            "backstopTake",
            "externalTake"
        ];
        for (uint256 i; i < names.length; ++i) {
            console2.log(names[i], handler.calls(bytes32(bytes(names[i]))));
        }
    }
}

/// @notice The same invariants on the naive shared-state baseline (identical logic).
contract NaiveSolvencyInvariantTest is ParaclrSolvencyInvariantTest {
    function _shared() internal pure override returns (bool) {
        return true;
    }
}
