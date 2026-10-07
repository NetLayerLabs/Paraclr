// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {MockAUSD} from "../../src/MockAUSD.sol";
import {ParaclrClearinghouseProd as CH} from "../../src/prod/ParaclrClearinghouseProd.sol";
import {ParaclrClearinghouseProd} from "../../src/prod/ParaclrClearinghouseProd.sol";
import {DeployProd} from "../../script/DeployProd.s.sol";
import {MockPyth} from "./mocks/MockPyth.sol";

/// @dev Exposes the script's internals that only run on a real broadcast (the JSON writer) or
///      have no other observable effect (per-network defaults, the market list).
contract DeployProdHarness is DeployProd {
    function defaultAusd(uint256 chainId) external pure returns (address) {
        return _defaultAusd(chainId);
    }

    function markets() external view returns (string[] memory symbols, bytes32[] memory feeds) {
        return _markets();
    }

    function writeFor(ParaclrClearinghouseProd ch, TimelockController tl) external {
        Cfg memory c = _load();
        bytes32[] memory ids = new bytes32[](c.symbols.length);
        for (uint256 i; i < ids.length; ++i) {
            ids[i] = keccak256(bytes(c.symbols[i]));
        }
        _write(c, ch, tl, block.number, ids);
    }
}

/// @notice Runs script/DeployProd.s.sol against MockAUSD + MockPyth (local chain id) and checks the
///         wiring it promises: caps from env, roles, ownership with the timelock, deployer
///         powerless, and the pre-deploy checks that refuse a bad environment.
contract DeployProdTest is Test {
    MockAUSD internal ausd;
    MockPyth internal pyth;
    uint256 internal deployerKey = 0xA11CE;
    address internal deployer = vm.addr(0xA11CE);
    address internal multisig = makeAddr("multisig");
    address internal guardian = makeAddr("guardian");
    address internal k0 = makeAddr("keeper0");
    address internal k1 = makeAddr("keeper1");

    bytes32 internal constant FEED_MON = 0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1;
    bytes32 internal constant FEED_SOL = 0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d;
    bytes32 internal constant FEED_BTC = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;

    function setUp() public {
        vm.warp(1_800_000_000);
        ausd = new MockAUSD(address(this));
        ausd.ownerMint(deployer, 1_000e6);
        pyth = new MockPyth();
        pyth.setStoredPrice(FEED_MON, 3e8, 3e4, -8, block.timestamp);
        pyth.setStoredPrice(FEED_SOL, 180e8, 180e4, -8, block.timestamp);
        pyth.setStoredPrice(FEED_BTC, 100_000e8, 100_000e4, -8, block.timestamp);
        vm.deal(deployer, 100 ether);
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(deployerKey));
        vm.setEnv("OWNER_MULTISIG_ADDRESS", vm.toString(multisig));
        vm.setEnv("TIMELOCK_MIN_DELAY_SECONDS", "86400");
        vm.setEnv("GUARDIAN_ADDRESS", vm.toString(guardian));
        vm.setEnv("KEEPER_ADDRESSES", string.concat(vm.toString(k0), ",", vm.toString(k1)));
        vm.setEnv("MAX_DEPOSIT_PER_ACCOUNT_AUSD", "50");
        vm.setEnv("MAX_TVL_PER_LANE_AUSD", "500");
        vm.setEnv("MAX_LEVERAGE", "10");
        vm.setEnv("AUSD_ADDRESS", vm.toString(address(ausd)));
        vm.setEnv("PYTH_ADDRESS", vm.toString(address(pyth)));
        vm.setEnv("CHAIN_ID", vm.toString(block.chainid));
        vm.setEnv("LANE_INSURANCE_SEED_AUSD", "100");
        vm.etch(multisig, hex"00"); // the owner is a contract (Safe) unless OWNER_IS_EOA=true
        vm.setEnv("OWNER_IS_EOA", "false");
    }

    function _wiresEverything() internal {
        (CH ch, TimelockController tl) = _script().run();
        assertEq(ch.owner(), address(tl));
        assertEq(ch.guardian(), guardian);
        assertEq(address(ch.ausd()), address(ausd));
        assertEq(address(ch.pyth()), address(pyth));
        assertEq(ch.maxDepositPerAccount(), 50e6);
        assertEq(ch.maxTvlPerLane(), 500e6);
        assertEq(ch.maxLeverage(), 10);
        // keeper i operates lane i's pool only (I-7)
        assertTrue(ch.isBackstopOperator(k0, 0) && ch.isBackstopOperator(k1, 1));
        assertFalse(ch.isBackstopOperator(k0, 1) || ch.isBackstopOperator(k1, 0) || ch.isBackstopOperator(k0, 7));
        assertFalse(ch.isBackstopOperator(deployer, 0));
        assertEq(ch.maxStoredPriceAge(), 15);
        assertEq(ch.maxPriceAge(), 30);
        assertEq(ch.backstopWithdrawDelay(), 3_600);
        assertEq(ch.minExecDelay(), 3);
        assertEq(tl.getMinDelay(), 86_400);
        assertTrue(tl.hasRole(tl.PROPOSER_ROLE(), multisig));
        assertTrue(tl.hasRole(tl.EXECUTOR_ROLE(), multisig));
        assertFalse(tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), deployer));
        (bytes32[] memory ids,, bytes32[] memory feeds) = ch.getMarkets();
        assertEq(ids.length, 3);
        assertEq(ids[0], keccak256("MON/AUSD"));
        assertEq(feeds[0], FEED_MON);
        assertEq(feeds[2], FEED_BTC);
        (uint256 ins,,,,) = ch.getLane(7);
        assertEq(ins, 100e6, "lane insurance seeded");
        // the deployer can no longer change anything
        vm.startPrank(deployer);
        vm.expectRevert();
        ch.setCaps(1, 1, 1);
        vm.expectRevert();
        ch.pause();
        vm.expectRevert();
        ch.transferOwnership(deployer);
        vm.stopPrank();
        // the guardian can pause
        vm.prank(guardian);
        ch.pause();
        assertTrue(ch.paused());
    }

    /// @dev One test function on purpose: vm.setEnv is process-wide and tests run in parallel.
    function test_DeployProd_EndToEnd() public {
        _wiresEverything();
        _refusesBadEnvironment();
        _testnetShape();
        _marketListRules();
    }

    /// @dev Monad testnet (docs/TESTNET_PLAN.md): PROD_MARKETS=SOL/AUSD,BTC/AUSD, a 600 s timelock
    ///      (ALLOW_SHORT_TIMELOCK), DEPLOY_NETWORK=monad-testnet written into the JSON, and the
    ///      testnet AUSD as the per-network default. Mainnet defaults are untouched (above).
    function _testnetShape() internal {
        vm.setEnv("LANE_INSURANCE_SEED_AUSD", "0");
        vm.setEnv("KEEPER_ADDRESSES", string.concat(vm.toString(k0), ",", vm.toString(k1)));
        vm.setEnv("PROD_MARKETS", "SOL/AUSD,BTC/AUSD");
        vm.setEnv("DEPLOY_NETWORK", "monad-testnet");
        vm.setEnv("TIMELOCK_MIN_DELAY_SECONDS", "600");
        vm.setEnv("ALLOW_SHORT_TIMELOCK", "true");
        // MON's stored price is stale on purpose: an unlisted feed must not matter
        pyth.setStoredPrice(FEED_MON, 3e8, 3e4, -8, block.timestamp - 8 days);
        (CH ch, TimelockController tl) = _script().run();
        (bytes32[] memory ids, string[] memory symbols, bytes32[] memory feeds) = ch.getMarkets();
        assertEq(ids.length, 2, "only SOL + BTC listed");
        assertEq(symbols[0], "SOL/AUSD");
        assertEq(ids[0], keccak256("SOL/AUSD"));
        assertEq(feeds[0], FEED_SOL);
        assertEq(symbols[1], "BTC/AUSD");
        assertEq(feeds[1], FEED_BTC);
        assertEq(tl.getMinDelay(), 600);
        assertEq(ch.owner(), address(tl));

        // the JSON writer (runs only on a real broadcast): "network" + only the listed markets
        DeployProdHarness h = _harness();
        string memory out = string.concat(vm.projectRoot(), "/cache/deployprod-test-10143.json");
        vm.setEnv("DEPLOYMENTS_OUT", out);
        h.writeFor(ParaclrClearinghouseProd(payable(address(ch))), tl);
        string memory json = vm.readFile(out);
        assertEq(vm.parseJsonString(json, ".network"), "monad-testnet");
        assertTrue(vm.parseJsonBool(json, ".production"));
        string[] memory keys = vm.parseJsonKeys(json, ".markets");
        assertEq(keys.length, 2);
        string[] memory feedKeys = vm.parseJsonKeys(json, ".pythFeeds");
        assertEq(feedKeys.length, 2);
        assertEq(vm.parseJsonUint(json, ".params.timelockMinDelaySeconds"), 600);
        vm.removeFile(out);

        // per-network AUSD default (AUSD_ADDRESS unset): testnet token on 10143, mainnet's elsewhere
        assertEq(h.defaultAusd(10143), 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC);
        assertEq(h.defaultAusd(143), 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a);

        // a 599 s timelock is still "short": refused without ALLOW_SHORT_TIMELOCK
        vm.setEnv("ALLOW_SHORT_TIMELOCK", "false");
        DeployProd s = _script();
        vm.expectRevert(bytes("DeployProd: timelock delay < 1 hour"));
        s.run();
        vm.setEnv("TIMELOCK_MIN_DELAY_SECONDS", "86400");
        vm.setEnv("DEPLOY_NETWORK", "");
        pyth.setStoredPrice(FEED_MON, 3e8, 3e4, -8, block.timestamp);
    }

    /// @dev The script, deployed from its artifact (`new DeployProd()` would embed its ~98 KB
    ///      initcode, clearinghouse included, in this test contract and exceed the code-size limit).
    function _script() internal returns (DeployProd) {
        return DeployProd(vm.deployCode("DeployProd.s.sol:DeployProd"));
    }

    /// @dev Deployed from its artifact: embedding a second copy of the 51 KB clearinghouse initcode
    ///      (`new DeployProdHarness()`) would push this test contract over the code-size limit.
    function _harness() internal returns (DeployProdHarness) {
        return DeployProdHarness(vm.deployCode("DeployProd.t.sol:DeployProdHarness"));
    }

    function _marketListRules() internal {
        DeployProdHarness h = _harness();
        // explicit feed ids, whitespace tolerated
        vm.setEnv("PROD_MARKETS", string.concat(" BTC/AUSD , ETH/AUSD=", vm.toString(bytes32(uint256(0xE7)))));
        (string[] memory sy, bytes32[] memory fe) = h.markets();
        assertEq(sy.length, 2);
        assertEq(sy[0], "BTC/AUSD");
        assertEq(fe[0], FEED_BTC);
        assertEq(sy[1], "ETH/AUSD");
        assertEq(fe[1], bytes32(uint256(0xE7)));
        vm.setEnv("PROD_MARKETS", "DOGE/AUSD");
        vm.expectRevert(bytes("DeployProd: unknown market symbol (write SYM=0x<feed id>)"));
        h.markets();
        vm.setEnv("PROD_MARKETS", "SOL/AUSD,SOL/AUSD");
        vm.expectRevert(bytes("DeployProd: duplicate market"));
        h.markets();
        vm.setEnv("PROD_MARKETS", "MON/AUSD,SOL/AUSD,BTC/AUSD");
        (sy,) = h.markets();
        assertEq(sy.length, 3);
    }

    function _refusesBadEnvironment() internal {
        DeployProd s = _script();
        vm.setEnv("LANE_INSURANCE_SEED_AUSD", "0");
        vm.setEnv("CHAIN_ID", "143");
        if (block.chainid != 143) {
            vm.expectRevert(bytes("DeployProd: wrong chain (CHAIN_ID)"));
            s.run();
        }
        vm.setEnv("CHAIN_ID", vm.toString(block.chainid));

        vm.setEnv("TIMELOCK_MIN_DELAY_SECONDS", "60");
        vm.expectRevert(bytes("DeployProd: timelock delay < 1 hour"));
        s.run();
        vm.setEnv("TIMELOCK_MIN_DELAY_SECONDS", "86400");

        vm.setEnv("GUARDIAN_ADDRESS", vm.toString(deployer));
        vm.expectRevert(bytes("DeployProd: guardian must be its own key"));
        s.run();
        vm.setEnv("GUARDIAN_ADDRESS", vm.toString(guardian));

        vm.setEnv("OWNER_MULTISIG_ADDRESS", vm.toString(deployer));
        vm.expectRevert(bytes("DeployProd: owner multisig must not be the deployer"));
        s.run();
        vm.setEnv("OWNER_MULTISIG_ADDRESS", vm.toString(multisig));

        // stale feed on this chain
        pyth.setStoredPrice(FEED_SOL, 180e8, 180e4, -8, block.timestamp - 3_601);
        vm.expectRevert(bytes("DeployProd: feed not pushed recently"));
        s.run();
        pyth.setStoredPrice(FEED_SOL, 180e8, 180e4, -8, block.timestamp);

        // wrong token decimals / no code
        vm.setEnv("AUSD_ADDRESS", vm.toString(address(pyth)));
        vm.expectRevert();
        s.run();
        vm.setEnv("AUSD_ADDRESS", vm.toString(makeAddr("nothing")));
        vm.expectRevert(bytes("DeployProd: AUSD has no code"));
        s.run();
        vm.setEnv("AUSD_ADDRESS", vm.toString(address(ausd)));

        // unknown feed id
        vm.setEnv("PYTH_FEED_BTC_USD", vm.toString(bytes32(uint256(7))));
        vm.expectRevert();
        s.run();
        vm.setEnv("PYTH_FEED_BTC_USD", vm.toString(FEED_BTC));

        // the owner must be a contract unless OWNER_IS_EOA=true
        address eoaOwner = makeAddr("hardwareWallet");
        vm.setEnv("OWNER_MULTISIG_ADDRESS", vm.toString(eoaOwner));
        vm.expectRevert(bytes("DeployProd: owner multisig has no code (set OWNER_IS_EOA=true for a hardware wallet)"));
        s.run();
        vm.setEnv("OWNER_MULTISIG_ADDRESS", vm.toString(multisig));

        // keepers must not reuse the guardian / multisig key, nor repeat
        vm.setEnv("KEEPER_ADDRESSES", string.concat(vm.toString(k0), ",", vm.toString(guardian)));
        vm.expectRevert(bytes("DeployProd: keeper reuses a role key"));
        s.run();
        vm.setEnv("KEEPER_ADDRESSES", string.concat(vm.toString(k0), ",", vm.toString(k0)));
        vm.expectRevert(bytes("DeployProd: duplicate keeper"));
        s.run();
        vm.setEnv("KEEPER_ADDRESSES", string.concat(vm.toString(k0), ",", vm.toString(k1)));

        // seed larger than the deployer's AUSD
        vm.setEnv("LANE_INSURANCE_SEED_AUSD", "1000");
        vm.expectRevert(bytes("DeployProd: deployer lacks AUSD seed"));
        s.run();
    }
}
