// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import {PythErrors} from "@pythnetwork/pyth-sdk-solidity/PythErrors.sol";

/// @title KeeperSignedPyth — TESTNET ONLY trial-end fallback oracle
/// @notice A price oracle with the slice of the Pyth `IPyth` interface ParaclrClearinghouseProd and
///         its keeper use, fed by prices the Paraclr keeper SIGNS off chain. It exists so the Monad
///         TESTNET demo keeps working after the Pyth API trial ends (docs/TESTNET_PLAN.md, "Trial-end
///         fallback"): the clearinghouse is pointed at it with a timelocked `setPyth`, and the app /
///         landing label prices "simulated after the Pyth trial".
///
///         NOT FOR MAINNET. Prices here are only as honest as the signer key: nothing like Pyth's
///         Wormhole-guardian attestation backs them. The keeper refuses a keeper-signed oracle on
///         mainnet (keeper/src/prod/deployment.ts).
///
/// Semantics mirror Pyth Core 1.4.6 as the clearinghouse relies on it (and as the test MockPyth
/// models it, contracts/test/prod/mocks/MockPyth.sol):
///   - an update blob carries N price messages, each with `publishTime` and the feed's previous
///     publish time `prevPublishTime` (the signer chains its messages per feed);
///   - `parsePriceFeedUpdates*` iterate blobs in order and fill each requested id with the FIRST
///     message in [minPublishTime, maxPublishTime]; the `Unique` variant also requires
///     `prevPublishTime < minPublishTime`; a missing id reverts `PriceFeedNotFoundWithinRange`;
///     nothing is stored;
///   - `updatePriceFeeds` stores a message only if newer than the stored one;
///   - `getPriceUnsafe` reverts `PriceFeedNotFound` for a feed never stored.
/// Differences: the update fee is always 0 (any msg.value is refused, so no MON can get stuck);
/// every blob is `abi.encode(bytes4 MAGIC, Msg[] msgs, bytes signature)` where `signature` is an
/// EIP-191 signature by an allowed signer over `digest(msgs)`, which binds the chain id and this
/// contract's address (no cross-chain / cross-deployment replay); storage ignores messages more
/// than MAX_FUTURE_SKEW in the future.
///
/// Governance: the owner is the Paraclr TimelockController (owner multisig behind the timelock);
/// it alone adds or removes signers. Renouncing ownership is disabled. A compromised signer can
/// post arbitrary prices until the timelock removes it: the guardian's `pause()` on the
/// clearinghouse contains new risk in the meantime.
contract KeeperSignedPyth is Ownable {
    /// @notice "PKS1": the blob magic.
    bytes4 public constant MAGIC = 0x504b5331;
    /// @notice Domain tag of the signed digest.
    bytes32 public constant DOMAIN_TAG = keccak256("Paraclr.KeeperSignedPyth.v1");
    /// @notice Storage ignores messages published further than this in the future.
    uint256 public constant MAX_FUTURE_SKEW = 60;
    /// @notice Messages per blob (the clearinghouse lists at most 8 markets).
    uint256 public constant MAX_MESSAGES = 16;

    struct Msg {
        bytes32 id;
        int64 price;
        uint64 conf;
        int32 expo;
        uint64 publishTime;
        uint64 prevPublishTime;
    }

    mapping(address => bool) public isSigner;
    uint256 public signerCount;
    /// @notice `getValidTimePeriod()` / `getPrice()` staleness bound (s), like Pyth's.
    uint256 public validTimePeriod;
    mapping(bytes32 => PythStructs.Price) internal _latest;

    event SignerSet(address indexed signer, bool allowed);
    event ValidTimePeriodSet(uint256 seconds_);
    /// @dev Same signature as Pyth's event, so existing tooling (cadence measurement) reads it.
    event PriceFeedUpdate(bytes32 indexed id, uint64 publishTime, int64 price, uint64 conf);

    error UnauthorizedSigner(address recovered);
    error FeeNotAccepted();
    error TooManyMessages();
    error InvalidSigner();
    error RenounceDisabled();

    constructor(address owner_, address[] memory signers_, uint256 validTimePeriod_) Ownable(owner_) {
        if (signers_.length == 0) revert InvalidSigner();
        for (uint256 i; i < signers_.length; ++i) {
            _setSigner(signers_[i], true);
        }
        validTimePeriod = validTimePeriod_ == 0 ? 60 : validTimePeriod_;
        emit ValidTimePeriodSet(validTimePeriod);
    }

    // ------------------------------------------------------------------ admin (timelock)

    function setSigner(address signer, bool allowed) external onlyOwner {
        _setSigner(signer, allowed);
        if (signerCount == 0) revert InvalidSigner(); // never leave the oracle without a signer
    }

    function setValidTimePeriod(uint256 seconds_) external onlyOwner {
        if (seconds_ == 0) revert PythErrors.InvalidArgument();
        validTimePeriod = seconds_;
        emit ValidTimePeriodSet(seconds_);
    }

    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    function _setSigner(address signer, bool allowed) internal {
        if (signer == address(0)) revert InvalidSigner();
        if (isSigner[signer] == allowed) return;
        isSigner[signer] = allowed;
        if (allowed) ++signerCount;
        else --signerCount;
        emit SignerSet(signer, allowed);
    }

    // ------------------------------------------------------------------ IPyth subset

    function version() external pure returns (string memory) {
        return "paraclr-keeper-signed-1 (TESTNET ONLY)";
    }

    function getUpdateFee(bytes[] calldata) external pure returns (uint256) {
        return 0;
    }

    function getValidTimePeriod() external view returns (uint256) {
        return validTimePeriod;
    }

    function priceFeedExists(bytes32 id) external view returns (bool) {
        return _latest[id].publishTime != 0;
    }

    function getPriceUnsafe(bytes32 id) public view returns (PythStructs.Price memory p) {
        p = _latest[id];
        if (p.publishTime == 0) revert PythErrors.PriceFeedNotFound();
    }

    function getPriceNoOlderThan(bytes32 id, uint256 age) public view returns (PythStructs.Price memory p) {
        p = getPriceUnsafe(id);
        if (block.timestamp > p.publishTime + age) revert PythErrors.StalePrice();
    }

    function getPrice(bytes32 id) external view returns (PythStructs.Price memory) {
        return getPriceNoOlderThan(id, validTimePeriod);
    }

    /// @dev The signer keeps no EMA: the EMA getters return the spot price.
    function getEmaPriceUnsafe(bytes32 id) external view returns (PythStructs.Price memory) {
        return getPriceUnsafe(id);
    }

    function updatePriceFeeds(bytes[] calldata updateData) external payable {
        if (msg.value != 0) revert FeeNotAccepted();
        uint256 horizon = block.timestamp + MAX_FUTURE_SKEW;
        for (uint256 i; i < updateData.length; ++i) {
            Msg[] memory msgs = _decode(updateData[i]);
            for (uint256 j; j < msgs.length; ++j) {
                Msg memory m = msgs[j];
                if (m.publishTime > horizon) continue;
                if (m.publishTime > _latest[m.id].publishTime) {
                    _latest[m.id] = PythStructs.Price(m.price, m.conf, m.expo, m.publishTime);
                    emit PriceFeedUpdate(m.id, m.publishTime, m.price, m.conf);
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

    /// @notice What the signer signs (EIP-191 `personal_sign` of these 32 bytes).
    function digest(Msg[] memory msgs) public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TAG, block.chainid, address(this), msgs));
    }

    // ------------------------------------------------------------------ internals

    function _parse(bytes[] calldata updateData, bytes32[] calldata priceIds, uint64 minT, uint64 maxT, bool unique)
        internal
        returns (PythStructs.PriceFeed[] memory feeds)
    {
        if (msg.value != 0) revert FeeNotAccepted();
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
                PythStructs.Price memory p = PythStructs.Price(m.price, m.conf, m.expo, m.publishTime);
                feeds[k] = PythStructs.PriceFeed(m.id, p, p);
            }
        }
        for (uint256 k; k < priceIds.length; ++k) {
            if (feeds[k].id == 0) revert PythErrors.PriceFeedNotFoundWithinRange();
        }
    }

    function _decode(bytes calldata blob) internal view returns (Msg[] memory msgs) {
        // A real Pyth blob ("PNAU") or anything else fails here, before any decoding.
        if (blob.length <= 4 || bytes4(blob[:4]) != MAGIC) revert PythErrors.InvalidUpdateData();
        bytes memory sig;
        (, msgs, sig) = abi.decode(blob, (bytes4, Msg[], bytes));
        if (msgs.length == 0) revert PythErrors.InvalidUpdateData();
        if (msgs.length > MAX_MESSAGES) revert TooManyMessages();
        address signer = ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(digest(msgs)), sig);
        if (!isSigner[signer]) revert UnauthorizedSigner(signer);
    }
}
