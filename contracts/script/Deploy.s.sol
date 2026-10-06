// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {MockAUSD} from "../src/MockAUSD.sol";
import {MockOracle} from "../src/oracles/MockOracle.sol";
import {ParaclrClearinghouse} from "../src/ParaclrClearinghouse.sol";
import {ParaclrClearinghouseDemo} from "../src/ParaclrClearinghouseDemo.sol";
import {NaiveClearinghouseDemo} from "../src/NaiveClearinghouseDemo.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";

/// @notice Deploys the Paraclr DEMO stack: MockAUSD + MockOracle + ParaclrClearinghouseDemo
///         (lane-sharded storage) + NaiveClearinghouseDemo (the identical code with one shared
///         storage key per aggregate — the Conflict X-ray baseline), both on the same oracle and
///         AUSD. For BOTH clearinghouses it lists MON/SOL/BTC, sets maxPriceAge, funds all 8 lane
///         insurance funds and seeds all 8 lane backstop pools from the operator. It allowlists
///         the keeper's price-pusher key on the oracle, optionally allowlists extra
///         `backstopReduce` operators (the owner/operator is always allowed), and writes
///         `deployments/<chainId>.json` for the keeper and the frontend.
///
/// Prefer the wrappers, which take keys from gitignored env files and fix up `deployBlock`:
///   npm run deploy:anvil     (anvil dev key, chain 31337; `npm run dev:chain` calls this)
///   npm run deploy:monad     (OPERATOR_PRIVATE_KEY from keeper/.env, chain 10143)
///
/// Raw usage:
///   PRIVATE_KEY=0x… ORACLE_UPDATERS=0xPusher forge script script/Deploy.s.sol \
///     --rpc-url monad_testnet --broadcast --slow
///
/// Env:
///   PRIVATE_KEY         deployer = owner of every contract = the keeper's OPERATOR key
///   ORACLE_UPDATERS     optional, comma-separated addresses allowed to push prices
///   BACKSTOP_OPERATORS  optional, comma-separated addresses allowed to call `backstopReduce`
///                       on both clearinghouses (the owner always may)
///   LANE_SEED           optional, AUSD (6dp) per lane insurance fund, default 100,000 AUSD
///   BACKSTOP_SEED       optional, AUSD (6dp) per lane backstop pool, default 50,000 AUSD
///                       (per lane, per clearinghouse; 0 skips seeding)
///   BACKSTOP_MIN_DISCOUNT_BPS  optional, per-lane pool take threshold on both clearinghouses;
///                       unset keeps the contract default (75 bps, below the 1% legacy penalty)
contract Deploy is Script {
    uint256 internal constant DEFAULT_LANE_SEED = 100_000e6; // 100k AUSD per lane
    uint256 internal constant DEFAULT_BACKSTOP_SEED = 50_000e6; // 50k AUSD per lane pool

    struct Config {
        address deployer;
        address[] updaters;
        address[] backstopOperators;
        uint256 laneSeed;
        uint256 backstopSeed;
        uint256 minDiscountBps; // 0 = keep the contract default
    }

    function run()
        external
        returns (MockAUSD ausd, MockOracle oracle, ParaclrClearinghouseDemo clearinghouse, NaiveClearinghouseDemo naive)
    {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        Config memory cfg;
        cfg.deployer = vm.addr(pk);
        cfg.updaters = vm.envOr("ORACLE_UPDATERS", ",", new address[](0));
        cfg.backstopOperators = vm.envOr("BACKSTOP_OPERATORS", ",", new address[](0));
        cfg.laneSeed = vm.envOr("LANE_SEED", DEFAULT_LANE_SEED);
        cfg.backstopSeed = vm.envOr("BACKSTOP_SEED", DEFAULT_BACKSTOP_SEED);
        cfg.minDiscountBps = vm.envOr("BACKSTOP_MIN_DISCOUNT_BPS", uint256(0));

        // Same markets and starting prices as the frontend simulator (src/lib/prices/markets.ts).
        string[3] memory symbols = ["MON/AUSD", "SOL/AUSD", "BTC/AUSD"];
        uint256[3] memory prices = [uint256(0.04e18), 180e18, 110_000e18];
        bytes32[3] memory ids;

        uint256 deployBlock = block.number;
        vm.startBroadcast(pk);

        ausd = new MockAUSD(cfg.deployer);
        oracle = new MockOracle(cfg.deployer);
        clearinghouse = new ParaclrClearinghouseDemo(cfg.deployer, ausd, IPriceOracle(address(oracle)), false);
        naive = new NaiveClearinghouseDemo(cfg.deployer, ausd, IPriceOracle(address(oracle)));

        for (uint256 i; i < cfg.updaters.length; ++i) {
            oracle.setUpdater(cfg.updaters[i], true);
        }
        for (uint256 i; i < symbols.length; ++i) {
            ids[i] = clearinghouse.listMarket(symbols[i]);
            naive.listMarket(symbols[i]);
            oracle.setPrice(ids[i], prices[i]);
        }

        // Insurance + backstop for both designs, so the X-ray compares identically funded books.
        ausd.ownerMint(cfg.deployer, (cfg.laneSeed + cfg.backstopSeed) * 8 * 2);
        _configure(clearinghouse, ausd, cfg);
        _configure(naive, ausd, cfg);

        vm.stopBroadcast();

        console2.log("MockAUSD                ", address(ausd));
        console2.log("MockOracle              ", address(oracle));
        console2.log("ParaclrClearinghouseDemo", address(clearinghouse));
        console2.log("NaiveClearinghouseDemo  ", address(naive));
        for (uint256 i; i < cfg.updaters.length; ++i) {
            console2.log("oracle updater          ", cfg.updaters[i]);
        }
        for (uint256 i; i < cfg.backstopOperators.length; ++i) {
            console2.log("backstop operator       ", cfg.backstopOperators[i]);
        }

        // Only a real broadcast records addresses; a dry run must not overwrite deployments/.
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            _writeDeployment(
                address(ausd), address(oracle), address(clearinghouse), address(naive), deployBlock, symbols, ids
            );
        }
    }

    /// @dev Everything after deployment that is identical for both clearinghouses.
    function _configure(ParaclrClearinghouse ch, MockAUSD ausd, Config memory cfg) internal {
        // The keeper pushes prices continuously, but tolerate a day of silence so a paused
        // keeper never bricks the demo (stale prices revert every trade and liquidation).
        ch.setMaxPriceAge(1 days);
        for (uint256 i; i < cfg.backstopOperators.length; ++i) {
            ch.setBackstopOperator(cfg.backstopOperators[i], true);
        }
        ausd.approve(address(ch), (cfg.laneSeed + cfg.backstopSeed) * 8);
        for (uint8 lane; lane < 8; ++lane) {
            if (cfg.minDiscountBps > 0) ch.setBackstopMinDiscount(lane, uint16(cfg.minDiscountBps));
            if (cfg.laneSeed > 0) ch.fundLane(lane, cfg.laneSeed);
            // Naive: all 8 deposits land in the one shared pool (8 × seed), by design.
            if (cfg.backstopSeed > 0) ch.backstopDeposit(lane, cfg.backstopSeed);
        }
    }

    /// @dev deployments/<chainId>.json — the shape in docs/ONCHAIN_PLAN.md plus `naive`
    ///      (docs/FAIR_LIQUIDATION_PLAN.md). `deployBlock` is the chain head when the script
    ///      started (a safe lower bound for log scans); the npm wrapper replaces it with the exact
    ///      block from the broadcast receipts.
    function _writeDeployment(
        address ausd,
        address oracle,
        address clearinghouse,
        address naive,
        uint256 deployBlock,
        string[3] memory symbols,
        bytes32[3] memory ids
    ) internal {
        string memory m = "markets";
        string memory marketsJson;
        for (uint256 i; i < symbols.length; ++i) {
            marketsJson = vm.serializeBytes32(m, symbols[i], ids[i]);
        }
        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "clearinghouse", clearinghouse);
        vm.serializeAddress(o, "naive", naive);
        vm.serializeAddress(o, "ausd", ausd);
        vm.serializeAddress(o, "oracle", oracle);
        vm.serializeUint(o, "deployBlock", deployBlock);
        string memory json = vm.serializeString(o, "markets", marketsJson);
        string memory path = string.concat(vm.projectRoot(), "/../deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("wrote", path);
    }
}
