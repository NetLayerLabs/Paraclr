// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import {PythErrors} from "@pythnetwork/pyth-sdk-solidity/PythErrors.sol";

/// @title MockPyth (TEST ONLY — lives under contracts/test/, never deployed)
/// @notice Mirrors the semantics of the Pyth Core contract deployed on Monad mainnet
///         (0x2880aB155794e7179c9eE2e38200202908C17B43, `version()` "1.4.6"), checked against
///         Pyth.sol at that version and by replaying a real mainnet payload with `eth_call`:
///         - an update blob carries N price messages, each with `publishTime` and the feed's
///           previous publish time `prevPublishTime`;
///         - `parsePriceFeedUpdates*` iterate blobs in order and fill each requested id with the
///           FIRST message in [minPublishTime, maxPublishTime]; the `Unique` variant additionally
///           requires `prevPublishTime < minPublishTime`; a missing id reverts
///           `PriceFeedNotFoundWithinRange`; nothing is stored;
///         - fee = singleUpdateFeeInWei × (number of messages) + transactionFeeInWei; parse reverts
///           `InsufficientFee` if msg.value is lower and keeps any excess (no refund);
///         - `getPriceUnsafe` reverts `PriceFeedNotFound` for a feed never stored.
///         Blobs are `abi.encode(MAGIC, Msg[])` instead of signed Wormhole/accumulator data.
contract MockPyth {
    bytes4 public constant MAGIC = 0x504e4155; // "PNAU", the accumulator magic

    struct Msg {
        bytes32 id;
        int64 price;
        uint64 conf;
        int32 expo;
        uint64 publishTime;
        uint64 prevPublishTime;
    }

    uint256 public singleUpdateFeeInWei;
    uint256 public transactionFeeInWei;
    mapping(bytes32 => PythStructs.Price) internal _latest;

    function setFees(uint256 single, uint256 perTx) external {
        singleUpdateFeeInWei = single;
        transactionFeeInWei = perTx;
    }

    /// @notice Test helper: write the "on-chain stored" price of a feed directly.
    function setStoredPrice(bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime) external {
        _latest[id] = PythStructs.Price(price, conf, expo, publishTime);
    }

    function encode(Msg[] memory msgs) public pure returns (bytes memory) {
        return abi.encode(MAGIC, msgs);
    }

    function version() external pure returns (string memory) {
        return "mock-1.4.6";
    }

    function priceFeedExists(bytes32 id) external view returns (bool) {
        return _latest[id].publishTime != 0;
    }

    function getPriceUnsafe(bytes32 id) external view returns (PythStructs.Price memory p) {
        p = _latest[id];
        if (p.publishTime == 0) revert PythErrors.PriceFeedNotFound();
    }

    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (PythStructs.Price memory p) {
        p = _latest[id];
        if (p.publishTime == 0) revert PythErrors.PriceFeedNotFound();
        if (block.timestamp > p.publishTime + age) revert PythErrors.StalePrice();
    }

    function getValidTimePeriod() external pure returns (uint256) {
        return 60;
    }

    function getUpdateFee(bytes[] calldata updateData) public view returns (uint256) {
        uint256 n;
        for (uint256 i; i < updateData.length; ++i) {
            n += _decode(updateData[i]).length;
        }
        return n * singleUpdateFeeInWei + transactionFeeInWei;
    }

    function updatePriceFeeds(bytes[] calldata updateData) external payable {
        if (msg.value < getUpdateFee(updateData)) revert PythErrors.InsufficientFee();
        for (uint256 i; i < updateData.length; ++i) {
            Msg[] memory msgs = _decode(updateData[i]);
            for (uint256 j; j < msgs.length; ++j) {
                Msg memory m = msgs[j];
                if (m.publishTime > _latest[m.id].publishTime) {
                    _latest[m.id] = PythStructs.Price(m.price, m.conf, m.expo, m.publishTime);
                }
            }
        }
    }

    function parsePriceFeedUpdates(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable returns (PythStructs.PriceFeed[] memory) {
        return _parse(updateData, priceIds, minPublishTime, maxPublishTime, false);
    }

    function parsePriceFeedUpdatesUnique(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable returns (PythStructs.PriceFeed[] memory) {
        return _parse(updateData, priceIds, minPublishTime, maxPublishTime, true);
    }

    function _parse(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minT,
        uint64 maxT,
        bool unique
    ) internal returns (PythStructs.PriceFeed[] memory feeds) {
        if (msg.value < getUpdateFee(updateData)) revert PythErrors.InsufficientFee();
        feeds = new PythStructs.PriceFeed[](priceIds.length);
        for (uint256 i; i < updateData.length; ++i) {
            Msg[] memory msgs = _decode(updateData[i]);
            for (uint256 j; j < msgs.length; ++j) {
                Msg memory m = msgs[j];
                uint256 k;
                for (; k < priceIds.length; ++k) {
                    if (priceIds[k] == m.id) break;
                }
                if (k == priceIds.length || feeds[k].id != 0) continue;
                if (m.publishTime < minT || m.publishTime > maxT) continue;
                if (unique && minT <= m.prevPublishTime) continue;
                feeds[k].id = m.id;
                feeds[k].price = PythStructs.Price(m.price, m.conf, m.expo, m.publishTime);
                feeds[k].emaPrice = PythStructs.Price(m.price, m.conf, m.expo, m.publishTime);
            }
        }
        for (uint256 k; k < priceIds.length; ++k) {
            if (feeds[k].id == 0) revert PythErrors.PriceFeedNotFoundWithinRange();
        }
        _afterParse();
    }

    /// @dev Hook for the reentrancy test (see `ReentrantPyth`).
    function _afterParse() internal virtual {}

    function _decode(bytes calldata blob) internal pure returns (Msg[] memory msgs) {
        if (blob.length <= 4) revert PythErrors.InvalidUpdateData();
        bytes4 magic;
        (magic, msgs) = abi.decode(blob, (bytes4, Msg[]));
        if (magic != MAGIC) revert PythErrors.InvalidUpdateData();
    }
}

/// @notice TEST ONLY: a Pyth that re-enters a target during a parse (reentrancy test).
contract ReentrantPyth is MockPyth {
    address public target;
    bytes public payload;
    bool public reentered;
    bytes public reentryError;

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function _afterParse() internal override {
        if (target == address(0)) return;
        address t = target;
        target = address(0);
        (bool ok, bytes memory ret) = t.call(payload);
        reentered = ok;
        reentryError = ret;
    }
}
