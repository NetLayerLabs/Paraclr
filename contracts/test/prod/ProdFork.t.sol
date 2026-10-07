// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";

/// @notice OPT-IN mainnet-fork test against the REAL Agora AUSD and the REAL Pyth contract on
///         Monad mainnet, using a REAL signed Pyth update captured from the chain (the on-chain
///         pusher's `updatePriceFeedsIfNecessary` calldata in block 111172148; 20 feeds incl.
///         MON/SOL/BTC, publishTime 1791330282, previous publish time 1791330281).
///
///   MONAD_FORK_RPC=https://rpc.monad.xyz forge test --match-contract ProdForkTest -vv
///
/// Read-only for the real chain: everything happens in the local fork. Skipped when
/// MONAD_FORK_RPC is unset. Forks at block 111172140 (timestamp 1791330280), so an order
/// committed there has execAfter = 1791330282 = the captured update's publish time: the update
/// is exactly the unique first update at/after execAfter that `parsePriceFeedUpdatesUnique`
/// accepts on the real contract.
contract ProdForkTest is Test {
    address internal constant AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a;
    address internal constant PYTH = 0x2880aB155794e7179c9eE2e38200202908C17B43;
    address internal constant AUSD_HOLDER = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e; // impersonated on the fork
    bytes32 internal constant FEED_MON = 0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1;
    bytes32 internal constant FEED_SOL = 0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d;
    bytes32 internal constant FEED_BTC = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    uint256 internal constant FORK_BLOCK = 111_172_140;
    uint256 internal constant PUBLISH_TIME = 1_791_330_282;

    CH internal ch;
    address internal admin = makeAddr("admin");
    address internal trader = address(uint160(uint256(keccak256("fork-trader"))) & ~uint160(7) | 3);
    address internal keeper = makeAddr("keeper");
    bytes32 internal MON;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true, "set MONAD_FORK_RPC to run the Monad-mainnet fork test");
            return;
        }
        vm.createSelectFork(rpc, FORK_BLOCK);
        assertEq(block.chainid, 143);
        assertEq(block.timestamp, PUBLISH_TIME - 2);
        ch = new CH(admin, IERC20(AUSD), IPyth(PYTH));
        vm.startPrank(admin);
        MON = ch.listMarket("MON/AUSD", FEED_MON, 10_000e6, 5_000e6, 100);
        ch.listMarket("SOL/AUSD", FEED_SOL, 10_000e6, 5_000e6, 100);
        ch.listMarket("BTC/AUSD", FEED_BTC, 10_000e6, 5_000e6, 100);
        // the captured payload is the first update at commit + 2 s
        ch.setOrderParams(2, 60, 0.1 ether);
        vm.stopPrank();
        vm.startPrank(AUSD_HOLDER);
        IERC20(AUSD).transfer(admin, 800e6);
        IERC20(AUSD).transfer(trader, 50e6);
        vm.stopPrank();
        vm.startPrank(admin);
        IERC20(AUSD).approve(address(ch), type(uint256).max);
        for (uint8 lane; lane < 8; ++lane) {
            ch.fundLane(lane, 100e6);
        }
        vm.stopPrank();
        vm.deal(trader, 1 ether);
        vm.deal(keeper, 1 ether);
    }

    function _update() internal view returns (bytes[] memory u) {
        u = new bytes[](1);
        u[0] = vm.parseBytes(vm.readFile(string.concat(vm.projectRoot(), "/test/prod/fixtures/pyth-monad-mainnet-111172148.hex")));
    }

    function test_Fork_RealAusdAndRealPyth_OrderLifecycle() public {
        // real AUSD deposit (balance-delta credited)
        vm.startPrank(trader);
        IERC20(AUSD).approve(address(ch), type(uint256).max);
        ch.deposit(50e6);
        // buy ~400 AUSD of MON at 10x (MON ≈ 0.0284)
        uint256 size = 14_000e18;
        uint256 id = ch.commitOrder{value: 0.1 ether}(MON, int256(size), 40e6, 0.05e18);
        vm.stopPrank();
        CH.Order memory o = ch.getOrder(id);
        assertEq(o.execAfter, PUBLISH_TIME);

        vm.warp(PUBLISH_TIME + 1);
        vm.roll(FORK_BLOCK + 8);
        bytes[] memory u = _update();
        uint256 fee = IPyth(PYTH).getUpdateFee(u);
        console2.log("real Pyth update fee (wei):", fee);
        uint256 g = gasleft();
        vm.prank(keeper);
        ch.executeOrder{value: fee}(id, u);
        console2.log("executeOrder gas incl. real Pyth verification:", g - gasleft());
        assertEq(uint8(ch.getOrder(id).status), uint8(CH.OrderStatus.Executed), "filled on the real Pyth");
        CH.Position memory p = ch.getPosition(trader, MON);
        assertEq(p.entryPrice, 2_841_123 * 1e10, "MON/USD 0.02841123 (expo -8) normalised to 1e18");
        assertEq(p.size, size);

        // a later update is NOT accepted for a fresh order whose execAfter precedes it by > 0 s:
        // uniqueness on the real contract (prev publish time 1791330281 < min only for min = 1791330282)
        vm.prank(trader);
        uint256 id2 = ch.commitOrder{value: 0.1 ether}(keccak256("SOL/AUSD"), 1e18, 5e6, 1_000e18);
        vm.warp(block.timestamp + 3);
        vm.prank(keeper);
        vm.expectRevert(); // PriceFeedNotFoundWithinRange from the real Pyth
        ch.executeOrder{value: fee}(id2, u);

        // fresh-price path through the real parse: withdraw with the same (still fresh) update
        vm.warp(PUBLISH_TIME + 30);
        vm.prank(trader);
        ch.withdraw{value: fee}(1e6, u);
        (uint256 held, uint256 liab, int256 surplus,) = ch.solvency();
        assertEq(held, liab);
        assertEq(surplus, 0);
        assertEq(IERC20(AUSD).balanceOf(trader), 1e6);
    }
}
