// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythErrors} from "@pythnetwork/pyth-sdk-solidity/PythErrors.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ParaclrClearinghouseProd} from "../../src/prod/ParaclrClearinghouseProd.sol";
import {KeeperSignedPyth} from "../../src/testnet/KeeperSignedPyth.sol";
import {ProdTestBase} from "../prod/ProdTestBase.sol";

/// @notice The TESTNET-only trial-end fallback oracle: signature checks, Pyth parse / storage
///         semantics, governance, and the production clearinghouse running on it after a
///         `setPyth` (the procedure in docs/RUNBOOK.md "Testnet: trial-end fallback").
contract KeeperSignedPythTest is ProdTestBase {
    KeeperSignedPyth internal ksp;
    uint256 internal signerKey = 0x51A9E7;
    address internal signer;
    uint256 internal otherKey = 0xBAD;

    function setUp() public override {
        super.setUp();
        signer = vm.addr(signerKey);
        address[] memory s = new address[](1);
        s[0] = signer;
        ksp = new KeeperSignedPyth(admin, s, 60); // the owner stands in for the timelock here
    }

    // ------------------------------------------------------------------ helpers

    function _kmsgs(uint256 t, uint256 prev) internal view returns (KeeperSignedPyth.Msg[] memory m) {
        m = new KeeperSignedPyth.Msg[](feeds.length);
        for (uint256 i; i < feeds.length; ++i) {
            m[i] = KeeperSignedPyth.Msg(feeds[i], spot[feeds[i]], conf[feeds[i]], EXPO, uint64(t), uint64(prev));
        }
    }

    function _blob(KeeperSignedPyth.Msg[] memory m, uint256 key, KeeperSignedPyth target) internal view returns (bytes memory) {
        bytes32 h = MessageHashUtils.toEthSignedMessageHash(target.digest(m));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, h);
        return abi.encode(ksp.MAGIC(), m, abi.encodePacked(r, s, v));
    }

    function _signed(uint256 t, uint256 prev) internal view returns (bytes[] memory u) {
        u = new bytes[](1);
        u[0] = _blob(_kmsgs(t, prev), signerKey, ksp);
    }

    function _switch() internal {
        ksp.updatePriceFeeds(_signed(block.timestamp, block.timestamp - 1));
        vm.prank(admin);
        ch.setPyth(IPyth(address(ksp)));
        assertEq(address(ch.pyth()), address(ksp));
    }

    // ------------------------------------------------------------------ oracle semantics

    function test_UpdateStoresNewerOnly() public {
        ksp.updatePriceFeeds(_signed(block.timestamp, block.timestamp - 1));
        PythStructs.Price memory p = ksp.getPriceUnsafe(FEED_SOL);
        assertEq(p.price, spot[FEED_SOL]);
        assertEq(p.publishTime, block.timestamp);
        // an older message never overwrites
        _setSpot(FEED_SOL, 1);
        ksp.updatePriceFeeds(_signed(block.timestamp - 5, block.timestamp - 6));
        assertEq(ksp.getPriceUnsafe(FEED_SOL).price, 180e8);
        // far-future messages are ignored by storage
        ksp.updatePriceFeeds(_signed(block.timestamp + 61, block.timestamp + 60));
        assertEq(ksp.getPriceUnsafe(FEED_SOL).publishTime, block.timestamp);
        assertEq(ksp.getUpdateFee(new bytes[](3)), 0);
        vm.expectRevert(PythErrors.PriceFeedNotFound.selector);
        ksp.getPriceUnsafe(bytes32(uint256(1)));
    }

    function test_RejectsForeignSignerChainAndDeployment() public {
        bytes[] memory u = new bytes[](1);
        u[0] = _blob(_kmsgs(block.timestamp, block.timestamp - 1), otherKey, ksp);
        vm.expectRevert(abi.encodeWithSelector(KeeperSignedPyth.UnauthorizedSigner.selector, vm.addr(otherKey)));
        ksp.updatePriceFeeds(u);

        // signed for ANOTHER deployment (same signer): the digest binds address(this)
        address[] memory s = new address[](1);
        s[0] = signer;
        KeeperSignedPyth other = new KeeperSignedPyth(admin, s, 60);
        u[0] = _blob(_kmsgs(block.timestamp, block.timestamp - 1), signerKey, other);
        vm.expectRevert();
        ksp.updatePriceFeeds(u);

        // signed on another chain id: the digest binds block.chainid
        u = _signed(block.timestamp, block.timestamp - 1);
        vm.chainId(143);
        vm.expectRevert();
        ksp.updatePriceFeeds(u);
    }

    function test_RejectsRealPythBlobsTamperingAndFees() public {
        bytes[] memory pnau = _updAll(block.timestamp); // MockPyth / Pyth "PNAU" format
        vm.expectRevert(PythErrors.InvalidUpdateData.selector);
        ksp.updatePriceFeeds(pnau);

        // tamper with the price after signing
        KeeperSignedPyth.Msg[] memory m = _kmsgs(block.timestamp, block.timestamp - 1);
        bytes memory good = _blob(m, signerKey, ksp);
        (, KeeperSignedPyth.Msg[] memory dm, bytes memory sig) = abi.decode(good, (bytes4, KeeperSignedPyth.Msg[], bytes));
        dm[1].price = dm[1].price * 2;
        bytes[] memory u = new bytes[](1);
        u[0] = abi.encode(ksp.MAGIC(), dm, sig);
        vm.expectRevert();
        ksp.updatePriceFeeds(u);

        vm.deal(address(this), 1 ether);
        u = _signed(block.timestamp, block.timestamp - 1); // (built before expectRevert: it calls ksp.digest)
        vm.expectRevert(KeeperSignedPyth.FeeNotAccepted.selector);
        ksp.updatePriceFeeds{value: 1}(u);
    }

    function test_ParseFirstInRangeAndUnique() public {
        uint256 t = block.timestamp;
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = FEED_BTC;
        bytes[] memory two = new bytes[](2);
        two[0] = _signed(t - 2, t - 3)[0];
        two[1] = _signed(t, t - 2)[0];
        // non-unique: the FIRST message in range
        PythStructs.PriceFeed[] memory f = ksp.parsePriceFeedUpdates(two, ids, uint64(t - 2), uint64(t));
        assertEq(f[0].price.publishTime, t - 2);
        // unique with minT = t: the t−2 message is out of range; the t message has prev t−2 < t
        f = ksp.parsePriceFeedUpdatesUnique(two, ids, uint64(t), uint64(t + 5));
        assertEq(f[0].price.publishTime, t);
        // unique with minT = t−1: the t message has prev t−2 < t−1 → ok; a message whose prev ≥ minT is skipped
        bytes[] memory notFirst = new bytes[](1);
        notFirst[0] = _signed(t, t - 1)[0];
        vm.expectRevert(PythErrors.PriceFeedNotFoundWithinRange.selector);
        ksp.parsePriceFeedUpdatesUnique(notFirst, ids, uint64(t - 1), uint64(t + 5));
        // nothing was stored by parsing
        vm.expectRevert(PythErrors.PriceFeedNotFound.selector);
        ksp.getPriceUnsafe(FEED_BTC);
    }

    function test_GovernanceOwnerOnly() public {
        address mallory = makeAddr("mallory");
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, mallory));
        ksp.setSigner(mallory, true);
        vm.prank(admin);
        vm.expectRevert(KeeperSignedPyth.RenounceDisabled.selector);
        ksp.renounceOwnership();
        // cannot remove the last signer
        vm.prank(admin);
        vm.expectRevert(KeeperSignedPyth.InvalidSigner.selector);
        ksp.setSigner(signer, false);
        // rotate: add the new key, then remove the old one; old signatures stop working
        address next = vm.addr(otherKey);
        vm.startPrank(admin);
        ksp.setSigner(next, true);
        ksp.setSigner(signer, false);
        vm.stopPrank();
        assertEq(ksp.signerCount(), 1);
        bytes[] memory u = _signed(block.timestamp, block.timestamp - 1);
        vm.expectRevert(abi.encodeWithSelector(KeeperSignedPyth.UnauthorizedSigner.selector, signer));
        ksp.updatePriceFeeds(u);
    }

    // ------------------------------------------------------------------ the clearinghouse on it

    function test_SetPythRequiresStoredFeeds() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ParaclrClearinghouseProd.FeedNotOnPyth.selector, FEED_MON));
        ch.setPyth(IPyth(address(ksp)));
        _switch();
    }

    function test_ClearinghouseTradesOnSignedPrices() public {
        _switch();
        address trader = laneAddr(3, 1);
        fund(trader, 1_000e6);
        // open: the fill is the FIRST signed message at/after execAfter (unique parse)
        uint256 id = _commit(trader, SOL, int256(_sizeFor(500e6, SOL)), 100e6, type(uint128).max);
        ParaclrClearinghouseProd.Order memory o = ch.getOrder(id);
        vm.warp(o.execAfter + 1);
        ksp.updatePriceFeeds(_signed(block.timestamp, block.timestamp - 1)); // stored prices fresh for other reads
        bytes[] memory fill = _signed(o.execAfter, o.execAfter - 1);
        vm.prank(keeper);
        ch.executeOrder(id, fill);
        assertEq(uint8(ch.getOrder(id).status), uint8(ParaclrClearinghouseProd.OrderStatus.Executed));
        assertGt(ch.getPosition(trader, SOL).size, 0);

        // a forged (other-key) fill is refused outright
        uint256 id2 = _commit(trader, SOL, int256(_sizeFor(100e6, SOL)), 20e6, type(uint128).max);
        o = ch.getOrder(id2);
        vm.warp(o.execAfter + 1);
        bytes[] memory forged = new bytes[](1);
        forged[0] = _blob(_kmsgs(o.execAfter, o.execAfter - 1), otherKey, ksp);
        vm.prank(keeper);
        vm.expectRevert();
        ch.executeOrder(id2, forged);

        // withdraw with a signed update (the app's /hermes path); the fee is 0
        vm.warp(block.timestamp + 30);
        bytes[] memory now_ = _signed(block.timestamp, block.timestamp - 1);
        vm.prank(trader);
        ch.withdraw(10e6, now_);
    }
}
