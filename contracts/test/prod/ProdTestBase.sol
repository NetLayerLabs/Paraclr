// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {MockAUSD} from "../../src/MockAUSD.sol";
import {ParaclrClearinghouseProd} from "../../src/prod/ParaclrClearinghouseProd.sol";
import {MockPyth} from "./mocks/MockPyth.sol";

/// @notice Shared fixture for the production clearinghouse: MockAUSD (6 dp) as AUSD, the
///         test-only MockPyth, three markets with the REAL Monad-mainnet Pyth feed ids, lane
///         insurance funded, generous caps (cap tests set their own), an owner EOA (`admin`; the
///         timelock path is tested separately) and a guardian.
abstract contract ProdTestBase is Test {
    MockAUSD internal ausd;
    MockPyth internal pyth;
    ParaclrClearinghouseProd internal ch;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal keeper = makeAddr("keeper");

    // Pyth feed ids verified on Monad mainnet (Hermes /v2/price_feeds + on-chain getPriceUnsafe).
    bytes32 internal constant FEED_MON = 0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1;
    bytes32 internal constant FEED_SOL = 0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d;
    bytes32 internal constant FEED_BTC = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;

    bytes32 internal MON;
    bytes32 internal SOL;
    bytes32 internal BTC;

    int32 internal constant EXPO = -8;
    uint256 internal constant LANE_SEED = 100_000e6;
    uint256 internal constant EXEC_FEE = 0.1 ether;

    /// @dev Current "market" price per feed (Pyth integer at EXPO), used to build updates.
    mapping(bytes32 => int64) internal spot;
    mapping(bytes32 => uint64) internal conf;
    mapping(bytes32 => bytes32) internal feedOfMarket;
    bytes32[] internal feeds;
    bytes4 internal constant PYTH_MAGIC = 0x504e4155;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        vm.roll(1_000);
        ausd = new MockAUSD(admin);
        pyth = new MockPyth();
        feeds.push(FEED_MON);
        feeds.push(FEED_SOL);
        feeds.push(FEED_BTC);
        _setSpot(FEED_MON, 3e8); // 3 AUSD
        _setSpot(FEED_SOL, 180e8);
        _setSpot(FEED_BTC, 100_000e8);

        ch = new ParaclrClearinghouseProd(admin, IERC20(address(ausd)), IPyth(address(pyth)));
        vm.startPrank(admin);
        MON = ch.listMarket("MON/AUSD", FEED_MON, 100_000e6, 10_000_000e6, 100);
        SOL = ch.listMarket("SOL/AUSD", FEED_SOL, 100_000e6, 10_000_000e6, 100);
        BTC = ch.listMarket("BTC/AUSD", FEED_BTC, 100_000e6, 10_000_000e6, 100);
        feedOfMarket[MON] = FEED_MON;
        feedOfMarket[SOL] = FEED_SOL;
        feedOfMarket[BTC] = FEED_BTC;
        ch.setCaps(1_000_000e6, 100_000_000e6, 50_000);
        ch.setRiskParams(20, 5, 10e6);
        ch.setGuardian(guardian);
        ausd.ownerMint(admin, LANE_SEED * 8);
        ausd.approve(address(ch), type(uint256).max);
        for (uint8 lane; lane < 8; ++lane) {
            ch.fundLane(lane, LANE_SEED);
        }
        vm.stopPrank();
        vm.deal(keeper, 100 ether);
    }

    // ------------------------------------------------------------------ prices

    /// @dev Set the market price of `feed` and store it in the mock Pyth at `block.timestamp`.
    function _setSpot(bytes32 feed, int64 price) internal {
        spot[feed] = price;
        if (conf[feed] == 0) conf[feed] = uint64(uint256(int256(price)) / 10_000); // 1 bps
        pyth.setStoredPrice(feed, price, conf[feed], EXPO, block.timestamp);
    }

    function _msg(bytes32 feed, int64 price, uint256 publishTime, uint256 prev)
        internal
        view
        returns (MockPyth.Msg memory)
    {
        return MockPyth.Msg(feed, price, conf[feed], EXPO, uint64(publishTime), uint64(prev));
    }

    /// @dev One blob with every feed at the current spot, published at `t` (previous `t − 1`).
    function _updAll(uint256 t) internal view returns (bytes[] memory u) {
        MockPyth.Msg[] memory msgs = new MockPyth.Msg[](feeds.length);
        for (uint256 i; i < feeds.length; ++i) {
            msgs[i] = _msg(feeds[i], spot[feeds[i]], t, t - 1);
        }
        u = new bytes[](1);
        u[0] = abi.encode(PYTH_MAGIC, msgs);
    }

    function _upd1(bytes32 feed, int64 price, uint256 t, uint256 prev) internal view returns (bytes[] memory u) {
        MockPyth.Msg[] memory msgs = new MockPyth.Msg[](1);
        msgs[0] = _msg(feed, price, t, prev);
        u = new bytes[](1);
        u[0] = abi.encode(PYTH_MAGIC, msgs);
    }

    function _none() internal pure returns (bytes[] memory) {
        return new bytes[](0);
    }

    /// @dev No external call (keeps vm.prank / vm.expectRevert aimed at the clearinghouse).
    function _feedOf(bytes32 market) internal view returns (bytes32) {
        return feedOfMarket[market];
    }

    /// @dev Pyth integer (EXPO −8) → 1e18 price.
    function _px18(int64 p) internal pure returns (uint256) {
        return uint256(int256(p)) * 1e10;
    }

    // ------------------------------------------------------------------ accounts

    function laneAddr(uint8 lane, uint256 salt) internal pure returns (address) {
        uint160 base = uint160(uint256(keccak256(abi.encode("paraclr-prod", salt))));
        return address((base & ~uint160(7)) | uint160(lane));
    }

    function fund(address who, uint256 amount) internal {
        vm.prank(admin);
        ausd.ownerMint(who, amount);
        vm.startPrank(who);
        ausd.approve(address(ch), type(uint256).max);
        ch.deposit(amount);
        vm.stopPrank();
        vm.deal(who, 10 ether);
    }

    function collateralOf(address who) internal view returns (int256 c) {
        (c,,,,,) = ch.getAccount(who);
    }

    function _sizeFor(uint256 notional, bytes32 market) internal view returns (uint256) {
        return (notional * 1e30) / _px18(spot[_feedOf(market)]);
    }

    // ------------------------------------------------------------------ orders

    function _commit(address who, bytes32 market, int256 sizeDelta, uint256 margin, uint256 acceptable)
        internal
        returns (uint256 id)
    {
        vm.prank(who);
        id = ch.commitOrder{value: EXEC_FEE}(market, sizeDelta, margin, acceptable);
    }

    /// @dev Warp to execAfter + 1 and execute with the unique update published exactly at
    ///      execAfter (previous publish time execAfter − 1), every feed at spot.
    function _execute(uint256 id) internal {
        ParaclrClearinghouseProd.Order memory o = ch.getOrder(id);
        if (block.timestamp < o.execAfter + 1) vm.warp(o.execAfter + 1);
        _refreshStored();
        bytes[] memory u = _updAll(o.execAfter);
        vm.prank(keeper);
        ch.executeOrder(id, u);
    }

    /// @dev Pyth-stored prices republished at the current time (keeps fallbacks fresh).
    function _refreshStored() internal {
        for (uint256 i; i < feeds.length; ++i) {
            pyth.setStoredPrice(feeds[i], spot[feeds[i]], conf[feeds[i]], EXPO, block.timestamp);
        }
    }

    /// @dev Open (or increase) `notional` AUSD of exposure with `margin`, via commit + execute.
    function _open(address who, bytes32 market, bool isLong, uint256 notional, uint256 margin)
        internal
        returns (uint256 id)
    {
        int256 size = int256(_sizeFor(notional, market));
        id = _commit(who, market, isLong ? size : -size, margin, isLong ? type(uint128).max : 1);
        _execute(id);
        assertEq(uint8(ch.getOrder(id).status), uint8(ParaclrClearinghouseProd.OrderStatus.Executed), "open filled");
    }

    function _closeAll(address who, bytes32 market) internal returns (uint256 id) {
        ParaclrClearinghouseProd.Position memory p = ch.getPosition(who, market);
        int256 delta = p.isLong ? -int256(p.size) : int256(p.size);
        id = _commit(who, market, delta, 0, p.isLong ? 1 : type(uint128).max);
        _execute(id);
    }

    // ------------------------------------------------------------------ backstop LPs

    /// @dev Two-step LP exit: request, wait the withdrawal delay (prices republished), withdraw.
    function _requestAndWait(address lp, uint8 lane, uint256 shares) internal {
        vm.prank(lp);
        ch.backstopRequestWithdraw(lane, shares);
        vm.warp(block.timestamp + ch.backstopWithdrawDelay());
        _refreshStored();
    }

    function _lpWithdraw(address lp, uint8 lane, uint256 shares) internal returns (uint256 out) {
        _requestAndWait(lp, lane, shares);
        vm.prank(lp);
        out = ch.backstopWithdraw(lane, shares, _none());
    }

    // ------------------------------------------------------------------ solvency

    function assertSolvent() internal view {
        (uint256 held, uint256 liabilities, int256 surplus, bool solvent) = ch.solvency();
        assertEq(held, ausd.balanceOf(address(ch)), "held");
        assertEq(surplus, 0, "AUSD surplus");
        assertEq(liabilities, held, "AUSD liabilities");
        assertTrue(solvent, "solvent");
        uint256 lanesHeld;
        for (uint8 lane; lane < 8; ++lane) {
            (uint256 h, int256 claims, int256 sur, uint256 ins, uint256 debt,) = ch.laneSolvency(lane);
            lanesHeld += h;
            assertEq(sur, int256(h) - claims, "lane surplus = held - claims");
            assertEq(sur, int256(ins) - int256(debt), "per-lane identity: surplus = insurance - bad debt");
        }
        assertEq(lanesHeld, held, "sum of lane holdings == AUSD held");
        (uint256 nHeld, uint256 nLiab, bool nSolvent) = ch.nativeSolvency();
        assertEq(nHeld, address(ch).balance, "native held");
        assertEq(nLiab, nHeld, "native liabilities == balance");
        assertTrue(nSolvent, "native solvent");
    }
}
