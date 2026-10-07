// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import {ParaclrClearinghouseProd} from "../src/prod/ParaclrClearinghouseProd.sol";

/// @notice PRODUCTION deploy (Monad mainnet, chain 143, guarded beta). Deploys an OpenZeppelin
///         TimelockController (proposer = executor = canceller = the owner multisig, self-
///         administered) and `ParaclrClearinghouseProd` on the REAL AUSD and Pyth, after checking
///         both on chain. Lists MON/SOL/BTC with the verified Pyth feed ids, applies the beta caps,
///         wires the guardian and the lane keepers (backstop operators), optionally funds lane
///         insurance, transfers ownership to the timelock and verifies the deployer holds no power.
///         On a real broadcast it writes the deployment JSON (`"production": true`).
///
/// Env (names from keeper/.env.mainnet.example; the keeper deploy flow passes them):
///   DEPLOYER_PRIVATE_KEY              required. Deploys and wires; powerless afterwards.
///   OWNER_MULTISIG_ADDRESS            required. Safe (or hardware wallet) behind the timelock.
///   TIMELOCK_MIN_DELAY_SECONDS        default 86400; < 3600 rejected unless ALLOW_SHORT_TIMELOCK=true.
///   GUARDIAN_ADDRESS                  or GUARDIAN_PRIVATE_KEY (address derived; never broadcast).
///   KEEPER_ADDRESSES                  or KEEPER_PRIVATE_KEYS (comma-separated, lane i <-> i, at most 8):
///                                     keeper i may call `backstopReduce` on lane i's pool ONLY. Optional.
///   OWNER_IS_EOA                      default false. The owner multisig must have code (Safe) unless this
///                                     is set to true for a hardware-wallet owner.
///   MAX_DEPOSIT_PER_ACCOUNT_AUSD      whole AUSD, default 50.
///   MAX_TVL_PER_LANE_AUSD             whole AUSD, default 500.
///   MAX_LEVERAGE                      default 10 (1..20).
///   AUSD_ADDRESS / PYTH_ADDRESS       default the verified Monad-mainnet addresses.
///   CHAIN_ID                          default 143; the script refuses any other chain.
///   Optional: TRADING_FEE_BPS (5), MIN_POSITION_AUSD (10), OI_CAP_MULTIPLIER_BPS (50000),
///     MAX_LANE_OI_AUSD (MAX_TVL_PER_LANE × MAX_LEVERAGE), SKEW_SCALE_AUSD (10000),
///     MAX_FUNDING_BPS_PER_DAY (100), MAX_PRICE_AGE_SECONDS (30, supplied updates),
///     MAX_STORED_PRICE_AGE_SECONDS (15, Pyth-stored / lane prices), MAX_CONF_BPS (200),
///     MIN_EXEC_DELAY_SECONDS (3), MAX_EXEC_DELAY_SECONDS (60), MIN_EXECUTION_FEE_WEI (1e17),
///     BACKSTOP_WITHDRAW_DELAY_SECONDS (3600),
///     FUNDING_INTERVAL_SECONDS (60), BACKSTOP_MIN_DISCOUNT_BPS (contract default 75),
///     LANE_INSURANCE_SEED_AUSD (0; whole AUSD per lane, from the deployer's AUSD),
///     PYTH_FEED_MON_USD / PYTH_FEED_SOL_USD / PYTH_FEED_BTC_USD (verified defaults),
///     PYTH_MAX_FEED_AGE_SECONDS (3600: each feed must have been pushed on this chain recently),
///     DEPLOYMENTS_OUT (output file; default ../deployments/<chainId>.json; must be under
///     ../deployments or ./cache — see fs_permissions in foundry.toml).
///
/// Usage (the keeper wrapper does this; anvil must use --code-size-limit 131072):
///   forge script script/DeployProd.s.sol --rpc-url $KEEPER_RPC_URL --broadcast --slow
contract DeployProd is Script {
    // Verified 2026-10-07 (see contracts/README.md → Production → Verified facts).
    address internal constant MAINNET_AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a;
    address internal constant MAINNET_PYTH = 0x2880aB155794e7179c9eE2e38200202908C17B43;
    bytes32 internal constant FEED_MON_USD = 0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1;
    bytes32 internal constant FEED_SOL_USD = 0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d;
    bytes32 internal constant FEED_BTC_USD = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;

    struct Cfg {
        uint256 deployerKey;
        address deployer;
        address multisig;
        uint256 minDelay;
        address guardian;
        address[] keepers;
        address ausd;
        address pyth;
        uint256 chainId;
        uint256 maxDeposit; // 6dp
        uint256 maxTvl; // 6dp
        uint256 maxLeverage;
        uint256 tradingFeeBps;
        uint256 minPosition; // 6dp
        uint256 oiMultiplierBps;
        uint256 maxLaneOi; // 6dp
        uint256 skewScale; // 6dp
        uint256 maxFundingBpsPerDay;
        uint256 maxPriceAge;
        uint256 maxStoredPriceAge;
        uint256 maxConfBps;
        uint256 backstopWithdrawDelay;
        bool ownerIsEoa;
        uint256 minExecDelay;
        uint256 maxExecDelay;
        uint256 minExecutionFee;
        uint256 fundingInterval;
        uint256 backstopMinDiscountBps; // 0 = contract default
        uint256 laneSeed; // 6dp per lane
        uint256 maxFeedAge;
        string[3] symbols;
        bytes32[3] feeds;
    }

    function run() external returns (ParaclrClearinghouseProd ch, TimelockController timelock) {
        Cfg memory c = _load();
        _verifyExternal(c);

        uint256 deployBlock = block.number;
        bytes32[3] memory ids;
        vm.startBroadcast(c.deployerKey);
        {
            address[] memory roles = new address[](1);
            roles[0] = c.multisig;
            // admin = address(0): the timelock administers itself; nobody else holds a role.
            timelock = new TimelockController(c.minDelay, roles, roles, address(0));
        }
        ch = new ParaclrClearinghouseProd(c.deployer, IERC20(c.ausd), IPyth(c.pyth));
        for (uint256 i; i < 3; ++i) {
            ids[i] = ch.listMarket(c.symbols[i], c.feeds[i], c.skewScale, c.maxLaneOi, c.maxFundingBpsPerDay);
        }
        ch.setRiskParams(c.maxLeverage, c.tradingFeeBps, c.minPosition);
        ch.setCaps(c.maxDeposit, c.maxTvl, c.oiMultiplierBps);
        ch.setOracleParams(c.maxPriceAge, c.maxStoredPriceAge, c.maxConfBps);
        ch.setBackstopParams(c.backstopWithdrawDelay);
        ch.setOrderParams(c.minExecDelay, c.maxExecDelay, c.minExecutionFee);
        ch.setFundingParams(c.fundingInterval);
        if (c.backstopMinDiscountBps != 0) {
            for (uint8 lane; lane < 8; ++lane) {
                ch.setBackstopMinDiscount(lane, uint16(c.backstopMinDiscountBps));
            }
        }
        ch.setGuardian(c.guardian);
        for (uint256 i; i < c.keepers.length; ++i) {
            ch.setBackstopOperator(c.keepers[i], uint8(i), true); // keeper i <-> lane i only
        }
        if (c.laneSeed > 0) {
            IERC20(c.ausd).approve(address(ch), c.laneSeed * 8);
            for (uint8 lane; lane < 8; ++lane) {
                ch.fundLane(lane, c.laneSeed);
            }
        }
        ch.transferOwnership(address(timelock));
        vm.stopBroadcast();

        _verifyWiring(c, ch, timelock);
        _log(c, ch, timelock);
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            _write(c, ch, timelock, deployBlock, ids);
        }
    }

    // ------------------------------------------------------------------ config

    function _load() internal view returns (Cfg memory c) {
        c.deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        c.deployer = vm.addr(c.deployerKey);
        c.multisig = vm.envAddress("OWNER_MULTISIG_ADDRESS");
        c.minDelay = vm.envOr("TIMELOCK_MIN_DELAY_SECONDS", uint256(86_400));
        c.guardian = vm.envOr("GUARDIAN_ADDRESS", address(0));
        if (c.guardian == address(0)) {
            uint256 gk = vm.envOr("GUARDIAN_PRIVATE_KEY", uint256(0));
            if (gk != 0) c.guardian = vm.addr(gk);
        }
        c.keepers = vm.envOr("KEEPER_ADDRESSES", ",", new address[](0));
        if (c.keepers.length == 0) {
            uint256[] memory kk = vm.envOr("KEEPER_PRIVATE_KEYS", ",", new uint256[](0));
            c.keepers = new address[](kk.length);
            for (uint256 i; i < kk.length; ++i) {
                c.keepers[i] = vm.addr(kk[i]);
            }
        }
        c.ausd = vm.envOr("AUSD_ADDRESS", MAINNET_AUSD);
        c.pyth = vm.envOr("PYTH_ADDRESS", MAINNET_PYTH);
        c.chainId = vm.envOr("CHAIN_ID", uint256(143));
        c.maxDeposit = vm.envOr("MAX_DEPOSIT_PER_ACCOUNT_AUSD", uint256(50)) * 1e6;
        c.maxTvl = vm.envOr("MAX_TVL_PER_LANE_AUSD", uint256(500)) * 1e6;
        c.maxLeverage = vm.envOr("MAX_LEVERAGE", uint256(10));
        c.tradingFeeBps = vm.envOr("TRADING_FEE_BPS", uint256(5));
        c.minPosition = vm.envOr("MIN_POSITION_AUSD", uint256(10)) * 1e6;
        c.oiMultiplierBps = vm.envOr("OI_CAP_MULTIPLIER_BPS", uint256(50_000));
        c.maxLaneOi = vm.envOr("MAX_LANE_OI_AUSD", (c.maxTvl / 1e6) * c.maxLeverage) * 1e6;
        c.skewScale = vm.envOr("SKEW_SCALE_AUSD", uint256(10_000)) * 1e6;
        c.maxFundingBpsPerDay = vm.envOr("MAX_FUNDING_BPS_PER_DAY", uint256(100));
        c.maxPriceAge = vm.envOr("MAX_PRICE_AGE_SECONDS", uint256(30));
        c.maxStoredPriceAge = vm.envOr("MAX_STORED_PRICE_AGE_SECONDS", uint256(15));
        c.backstopWithdrawDelay = vm.envOr("BACKSTOP_WITHDRAW_DELAY_SECONDS", uint256(3_600));
        c.ownerIsEoa = vm.envOr("OWNER_IS_EOA", false);
        c.maxConfBps = vm.envOr("MAX_CONF_BPS", uint256(200));
        c.minExecDelay = vm.envOr("MIN_EXEC_DELAY_SECONDS", uint256(3));
        c.maxExecDelay = vm.envOr("MAX_EXEC_DELAY_SECONDS", uint256(60));
        c.minExecutionFee = vm.envOr("MIN_EXECUTION_FEE_WEI", uint256(0.1 ether));
        c.fundingInterval = vm.envOr("FUNDING_INTERVAL_SECONDS", uint256(60));
        c.backstopMinDiscountBps = vm.envOr("BACKSTOP_MIN_DISCOUNT_BPS", uint256(0));
        c.laneSeed = vm.envOr("LANE_INSURANCE_SEED_AUSD", uint256(0)) * 1e6;
        c.maxFeedAge = vm.envOr("PYTH_MAX_FEED_AGE_SECONDS", uint256(3_600));
        c.symbols = ["MON/AUSD", "SOL/AUSD", "BTC/AUSD"];
        c.feeds[0] = vm.envOr("PYTH_FEED_MON_USD", FEED_MON_USD);
        c.feeds[1] = vm.envOr("PYTH_FEED_SOL_USD", FEED_SOL_USD);
        c.feeds[2] = vm.envOr("PYTH_FEED_BTC_USD", FEED_BTC_USD);
    }

    // ------------------------------------------------------------------ checks

    /// @dev Everything about the outside world the deployment relies on, checked on chain BEFORE
    ///      anything is deployed.
    function _verifyExternal(Cfg memory c) internal view {
        require(block.chainid == c.chainId, "DeployProd: wrong chain (CHAIN_ID)");
        require(c.multisig != address(0), "DeployProd: OWNER_MULTISIG_ADDRESS missing");
        require(c.multisig != c.deployer, "DeployProd: owner multisig must not be the deployer");
        require(c.guardian != address(0), "DeployProd: GUARDIAN_ADDRESS / GUARDIAN_PRIVATE_KEY missing");
        require(c.guardian != c.deployer && c.guardian != c.multisig, "DeployProd: guardian must be its own key");
        require(c.multisig.code.length > 0 || c.ownerIsEoa, "DeployProd: owner multisig has no code (set OWNER_IS_EOA=true for a hardware wallet)");
        require(c.keepers.length <= 8, "DeployProd: more than 8 keepers");
        for (uint256 i; i < c.keepers.length; ++i) {
            require(c.keepers[i] != c.deployer, "DeployProd: a keeper is the deployer");
            require(c.keepers[i] != address(0), "DeployProd: zero keeper");
            require(c.keepers[i] != c.guardian && c.keepers[i] != c.multisig, "DeployProd: keeper reuses a role key");
            for (uint256 j; j < i; ++j) {
                require(c.keepers[i] != c.keepers[j], "DeployProd: duplicate keeper");
            }
        }
        require(
            c.minDelay >= 3_600 || vm.envOr("ALLOW_SHORT_TIMELOCK", false), "DeployProd: timelock delay < 1 hour"
        );
        require(c.maxLeverage >= 1 && c.maxLeverage <= 20, "DeployProd: MAX_LEVERAGE out of 1..20");
        require(c.maxDeposit > 0 && c.maxTvl >= c.maxDeposit, "DeployProd: caps");

        // AUSD: real code, 6 decimals, symbol, supply, transfers not paused (Agora AUSD exposes
        // isTransferPaused(); a token without it is accepted).
        require(c.ausd.code.length > 0, "DeployProd: AUSD has no code");
        require(IERC20Metadata(c.ausd).decimals() == 6, "DeployProd: AUSD decimals != 6");
        require(
            keccak256(bytes(IERC20Metadata(c.ausd).symbol())) == keccak256("AUSD"), "DeployProd: AUSD symbol mismatch"
        );
        require(IERC20(c.ausd).totalSupply() > 0, "DeployProd: AUSD supply is 0");
        (bool ok, bytes memory ret) = c.ausd.staticcall(abi.encodeWithSignature("isTransferPaused()"));
        if (ok && ret.length == 32) require(!abi.decode(ret, (bool)), "DeployProd: AUSD transfers are paused");
        if (c.laneSeed > 0) {
            require(IERC20(c.ausd).balanceOf(c.deployer) >= c.laneSeed * 8, "DeployProd: deployer lacks AUSD seed");
        }

        // Pyth: real code; every feed exists on this chain, positive, sane exponent, recently
        // pushed, confidence within MAX_CONF_BPS.
        require(c.pyth.code.length > 0, "DeployProd: Pyth has no code");
        IPyth pyth = IPyth(c.pyth);
        pyth.getUpdateFee(new bytes[](0)); // interface smoke test
        for (uint256 i; i < 3; ++i) {
            for (uint256 j; j < i; ++j) {
                require(c.feeds[i] != c.feeds[j], "DeployProd: duplicate feed id");
            }
            PythStructs.Price memory p = pyth.getPriceUnsafe(c.feeds[i]);
            require(p.price > 0, "DeployProd: feed price <= 0");
            require(p.expo >= -30 && p.expo <= 12, "DeployProd: feed expo out of range");
            require(p.publishTime + c.maxFeedAge >= block.timestamp, "DeployProd: feed not pushed recently");
            require(uint256(p.conf) * 10_000 <= c.maxConfBps * uint256(uint64(p.price)), "DeployProd: feed conf too wide");
        }
    }

    /// @dev The deployed system is wired as intended and the deployer holds no power.
    function _verifyWiring(Cfg memory c, ParaclrClearinghouseProd ch, TimelockController tl) internal view {
        require(ch.owner() == address(tl), "DeployProd: owner != timelock");
        require(address(ch.ausd()) == c.ausd && address(ch.pyth()) == c.pyth, "DeployProd: token/oracle");
        require(ch.guardian() == c.guardian, "DeployProd: guardian");
        require(!ch.paused(), "DeployProd: paused");
        for (uint8 lane; lane < 8; ++lane) {
            require(!ch.isBackstopOperator(c.deployer, lane), "DeployProd: deployer is an operator");
        }
        require(tl.getMinDelay() == c.minDelay, "DeployProd: timelock delay");
        bytes32 admin = tl.DEFAULT_ADMIN_ROLE();
        require(tl.hasRole(admin, address(tl)), "DeployProd: timelock not self-administered");
        require(!tl.hasRole(admin, c.deployer), "DeployProd: deployer is timelock admin");
        require(!tl.hasRole(tl.PROPOSER_ROLE(), c.deployer), "DeployProd: deployer is proposer");
        require(!tl.hasRole(tl.EXECUTOR_ROLE(), c.deployer), "DeployProd: deployer is executor");
        require(!tl.hasRole(tl.CANCELLER_ROLE(), c.deployer), "DeployProd: deployer is canceller");
        require(!tl.hasRole(tl.EXECUTOR_ROLE(), address(0)), "DeployProd: open executor role");
        require(tl.hasRole(tl.PROPOSER_ROLE(), c.multisig), "DeployProd: multisig not proposer");
        require(tl.hasRole(tl.EXECUTOR_ROLE(), c.multisig), "DeployProd: multisig not executor");
        require(tl.hasRole(tl.CANCELLER_ROLE(), c.multisig), "DeployProd: multisig not canceller");
        require(ch.maxLeverage() == c.maxLeverage && ch.maxDepositPerAccount() == c.maxDeposit, "DeployProd: caps");
        require(ch.maxTvlPerLane() == c.maxTvl, "DeployProd: lane TVL cap");
        for (uint256 i; i < c.keepers.length; ++i) {
            for (uint8 lane; lane < 8; ++lane) {
                require(ch.isBackstopOperator(c.keepers[i], lane) == (lane == i), "DeployProd: keeper operator lanes");
            }
        }
        for (uint256 i; i < 3; ++i) {
            ch.latestPrice(keccak256(bytes(c.symbols[i]))); // feed readable through the contract
        }
    }

    function _log(Cfg memory c, ParaclrClearinghouseProd ch, TimelockController tl) internal pure {
        console2.log("ParaclrClearinghouseProd", address(ch));
        console2.log("TimelockController      ", address(tl));
        console2.log("owner multisig          ", c.multisig);
        console2.log("guardian                ", c.guardian);
        console2.log("AUSD                    ", c.ausd);
        console2.log("Pyth                    ", c.pyth);
        console2.log("deployer (powerless now)", c.deployer);
        console2.log("backstop operators      ", c.keepers.length);
        if (c.laneSeed == 0) {
            console2.log("NOTE: lane insurance is 0, so every OI cap is 0 until lanes are funded (fundLane).");
        }
    }

    // ------------------------------------------------------------------ output

    function _write(
        Cfg memory c,
        ParaclrClearinghouseProd ch,
        TimelockController tl,
        uint256 deployBlock,
        bytes32[3] memory ids
    ) internal {
        string memory mk = "markets";
        string memory fk = "pythFeeds";
        string memory marketsJson;
        string memory feedsJson;
        for (uint256 i; i < 3; ++i) {
            marketsJson = vm.serializeBytes32(mk, c.symbols[i], ids[i]);
            feedsJson = vm.serializeBytes32(fk, c.symbols[i], c.feeds[i]);
        }
        string memory paramsJson = _params(c, ch);
        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeBool(o, "production", true);
        vm.serializeString(o, "contract", "ParaclrClearinghouseProd");
        vm.serializeAddress(o, "clearinghouse", address(ch));
        vm.serializeAddress(o, "ausd", c.ausd);
        vm.serializeAddress(o, "pyth", c.pyth);
        vm.serializeAddress(o, "oracle", c.pyth);
        vm.serializeAddress(o, "timelock", address(tl));
        vm.serializeAddress(o, "owner", c.multisig);
        vm.serializeAddress(o, "guardian", c.guardian);
        vm.serializeAddress(o, "backstopOperators", c.keepers);
        vm.serializeUint(o, "deployBlock", deployBlock);
        vm.serializeUint(o, "deployedAt", block.timestamp);
        vm.serializeString(o, "markets", marketsJson);
        vm.serializeString(o, "pythFeeds", feedsJson);
        string memory json = vm.serializeString(o, "params", paramsJson);
        string memory path = vm.envOr(
            "DEPLOYMENTS_OUT",
            string.concat(vm.projectRoot(), "/../deployments/", vm.toString(block.chainid), ".json")
        );
        vm.writeJson(json, path);
        console2.log("wrote", path);
    }

    /// @dev Read back from the contract (on-chain truth), names as the landing page expects.
    function _params(Cfg memory c, ParaclrClearinghouseProd ch) internal returns (string memory) {
        string memory p = "params";
        vm.serializeUint(p, "maxLeverage", ch.maxLeverage());
        vm.serializeUint(p, "maxDepositPerAccountAusd", ch.maxDepositPerAccount() / 1e6);
        vm.serializeUint(p, "maxTvlPerLaneAusd", ch.maxTvlPerLane() / 1e6);
        vm.serializeUint(p, "maxOiPerLaneMarketAusd", c.maxLaneOi / 1e6); // absolute cap; live cap also <= insurance x multiplier
        vm.serializeUint(p, "oiCapMultiplierBps", ch.oiCapMultiplierBps());
        vm.serializeUint(p, "minPositionSizeAusd", ch.minPositionNotional() / 1e6);
        vm.serializeUint(p, "tradingFeeBps", ch.tradingFeeBps());
        vm.serializeUint(p, "maintenanceMarginBps", ch.MAINTENANCE_MARGIN_BPS());
        vm.serializeUint(p, "liquidationFeeBps", ch.LIQUIDATION_FEE_BPS());
        vm.serializeUint(p, "maxConfBps", ch.maxConfBps());
        vm.serializeString(p, "executionFeeWei", vm.toString(ch.minExecutionFee()));
        vm.serializeUint(p, "minExecDelaySeconds", ch.minExecDelay());
        vm.serializeUint(p, "maxExecDelaySeconds", ch.maxExecDelay());
        vm.serializeUint(p, "maxPriceAgeSeconds", ch.maxPriceAge());
        vm.serializeUint(p, "maxStoredPriceAgeSeconds", ch.maxStoredPriceAge());
        vm.serializeUint(p, "backstopWithdrawDelaySeconds", ch.backstopWithdrawDelay());
        vm.serializeUint(p, "topUpTargetBps", ch.TOP_UP_TARGET_BPS());
        vm.serializeUint(p, "backstopWithdrawWindowSeconds", ch.BACKSTOP_WITHDRAW_WINDOW());
        vm.serializeUint(p, "timelockMinDelaySeconds", c.minDelay);
        vm.serializeUint(p, "fundingIntervalSeconds", ch.fundingUpdateInterval());
        vm.serializeUint(p, "maxFundingBpsPerDay", c.maxFundingBpsPerDay);
        vm.serializeUint(p, "skewScaleAusd", c.skewScale / 1e6);
        vm.serializeUint(p, "auctionStepBps", ch.auctionStepBps());
        vm.serializeUint(p, "auctionMaxDiscountBps", ch.auctionMaxDiscountBps());
        vm.serializeUint(p, "backstopMinDiscountBps", ch.backstopMinDiscountBps(0));
        return vm.serializeUint(p, "laneInsuranceSeedAusd", c.laneSeed / 1e6);
    }
}
