// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {Owned} from "./utils/Owned.sol";

/// @title ParaclrClearinghouse
/// @notice Cross-margin perpetual clearinghouse for Monad with fair, auction-priced liquidations.
///         Agora AUSD (6 decimals) is the sole collateral AND quote asset: every position is
///         margined, marked, and settled in AUSD.
///
/// ## Why this contract is laid out the way it is: parallel execution on Monad
///
/// Monad executes transactions optimistically in parallel and then re-executes any transaction
/// whose storage READ set overlaps an earlier transaction's WRITE set. Throughput therefore
/// depends on how often transactions write the same storage slots. A textbook clearinghouse has
/// several "hot" global slots that every trade and every liquidation writes (insurance fund,
/// bad debt, open interest, a reentrancy lock, a keeper reward pool, a backstop vault). Any one
/// of those turns the whole system into a single sequential queue.
///
/// Paraclr shards all mutable risk state into `LANE_COUNT` (= 8) lanes:
///
///   lane(account) = uint160(account) % 8
///
///   - Account, position and auction state is keyed by account: disjoint per account.
///   - Every per-lane AGGREGATE lives once per lane key: insurance fund + bad debt (`_lanes`),
///     open interest (`_laneOI`), the solvency ledger (`_ledgers`), keeper rewards owed
///     (`_keeperLaneRewards`), the backstop pool (`_pools`), the auction list and counters.
///   - The reentrancy guard uses EIP-1153 transient storage (no cross-tx conflicts).
///   - Global configuration (oracle, markets, maxPriceAge, auction params) is only READ on the
///     hot path; concurrent reads never conflict.
///
/// Every aggregate is reached through ONE set of storage getters (`_laneStore`, `_ledgerStore`,
/// `_oiStore`, `_poolStore`, `_auctionListStore`, `_countersStore`, and
/// `_keeperLaneRewards[keeper][_k(lane)]`) that map a lane to its storage key `_k(lane)`. With `sharedState == false` (Paraclr) the key is the
/// lane. With `sharedState == true` (the naive baseline, `NaiveClearinghouseDemo`) every lane maps
/// to key 0, i.e. one global aggregate, which is what a textbook clearinghouse does. The logic is
/// byte-for-byte the same; only the storage keying differs, so the Conflict X-ray compares like
/// with like.
///
/// ## Fair liquidation (per-block Dutch auction)
///
///   1. `startAuctions(lane, accounts)`: an account with equity < maintenance margin enters an
///      auction at `startBlock = block.number`. It is frozen (no withdraw / open / close;
///      deposits allowed).
///   2. Discount clock: `discountBps = min(auctionMaxDiscountBps, auctionStepBps × blocks)`.
///   3. Take at discount d: the taker inherits every leg at the current mark (taker entry =
///      mark). `P = d × notional`. Trader equity E (collateral + PnL at mark) pays first; the
///      trader keeps `max(0, E − P)` as free collateral and never loses more than E.
///      - Lane backstop pool (`backstopTakeBatch`, only once d ≥ pool.minDiscountBps — default
///        75 bps, below the 1% legacy penalty — and the pool stays above `BACKSTOP_MARGIN_BPS`
///        after inheriting) is paid the full P: if E < P the
///        lane pays the shortfall `P − E` (insurance first, then recorded lane bad debt). The
///        subsidy goes to the lane's LP pool only.
///      - External taker (`take`: a registered same-lane account that stays above initial
///        margin) is paid `min(P, max(E, 0))`, i.e. ONLY from the trader's own equity. The lane
///        never subsidizes an arbitrary address (otherwise one party controlling a bankrupt
///        account and a same-lane taker could pull `P − E` out of the lane fund). If E < 0 the
///        external taker is paid 0 and the lane covers only the negative equity, exactly as
///        every other resolution path (pool take, expiry, legacy liquidation) does.
///   4. Cure: `cancelAuction(account)` once the account is healthy again.
///   5. Expiry: at max discount with no taker, `expireBatch` closes the account against the lane
///      through the legacy liquidation path (1% penalty, half to the caller, negative equity
///      written off against the lane).
///
/// ## Counterparty model (hackathon scope)
///   Each lane's insurance fund is the counterparty for every position in that lane (traders,
///   external takers and the lane backstop pool). Losses flow in, profits are paid out;
///   shortfalls are recorded as lane bad debt and repaid first by any later inflow.
///
/// ## Solvency identity (tested by Foundry invariant tests, exposed by `solvency()`)
///
///   AUSD.balanceOf(this) == Σ_keys ( ledger.collateral        // Σ trader collateral (signed)
///                                  + lane.insuranceFund
///                                  + pool.cash               // backstop pool cash (signed)
///                                  + ledger.keeperRewards    // keeper rewards owed
///                                  − lane.badDebt )
///
///   Trading, auctions, pool takes/reductions and liquidations only move value BETWEEN these
///   ledger entries; AUSD only enters/leaves through deposit/withdraw, fundLane,
///   backstopDeposit/backstopWithdraw, claimKeeperRewards (and demo seeding), each of which
///   moves the matching ledger entry by exactly the transferred amount.
contract ParaclrClearinghouse is Owned {
    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @notice Number of conflict-free risk lanes.
    uint8 public constant LANE_COUNT = 8;
    uint256 public constant MAX_LEVERAGE = 20;
    /// @notice Maintenance margin requirement: 2.5% of current notional.
    uint256 public constant MAINTENANCE_MARGIN_BPS = 250;
    /// @notice Legacy liquidation / auction-expiry penalty: 1% of notional, capped at equity.
    uint256 public constant LIQUIDATION_FEE_BPS = 100;
    /// @notice Share of the legacy penalty paid to the keeper (rest -> lane insurance).
    uint256 public constant KEEPER_SHARE_BPS = 5_000;
    uint256 public constant BPS = 10_000;
    /// @notice Bounds the gas of a cross-margin health check.
    uint256 public constant MAX_OPEN_MARKETS = 8;
    /// @notice A backstop pool must keep equity >= 10% of its exposure notional (at most 10x),
    ///         both after inheriting an auction and after an LP withdrawal.
    uint256 public constant BACKSTOP_MARGIN_BPS = 1_000;
    /// @dev size (1e18 base units) * price (1e18) / 1e30 = notional in AUSD (1e6).
    uint256 internal constant NOTIONAL_SCALE = 1e30;
    /// @dev Default per-lane pool threshold: 75 bps < LIQUIDATION_FEE_BPS (100), so at the default
    ///      the pool never takes more from a trader than the legacy 1% penalty would. Internal so
    ///      the ABI is unchanged; read it per lane with `backstopMinDiscountBps(lane)`.
    uint256 internal constant DEFAULT_BACKSTOP_MIN_DISCOUNT_BPS = 75;

    /// @dev EIP-1153 transient slot for the reentrancy guard: keccak256("paraclr.reentrancy").
    bytes32 internal constant REENTRANCY_SLOT = 0x3e4fcb473394ae8cf419916546036294e01fb39dbb01cf8f2bee54c50613f672;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    struct Position {
        bool isLong;
        uint8 leverage;
        uint256 size; // base units, 1e18
        uint256 entryPrice; // 1e18 AUSD per base unit
        uint256 entryNotional; // AUSD, 1e6
        uint256 margin; // AUSD, 1e6 (initial margin = entryNotional / leverage)
    }

    struct Account {
        int256 collateral; // AUSD 1e6; may go negative transiently under cross margin
        bool registered;
        bytes32[] openMarkets;
    }

    /// @dev Every field is a full slot so that lanes never share a storage slot.
    struct Lane {
        uint256 insuranceFund; // AUSD 1e6
        uint256 badDebt; // AUSD 1e6
        uint256 totalLiquidations; // legacy liquidations + auction takes + expiries
        uint256 lastSettledAt;
    }

    /// @dev Solvency ledger entries that are not already held in `Lane` / `BackstopPool`.
    struct LaneLedger {
        int256 collateral; // Σ trader collateral in the lane (signed, AUSD 1e6)
        uint256 keeperRewards; // keeper rewards owed, earned in this lane
    }

    struct OpenInterest {
        uint256 longNotional; // entry notional, AUSD 1e6
        uint256 shortNotional;
    }

    struct Market {
        bool listed;
        string symbol;
    }

    /// @dev One slot per account. `index` is the position in the lane's auction list.
    struct Auction {
        bool active;
        uint64 startBlock;
        uint32 index;
    }

    /// @dev One slot per lane key.
    struct AuctionCounters {
        uint64 started;
        uint64 taken;
        uint64 cancelled;
        uint64 expired;
    }

    /// @dev The pool's aggregate exposure in one market.
    struct PoolPosition {
        int256 size; // signed base units (1e18): > 0 long, < 0 short
        uint256 entryPrice; // size-weighted average entry, 1e18
        uint256 oiNotional; // exact amount booked into lane open interest
    }

    /// @dev One slot of lifetime stats per pool.
    struct PoolStats {
        uint64 taken;
        uint96 discountEarned; // Σ payments received, AUSD 1e6
        uint96 notionalAbsorbed; // Σ inherited notional at mark, AUSD 1e6
    }

    struct BackstopPool {
        int256 cash; // AUSD 1e6 (signed: realized cross-margin losses can exceed cash)
        uint256 totalShares;
        uint256 minDiscountBps;
        PoolStats stats;
        bytes32[] markets;
        mapping(bytes32 => PoolPosition) positions;
        mapping(address => uint256) shares;
    }

    /// @dev Scratch space for one take (keeps the stack shallow without via-IR).
    struct TakeVars {
        uint16 discount;
        uint256 blocks;
        uint256 notional;
        uint256 payment;
        uint256 residual;
        uint256 shortfall;
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    IERC20 public immutable ausd;
    /// @notice true = naive baseline: every per-lane aggregate shares storage key 0.
    bool public immutable sharedState;
    IPriceOracle public oracle;
    /// @notice Oracle prices older than this (seconds) are rejected.
    uint256 public maxPriceAge;
    /// @notice Auction discount added per block since `startBlock` (default 25 bps).
    uint16 public auctionStepBps;
    /// @notice Auction discount cap; reaching it makes the auction expirable (default 500 bps).
    uint16 public auctionMaxDiscountBps;

    mapping(bytes32 => Market) internal _markets;
    bytes32[] internal _marketIds;

    mapping(address => Account) internal _accounts;
    mapping(address => mapping(bytes32 => Position)) internal _positions;
    mapping(address => Auction) internal _auctions;
    /// @notice Addresses (besides the owner) allowed to call `backstopReduce`.
    mapping(address => bool) public isBackstopOperator;

    /// @dev Account registry (an index, not an aggregate): always keyed by the real lane.
    mapping(uint8 => address[]) internal _laneAccounts;

    // Per-lane aggregates. Only ever accessed through the `_…Store` getters (keyed by `_k`).
    Lane[8] internal _lanes;
    LaneLedger[8] internal _ledgers;
    AuctionCounters[8] internal _auctionCounters;
    mapping(uint8 => mapping(bytes32 => OpenInterest)) internal _laneOI;
    mapping(uint8 => address[]) internal _auctionList;
    mapping(uint8 => BackstopPool) internal _pools;
    mapping(address => mapping(uint8 => uint256)) internal _keeperLaneRewards;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event MarketListed(bytes32 indexed marketId, string symbol);
    event OracleUpdated(address indexed oracle);
    event MaxPriceAgeUpdated(uint256 maxPriceAge);

    event AccountRegistered(address indexed account, uint8 indexed lane);
    event Deposit(address indexed account, uint8 indexed lane, uint256 amount);
    event Withdraw(address indexed account, uint8 indexed lane, uint256 amount);

    event PositionOpened(
        address indexed account,
        uint8 indexed lane,
        bytes32 indexed marketId,
        bool isLong,
        uint256 size,
        uint256 entryPrice,
        uint256 notional,
        uint256 margin,
        uint256 leverage
    );
    event PositionClosed(
        address indexed account,
        uint8 indexed lane,
        bytes32 indexed marketId,
        bool isLong,
        uint256 size,
        uint256 exitPrice,
        int256 realizedPnl
    );

    /// @notice One liquidated account (legacy path). `equity` is pre-liquidation equity.
    event Liquidated(
        uint8 indexed lane,
        address indexed account,
        address indexed keeper,
        int256 equity,
        uint256 notionalClosed,
        uint256 penalty,
        uint256 badDebt
    );
    /// @notice Emitted once per `liquidateBatch`: the lane-level summary for the visualizer.
    event LaneSettled(
        uint8 indexed lane,
        address indexed keeper,
        uint256 liquidated,
        uint256 skipped,
        uint256 insuranceFund,
        uint256 badDebt
    );
    event BadDebtRealized(uint8 indexed lane, address indexed account, uint256 amount);
    event LaneFunded(uint8 indexed lane, address indexed funder, uint256 amount, uint256 debtRepaid);
    event KeeperRewardsClaimed(address indexed keeper, uint256 amount);

    /// @notice `equity` / `notional` at the start block, AUSD 1e6.
    event AuctionStarted(
        uint8 indexed lane, address indexed account, uint256 startBlock, int256 equity, uint256 notional
    );
    /// @notice `taker` is the inheriting account for external takes and the caller that
    ///         triggered the pool for backstop takes (`backstop == true`: the lane pool inherited).
    ///         `payment` is what the taker received: P for the pool, `min(P, max(E, 0))` for an
    ///         external taker. `badDebt` is what the lane funded: `max(0, P − E)` for the pool,
    ///         `max(0, −E)` (the negative equity only) for an external taker (insurance first,
    ///         anything insurance cannot cover is recorded as lane bad debt).
    event AuctionTaken(
        uint8 indexed lane,
        address indexed account,
        address indexed taker,
        bool backstop,
        uint16 discountBps,
        uint256 blocksElapsed,
        uint256 notional,
        uint256 traderResidual,
        uint256 payment,
        uint256 badDebt
    );
    event AuctionCancelled(uint8 indexed lane, address indexed account);
    /// @notice Legacy close-out at max discount. `badDebt` = negative equity written off.
    event AuctionExpired(uint8 indexed lane, address indexed account, int256 equity, uint256 badDebt);
    event BackstopDeposit(uint8 indexed lane, address indexed lp, uint256 amount, uint256 shares);
    event BackstopWithdraw(uint8 indexed lane, address indexed lp, uint256 shares, uint256 amount);
    event BackstopReduced(uint8 indexed lane, bytes32 indexed market, uint256 size, uint256 price, int256 realizedPnl);
    event AuctionParamsUpdated(uint16 stepBps, uint16 maxDiscountBps);
    event BackstopMinDiscountUpdated(uint8 indexed lane, uint16 bps);
    event BackstopOperatorSet(address indexed operator, bool allowed);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAmount();
    error InvalidLane(uint8 lane);
    error InvalidLeverage(uint256 leverage);
    error MarketNotListed(bytes32 marketId);
    error MarketAlreadyListed(bytes32 marketId);
    error PositionExists(bytes32 marketId);
    error NoPosition(bytes32 marketId);
    error TooManyOpenMarkets();
    error InsufficientMargin(int256 equity, uint256 required);
    error InsufficientFreeCollateral(uint256 requested, uint256 available);
    error InvalidPrice(bytes32 marketId);
    error StalePrice(bytes32 marketId, uint256 updatedAt);
    error AccountNotInLane(address account, uint8 lane);
    error Reentrancy();
    error TransferFailed();
    error AmountTooLarge();
    error AccountInAuction(address account);
    error NotInAuction(address account);
    error NotLiquidatable(address account);
    error NotRegistered(address account);
    error SelfTake();
    error InvalidBps();
    error InsufficientShares(uint256 requested, uint256 available);
    error BackstopInsolvent(uint8 lane);
    error BackstopMarginBreached(int256 equityAfter, uint256 required);
    error InsufficientBackstopCash(uint256 requested, int256 cash);

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    /// @dev Transient-storage (EIP-1153) lock. A classic storage-based lock would be a single
    ///      global slot written by every deposit/withdraw and would serialize them on Monad.
    modifier nonReentrant() {
        _enter();
        _;
        _exit();
    }

    /// @dev Modifier bodies are inlined at every use; keeping them as calls saves code size.
    modifier validLane(uint8 lane) {
        _checkLane(lane);
        _;
    }

    function _enter() private {
        bytes32 slot = REENTRANCY_SLOT;
        uint256 locked;
        assembly {
            locked := tload(slot)
        }
        if (locked != 0) revert Reentrancy();
        assembly {
            tstore(slot, 1)
        }
    }

    function _exit() private {
        bytes32 slot = REENTRANCY_SLOT;
        assembly {
            tstore(slot, 0)
        }
    }

    function _checkLane(uint8 lane) private pure {
        if (lane >= LANE_COUNT) revert InvalidLane(lane);
    }

    /// @param sharedState_ false for Paraclr; true only for the naive X-ray baseline.
    constructor(address initialOwner, IERC20 ausd_, IPriceOracle oracle_, bool sharedState_) Owned(initialOwner) {
        ausd = ausd_;
        oracle = oracle_;
        sharedState = sharedState_;
        maxPriceAge = 1 hours;
        auctionStepBps = 25;
        auctionMaxDiscountBps = 500;
        for (uint8 k; k < _keyCount(); ++k) {
            _pools[k].minDiscountBps = DEFAULT_BACKSTOP_MIN_DISCOUNT_BPS;
        }
        emit OracleUpdated(address(oracle_));
        emit MaxPriceAgeUpdated(1 hours);
        emit AuctionParamsUpdated(25, 500);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    /// @notice List a market. `marketId` must be keccak256(bytes(symbol)), e.g. "MON/AUSD".
    function listMarket(string calldata symbol) external onlyOwner returns (bytes32 marketId) {
        marketId = keccak256(bytes(symbol));
        if (_markets[marketId].listed) revert MarketAlreadyListed(marketId);
        _markets[marketId] = Market(true, symbol);
        _marketIds.push(marketId);
        emit MarketListed(marketId, symbol);
    }

    function setOracle(IPriceOracle oracle_) external onlyOwner {
        oracle = oracle_;
        emit OracleUpdated(address(oracle_));
    }

    function setMaxPriceAge(uint256 maxPriceAge_) external onlyOwner {
        maxPriceAge = maxPriceAge_;
        emit MaxPriceAgeUpdated(maxPriceAge_);
    }

    /// @notice Auction clock: `stepBps` per block, capped at `maxDiscountBps` (<= 50%).
    function setAuctionParams(uint16 stepBps, uint16 maxDiscountBps) external onlyOwner {
        if (stepBps == 0 || maxDiscountBps < stepBps || maxDiscountBps > BPS / 2) revert InvalidBps();
        auctionStepBps = stepBps;
        auctionMaxDiscountBps = maxDiscountBps;
        emit AuctionParamsUpdated(stepBps, maxDiscountBps);
    }

    /// @notice Minimum auction discount at which `lane`'s backstop pool takes (default 75 bps,
    ///         i.e. 3 blocks at 25 bps/block: below the 1% legacy penalty, so a pool take at the
    ///         default threshold leaves the trader more than the legacy liquidation would).
    function setBackstopMinDiscount(uint8 lane, uint16 bps) external onlyOwner validLane(lane) {
        if (bps > BPS) revert InvalidBps();
        _poolStore(lane).minDiscountBps = bps;
        emit BackstopMinDiscountUpdated(lane, bps);
    }

    /// @notice Grant/revoke the keeper role that may call `backstopReduce` (owner always may).
    function setBackstopOperator(address operator, bool allowed) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        isBackstopOperator[operator] = allowed;
        emit BackstopOperatorSet(operator, allowed);
    }

    // ---------------------------------------------------------------------
    // Collateral
    // ---------------------------------------------------------------------

    /// @notice Deposit AUSD collateral (requires prior `approve`). Registers the account in its
    ///         lane. Allowed while in auction (top up, then `cancelAuction` to cure).
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint8 lane = _creditCollateral(msg.sender, amount);
        _safeTransferFrom(msg.sender, address(this), amount);
        emit Deposit(msg.sender, lane, amount);
    }

    /// @notice Withdraw AUSD. Limited to min(collateral, equity - initialMargin). Frozen in auction.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _notInAuction(msg.sender);
        uint256 available = freeCollateral(msg.sender);
        if (amount > available) revert InsufficientFreeCollateral(amount, available);
        uint8 lane = laneOf(msg.sender);
        _adjustCollateral(msg.sender, lane, -_toInt(amount));
        _safeTransfer(msg.sender, amount);
        emit Withdraw(msg.sender, lane, amount);
    }

    /// @notice Top up a lane's insurance fund. Repays that lane's bad debt first.
    function fundLane(uint8 lane, uint256 amount) external nonReentrant validLane(lane) {
        if (amount == 0) revert ZeroAmount();
        uint256 repaid = _creditLane(lane, amount);
        _safeTransferFrom(msg.sender, address(this), amount);
        emit LaneFunded(lane, msg.sender, amount, repaid);
    }

    /// @notice Withdraw accrued liquidation rewards (all lanes) to the keeper's wallet.
    function claimKeeperRewards() external nonReentrant returns (uint256 amount) {
        for (uint8 k; k < _keyCount(); ++k) {
            uint256 r = _keeperLaneRewards[msg.sender][k];
            if (r == 0) continue;
            _keeperLaneRewards[msg.sender][k] = 0;
            _ledgers[k].keeperRewards -= r;
            amount += r;
        }
        if (amount == 0) revert ZeroAmount();
        _safeTransfer(msg.sender, amount);
        emit KeeperRewardsClaimed(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Trading
    // ---------------------------------------------------------------------

    /// @notice Open a position of notional `margin * leverage` at the current oracle price.
    /// @param marketId keccak256 of the market symbol, e.g. keccak256("MON/AUSD").
    /// @param isLong true = long, false = short.
    /// @param margin Initial margin in AUSD (1e6) committed from cross-margin collateral.
    /// @param leverage 1..20.
    /// @return size Position size in base units (1e18).
    function openPosition(bytes32 marketId, bool isLong, uint256 margin, uint256 leverage)
        external
        returns (uint256 size)
    {
        return _openPosition(msg.sender, marketId, isLong, margin, leverage);
    }

    /// @dev Shared by `openPosition` and the demo-only seeding path in ParaclrClearinghouseDemo.
    function _openPosition(address account, bytes32 marketId, bool isLong, uint256 margin, uint256 leverage)
        internal
        returns (uint256 size)
    {
        if (margin == 0) revert ZeroAmount();
        if (leverage == 0 || leverage > MAX_LEVERAGE) revert InvalidLeverage(leverage);
        if (!_markets[marketId].listed) revert MarketNotListed(marketId);
        _notInAuction(account);

        Account storage acct = _accounts[account];
        Position storage pos = _positions[account][marketId];
        if (pos.size != 0) revert PositionExists(marketId);
        if (acct.openMarkets.length >= MAX_OPEN_MARKETS) revert TooManyOpenMarkets();

        uint256 price = _getPrice(marketId);
        size = ((margin * leverage) * NOTIONAL_SCALE) / price;
        if (size == 0) revert ZeroAmount();

        pos.isLong = isLong;
        pos.leverage = uint8(leverage);
        pos.size = size;
        pos.entryPrice = price;
        pos.entryNotional = margin * leverage;
        pos.margin = margin;
        acct.openMarkets.push(marketId);

        // Post-trade cross-margin check: equity must cover the sum of initial margins.
        _requireInitialMargin(account);

        _recordOpen(account, marketId, pos);
    }

    /// @dev Registers `account` in its lane on first use and adds `amount` to its collateral.
    ///      Token transfer is the caller's job. Shared by `deposit` and demo seeding.
    function _creditCollateral(address account, uint256 amount) internal returns (uint8 lane) {
        lane = laneOf(account);
        Account storage acct = _accounts[account];
        if (!acct.registered) {
            acct.registered = true;
            _laneAccounts[lane].push(account);
            emit AccountRegistered(account, lane);
        }
        _adjustCollateral(account, lane, _toInt(amount));
    }

    /// @dev Split out of openPosition to keep the stack shallow (no via-IR needed).
    function _recordOpen(address account, bytes32 marketId, Position storage pos) internal {
        uint8 lane = laneOf(account);
        OpenInterest storage oi = _oiStore(lane, marketId);
        if (pos.isLong) oi.longNotional += pos.entryNotional;
        else oi.shortNotional += pos.entryNotional;
        emit PositionOpened(
            account, lane, marketId, pos.isLong, pos.size, pos.entryPrice, pos.entryNotional, pos.margin, pos.leverage
        );
    }

    /// @notice Close the caller's position in `marketId` at the oracle price and realize PnL.
    ///         Frozen while the account is in auction.
    function closePosition(bytes32 marketId) external returns (int256 realizedPnl) {
        Position memory pos = _positions[msg.sender][marketId];
        if (pos.size == 0) revert NoPosition(marketId);
        _notInAuction(msg.sender);
        uint8 lane = laneOf(msg.sender);
        uint256 price = _getPrice(marketId);

        realizedPnl = _closeInternal(msg.sender, lane, marketId, pos, price);

        // If an account closed its last position with negative collateral it is insolvent:
        // write the shortfall off against this account's lane only. (With other legs still
        // open, a negative balance is legitimately backed by their unrealized PnL; keepers
        // liquidate if maintenance is breached.)
        if (_accounts[msg.sender].openMarkets.length == 0) _writeOffNegative(msg.sender, lane);
    }

    // ---------------------------------------------------------------------
    // Legacy liquidation (kept for backwards compatibility; the keeper uses auctions)
    // ---------------------------------------------------------------------

    /// @notice Liquidate every under-maintenance account in `accounts`, all of which MUST belong
    ///         to `lane`. Accounts in auction are skipped (the auction resolves them).
    /// @dev PARALLELISM: the lane check is what makes batches for different lanes touch disjoint
    ///      storage. A single out-of-lane account reverts the whole batch (`AccountNotInLane`)
    ///      rather than silently creating a cross-lane conflict. Healthy accounts are skipped,
    ///      not reverted, so racing keepers don't waste batches.
    /// @return liquidated Number of accounts liquidated.
    function liquidateBatch(uint8 lane, address[] calldata accounts)
        external
        validLane(lane)
        returns (uint256 liquidated)
    {
        uint256 keeperReward;
        uint256 skipped;

        for (uint256 i; i < accounts.length; ++i) {
            address account = accounts[i];
            _requireLane(account, lane);
            (bool done, uint256 reward) = _liquidate(account, lane);
            if (done) {
                ++liquidated;
                keeperReward += reward;
            } else {
                ++skipped;
            }
        }

        Lane storage l = _laneStore(lane);
        if (liquidated > 0) {
            l.totalLiquidations += liquidated;
            _creditKeeper(msg.sender, lane, keeperReward);
        }
        l.lastSettledAt = block.timestamp;
        emit LaneSettled(lane, msg.sender, liquidated, skipped, l.insuranceFund, l.badDebt);
    }

    // ---------------------------------------------------------------------
    // Auctions
    // ---------------------------------------------------------------------

    /// @notice Put every under-maintenance account in `accounts` (all in `lane`) into auction.
    ///         Healthy and already-in-auction accounts are skipped; an out-of-lane account
    ///         reverts the batch. Anyone may call.
    /// @return started Number of auctions started.
    function startAuctions(uint8 lane, address[] calldata accounts) external validLane(lane) returns (uint256 started) {
        address[] storage list = _auctionListStore(lane);
        for (uint256 i; i < accounts.length; ++i) {
            address a = accounts[i];
            _requireLane(a, lane);
            Auction storage au = _auctions[a];
            if (au.active || _accounts[a].openMarkets.length == 0) continue;
            (int256 equity, uint256 mm,, uint256 notional) = accountHealth(a);
            if (equity >= int256(mm)) continue;
            au.active = true;
            au.startBlock = uint64(block.number);
            au.index = uint32(list.length);
            list.push(a);
            ++started;
            emit AuctionStarted(lane, a, block.number, equity, notional);
        }
        if (started > 0) _countersStore(lane).started += uint64(started);
    }

    /// @notice External take: the caller (a registered account in the SAME lane, not itself in
    ///         auction) inherits every leg of `account` at mark and is paid
    ///         `min(discount × notional, max(E, 0))`: only from the trader's own equity, never
    ///         from the lane fund. Reverts unless the taker stays at or above initial margin.
    /// @return payment AUSD credited to the taker's collateral.
    function take(address account) external returns (uint256 payment) {
        Auction memory au = _auctions[account];
        if (!au.active) revert NotInAuction(account);
        uint8 lane = laneOf(account);
        _requireLane(msg.sender, lane);
        if (msg.sender == account) revert SelfTake();
        if (!_accounts[msg.sender].registered) revert NotRegistered(msg.sender);
        _notInAuction(msg.sender);
        if (!isLiquidatable(account)) revert NotLiquidatable(account);
        payment = _take(account, lane, au.startBlock, false);
        _requireInitialMargin(msg.sender);
    }

    /// @notice Let `lane`'s backstop pool take every auction in `accounts` whose discount is at
    ///         least the pool's `minDiscountBps` and that the pool can carry (equity >=
    ///         `BACKSTOP_MARGIN_BPS` of exposure after inheriting). Others are skipped; an
    ///         out-of-lane account reverts the batch. Anyone may call.
    /// @return taken Number of auctions the pool took.
    function backstopTakeBatch(uint8 lane, address[] calldata accounts)
        external
        validLane(lane)
        returns (uint256 taken)
    {
        uint256 minDiscount = _poolStore(lane).minDiscountBps;
        for (uint256 i; i < accounts.length; ++i) {
            address a = accounts[i];
            _requireLane(a, lane);
            Auction memory au = _auctions[a];
            if (!au.active) continue;
            uint16 d = _discountBps(au.startBlock);
            if (d < minDiscount || !isLiquidatable(a) || !_poolCanTake(lane, a, d)) continue;
            _take(a, lane, au.startBlock, true);
            ++taken;
        }
        if (taken > 0) _laneStore(lane).lastSettledAt = block.timestamp;
    }

    /// @notice Cure: end `account`'s auction if it is healthy again (top-up or price recovery).
    /// @return cancelled false if the account is not in auction or still under maintenance.
    function cancelAuction(address account) external returns (bool cancelled) {
        if (!_auctions[account].active || isLiquidatable(account)) return false;
        uint8 lane = laneOf(account);
        _endAuction(account, lane);
        ++_countersStore(lane).cancelled;
        emit AuctionCancelled(lane, account);
        return true;
    }

    /// @notice Expiry fallback: close every auction in `accounts` (all in `lane`) that reached
    ///         the max discount untaken, through the legacy liquidation path (close at mark
    ///         against the lane, 1% penalty capped at equity — half to the caller — negative
    ///         equity written off against the lane). Cured accounts are skipped (cancel them).
    /// @return expired Number of auctions expired.
    function expireBatch(uint8 lane, address[] calldata accounts) external validLane(lane) returns (uint256 expired) {
        uint256 keeperReward;
        for (uint256 i; i < accounts.length; ++i) {
            _requireLane(accounts[i], lane);
            (bool done, uint256 reward) = _expire(accounts[i], lane);
            if (!done) continue;
            keeperReward += reward;
            ++expired;
        }
        if (expired > 0) {
            _countersStore(lane).expired += uint64(expired);
            Lane storage l = _laneStore(lane);
            l.totalLiquidations += expired;
            l.lastSettledAt = block.timestamp;
            _creditKeeper(msg.sender, lane, keeperReward);
        }
    }

    // ---------------------------------------------------------------------
    // Backstop pools
    // ---------------------------------------------------------------------

    /// @notice Deposit AUSD into `lane`'s backstop pool for shares at the current NAV.
    function backstopDeposit(uint8 lane, uint256 amount)
        external
        nonReentrant
        validLane(lane)
        returns (uint256 shares)
    {
        if (amount == 0) revert ZeroAmount();
        BackstopPool storage pool = _poolStore(lane);
        uint256 supply = pool.totalShares;
        if (supply == 0) {
            shares = amount;
        } else {
            (int256 equity,) = _poolEquity(pool);
            if (equity <= 0) revert BackstopInsolvent(lane);
            shares = (amount * supply) / uint256(equity);
        }
        if (shares == 0) revert ZeroAmount();
        pool.totalShares = supply + shares;
        pool.shares[msg.sender] += shares;
        pool.cash += _toInt(amount);
        _safeTransferFrom(msg.sender, address(this), amount);
        emit BackstopDeposit(lane, msg.sender, amount, shares);
    }

    /// @notice Redeem `shares` of `lane`'s pool for AUSD at the current NAV. Reverts if the
    ///         payout exceeds pool cash or would leave pool equity below `BACKSTOP_MARGIN_BPS` of
    ///         its exposure.
    function backstopWithdraw(uint8 lane, uint256 shares)
        external
        nonReentrant
        validLane(lane)
        returns (uint256 amount)
    {
        if (shares == 0) revert ZeroAmount();
        BackstopPool storage pool = _poolStore(lane);
        uint256 owned = pool.shares[msg.sender];
        if (shares > owned) revert InsufficientShares(shares, owned);
        (int256 equity, uint256 exposure) = _poolEquity(pool);
        if (equity <= 0) revert BackstopInsolvent(lane);
        amount = (shares * uint256(equity)) / pool.totalShares;
        int256 remaining = equity - _toInt(amount);
        uint256 required = (exposure * BACKSTOP_MARGIN_BPS) / BPS;
        if (remaining < _toInt(required)) revert BackstopMarginBreached(remaining, required);
        if (_toInt(amount) > pool.cash) revert InsufficientBackstopCash(amount, pool.cash);
        pool.shares[msg.sender] = owned - shares;
        pool.totalShares -= shares;
        pool.cash -= _toInt(amount);
        if (amount > 0) _safeTransfer(msg.sender, amount);
        emit BackstopWithdraw(lane, msg.sender, shares, amount);
    }

    /// @notice Close up to `size` (1e18) of the pool's inherited exposure in `market` at mark
    ///         (against the lane fund, like any close). Owner or a backstop operator only.
    /// @return realizedPnl Realized into pool cash, AUSD 1e6.
    function backstopReduce(uint8 lane, bytes32 market, uint256 size)
        external
        validLane(lane)
        returns (int256 realizedPnl)
    {
        if (msg.sender != owner && !isBackstopOperator[msg.sender]) revert Unauthorized();
        if (size == 0) revert ZeroAmount();
        BackstopPool storage pool = _poolStore(lane);
        PoolPosition storage pp = pool.positions[market];
        int256 s = pp.size;
        if (s == 0) revert NoPosition(market);
        uint256 abs = _abs(s);
        if (size > abs) size = abs;
        uint256 price = _getPrice(market);
        realizedPnl = _poolRealize(lane, pool, s > 0, size, pp.entryPrice, price);
        pp.size = s > 0 ? s - int256(size) : s + int256(size);
        _poolSync(lane, pool, market, s);
        _poolWriteOffNegative(lane, pool);
        emit BackstopReduced(lane, market, size, price, realizedPnl);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice The lane an account is sharded into: uint160(account) % 8.
    function laneOf(address account) public pure returns (uint8) {
        return uint8(uint160(account) % LANE_COUNT);
    }

    /// @notice Cross-margin health at current oracle prices (AUSD, 1e6).
    /// @return equity collateral + unrealized PnL (signed).
    /// @return maintenanceMargin 2.5% of current notional.
    /// @return initialMargin Sum of position margins.
    /// @return notional Sum of current notional.
    function accountHealth(address account)
        public
        view
        returns (int256 equity, uint256 maintenanceMargin, uint256 initialMargin, uint256 notional)
    {
        Account storage acct = _accounts[account];
        equity = acct.collateral;
        bytes32[] storage mkts = acct.openMarkets;
        for (uint256 i; i < mkts.length; ++i) {
            Position storage pos = _positions[account][mkts[i]];
            uint256 price = _getPrice(mkts[i]);
            equity += _pnl(pos.isLong, pos.size, pos.entryPrice, price);
            notional += (pos.size * price) / NOTIONAL_SCALE;
            initialMargin += pos.margin;
        }
        maintenanceMargin = (notional * MAINTENANCE_MARGIN_BPS) / BPS;
    }

    function isLiquidatable(address account) public view returns (bool) {
        if (_accounts[account].openMarkets.length == 0) return false;
        (int256 equity, uint256 mm,,) = accountHealth(account);
        return equity < int256(mm);
    }

    /// @notice Collateral withdrawable now: min(collateral, equity - initialMargin), floored at
    ///         0. Always 0 while the account is in auction (frozen).
    function freeCollateral(address account) public view returns (uint256) {
        if (_auctions[account].active) return 0;
        (int256 equity,, uint256 im,) = accountHealth(account);
        int256 free = equity - int256(im);
        int256 coll = _accounts[account].collateral;
        if (coll < free) free = coll;
        return free > 0 ? uint256(free) : 0;
    }

    /// @notice Unrealized PnL of one position at the current oracle price (AUSD 1e6).
    function unrealizedPnl(address account, bytes32 marketId) external view returns (int256) {
        Position storage pos = _positions[account][marketId];
        if (pos.size == 0) return 0;
        return _pnl(pos.isLong, pos.size, pos.entryPrice, _getPrice(marketId));
    }

    function getAccount(address account)
        external
        view
        returns (int256 collateral, uint8 lane, bool registered, bytes32[] memory openMarkets)
    {
        Account storage acct = _accounts[account];
        return (acct.collateral, laneOf(account), acct.registered, acct.openMarkets);
    }

    function getPosition(address account, bytes32 marketId) external view returns (Position memory) {
        return _positions[account][marketId];
    }

    /// @dev In shared-state mode the aggregate fields are the shared (all-lane) values.
    function getLane(uint8 lane)
        external
        view
        validLane(lane)
        returns (
            uint256 insuranceFund,
            uint256 badDebt,
            uint256 totalLiquidations,
            uint256 lastSettledAt,
            uint256 accountCount
        )
    {
        Lane storage l = _laneStore(lane);
        return (l.insuranceFund, l.badDebt, l.totalLiquidations, l.lastSettledAt, _laneAccounts[lane].length);
    }

    function laneAccountCount(uint8 lane) external view returns (uint256) {
        return _laneAccounts[lane].length;
    }

    /// @notice Paginated list of accounts registered in a lane (for keepers / the visualizer).
    function getLaneAccounts(uint8 lane, uint256 offset, uint256 limit) external view returns (address[] memory page) {
        return _page(_laneAccounts[lane], lane, offset, limit, false);
    }

    /// @notice Keeper helper: accounts in a page of a lane that are under maintenance margin and
    ///         NOT already in auction (i.e. what `startAuctions` / `liquidateBatch` would act on).
    function getLiquidatableAccounts(uint8 lane, uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory)
    {
        return _page(_laneAccounts[lane], lane, offset, limit, true);
    }

    /// @notice Accounts currently in auction in `lane`. `offset`/`limit` index the lane's auction
    ///         list (in shared-state mode: the shared list, filtered to `lane`).
    function getAuctionAccounts(uint8 lane, uint256 offset, uint256 limit)
        external
        view
        validLane(lane)
        returns (address[] memory)
    {
        return _page(_auctionListStore(lane), lane, offset, limit, false);
    }

    /// @notice Auction state of `account`; `discountBps` is the discount a take would get now.
    function auctionOf(address account) external view returns (bool active, uint64 startBlock, uint16 discountBps) {
        Auction memory au = _auctions[account];
        if (!au.active) return (false, 0, 0);
        return (true, au.startBlock, _discountBps(au.startBlock));
    }

    /// @notice Lifetime auction counters of `lane` (+ currently active count).
    function auctionStats(uint8 lane)
        external
        view
        validLane(lane)
        returns (uint256 active, uint256 started, uint256 taken, uint256 cancelled, uint256 expired)
    {
        AuctionCounters memory c = _countersStore(lane);
        return (_auctionListStore(lane).length, c.started, c.taken, c.cancelled, c.expired);
    }

    /// @notice Global open interest for a market: summed over lanes at read time, never stored.
    function openInterest(bytes32 marketId) external view returns (uint256 longNotional, uint256 shortNotional) {
        for (uint8 k; k < _keyCount(); ++k) {
            OpenInterest storage oi = _laneOI[k][marketId];
            longNotional += oi.longNotional;
            shortNotional += oi.shortNotional;
        }
    }

    function laneOpenInterest(uint8 lane, bytes32 marketId)
        external
        view
        returns (uint256 longNotional, uint256 shortNotional)
    {
        OpenInterest storage oi = _oiStore(lane, marketId);
        return (oi.longNotional, oi.shortNotional);
    }

    /// @notice Unclaimed keeper rewards, summed over the lanes they were earned in.
    function keeperRewards(address keeper) external view returns (uint256 total) {
        for (uint8 k; k < _keyCount(); ++k) {
            total += _keeperLaneRewards[keeper][k];
        }
    }

    // --- backstop views ---

    /// @notice Pool NAV at mark: equity = cash + unrealizedPnl. `cash` is signed (see Deviations).
    function backstopNav(uint8 lane)
        external
        view
        validLane(lane)
        returns (int256 equity, int256 cash, int256 unrealized, uint256 shareSupply)
    {
        BackstopPool storage pool = _poolStore(lane);
        (equity,) = _poolEquity(pool);
        cash = pool.cash;
        unrealized = equity - cash;
        shareSupply = pool.totalShares;
    }

    function backstopSharesOf(uint8 lane, address lp) external view validLane(lane) returns (uint256) {
        return _poolStore(lane).shares[lp];
    }

    /// @notice The pool's inherited exposure, aggregated per market (signed size, avg entry).
    function backstopPositions(uint8 lane)
        external
        view
        validLane(lane)
        returns (bytes32[] memory markets, int256[] memory signedSizes, uint256[] memory entryPrices)
    {
        BackstopPool storage pool = _poolStore(lane);
        markets = pool.markets;
        signedSizes = new int256[](markets.length);
        entryPrices = new uint256[](markets.length);
        for (uint256 i; i < markets.length; ++i) {
            PoolPosition storage pp = pool.positions[markets[i]];
            signedSizes[i] = pp.size;
            entryPrices[i] = pp.entryPrice;
        }
    }

    /// @notice Lifetime: auctions taken, Σ discount payments received, Σ notional inherited.
    function backstopStats(uint8 lane)
        external
        view
        validLane(lane)
        returns (uint256 taken, uint256 discountEarned, uint256 notionalAbsorbed)
    {
        PoolStats memory s = _poolStore(lane).stats;
        return (s.taken, s.discountEarned, s.notionalAbsorbed);
    }

    function backstopMinDiscountBps(uint8 lane) external view validLane(lane) returns (uint256) {
        return _poolStore(lane).minDiscountBps;
    }

    // --- solvency ---

    /// @notice Live solvency proof.
    /// @return ausdHeld AUSD.balanceOf(this).
    /// @return liabilities Ledger total Σ_keys(collateral + insurance + backstopCash +
    ///         keeperRewards − badDebt): the AUSD the books say this contract must hold.
    /// @return surplus ausdHeld − liabilities (0 unless someone sent AUSD directly).
    /// @return solvent surplus >= 0.
    function solvency() external view returns (uint256 ausdHeld, uint256 liabilities, int256 surplus, bool solvent) {
        ausdHeld = ausd.balanceOf(address(this));
        int256 total;
        for (uint8 k; k < _keyCount(); ++k) {
            Lane storage l = _lanes[k];
            LaneLedger storage g = _ledgers[k];
            total += g.collateral + int256(l.insuranceFund) + _pools[k].cash + int256(g.keeperRewards)
            - int256(l.badDebt);
        }
        liabilities = total > 0 ? uint256(total) : 0;
        surplus = _toInt(ausdHeld) - total;
        solvent = surplus >= 0;
    }

    /// @notice One lane's solvency ledger (shared-state mode: the shared totals for every lane).
    ///         `collateral` and `backstopCash` are signed (see Deviations).
    function laneLedger(uint8 lane)
        external
        view
        validLane(lane)
        returns (int256 collateral, uint256 insurance, int256 backstopCash, uint256 keeperRewardsOwed, uint256 badDebt)
    {
        Lane storage l = _laneStore(lane);
        LaneLedger storage g = _ledgerStore(lane);
        return (g.collateral, l.insuranceFund, _poolStore(lane).cash, g.keeperRewards, l.badDebt);
    }

    function getMarkets() external view returns (bytes32[] memory ids, string[] memory symbols) {
        ids = _marketIds;
        symbols = new string[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            symbols[i] = _markets[ids[i]].symbol;
        }
    }

    function isMarketListed(bytes32 marketId) external view returns (bool) {
        return _markets[marketId].listed;
    }

    /// @notice Oracle price as validated by the clearinghouse (reverts if missing or stale).
    function markPrice(bytes32 marketId) external view returns (uint256) {
        return _getPrice(marketId);
    }

    // ---------------------------------------------------------------------
    // Internal: storage keying (the ONLY difference between Paraclr and the naive baseline)
    // ---------------------------------------------------------------------

    /// @dev Storage key of a lane's aggregates: the lane itself, or 0 for every lane when shared.
    function _k(uint8 lane) internal view returns (uint8) {
        return sharedState ? 0 : lane;
    }

    /// @dev Number of distinct aggregate keys (views sum over these).
    function _keyCount() internal view returns (uint8) {
        return sharedState ? 1 : LANE_COUNT;
    }

    function _laneStore(uint8 lane) internal view returns (Lane storage) {
        return _lanes[_k(lane)];
    }

    function _ledgerStore(uint8 lane) internal view returns (LaneLedger storage) {
        return _ledgers[_k(lane)];
    }

    function _countersStore(uint8 lane) internal view returns (AuctionCounters storage) {
        return _auctionCounters[_k(lane)];
    }

    function _oiStore(uint8 lane, bytes32 marketId) internal view returns (OpenInterest storage) {
        return _laneOI[_k(lane)][marketId];
    }

    function _auctionListStore(uint8 lane) internal view returns (address[] storage) {
        return _auctionList[_k(lane)];
    }

    function _poolStore(uint8 lane) internal view returns (BackstopPool storage) {
        return _pools[_k(lane)];
    }

    // ---------------------------------------------------------------------
    // Internal: accounting
    // ---------------------------------------------------------------------

    function _getPrice(bytes32 marketId) internal view returns (uint256 price) {
        uint256 updatedAt;
        (price, updatedAt) = oracle.getPrice(marketId);
        if (price == 0) revert InvalidPrice(marketId);
        if (block.timestamp > updatedAt + maxPriceAge) revert StalePrice(marketId, updatedAt);
    }

    function _toInt(uint256 x) internal pure returns (int256) {
        if (x > uint256(type(int256).max)) revert AmountTooLarge();
        return int256(x);
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }

    function _requireLane(address account, uint8 lane) internal pure {
        if (laneOf(account) != lane) revert AccountNotInLane(account, lane);
    }

    function _notInAuction(address account) internal view {
        if (_auctions[account].active) revert AccountInAuction(account);
    }

    function _requireInitialMargin(address account) internal view {
        (int256 equity,, uint256 initialMargin,) = accountHealth(account);
        if (equity < int256(initialMargin)) revert InsufficientMargin(equity, initialMargin);
    }

    /// @dev The ONLY way trader collateral changes: account balance + lane ledger together.
    function _adjustCollateral(address account, uint8 lane, int256 delta) internal {
        _accounts[account].collateral += delta;
        _ledgerStore(lane).collateral += delta;
    }

    function _creditKeeper(address keeper, uint8 lane, uint256 amount) internal {
        if (amount == 0) return;
        _keeperLaneRewards[keeper][_k(lane)] += amount;
        _ledgerStore(lane).keeperRewards += amount;
    }

    /// @dev PnL = size * (mark - entry) / 1e30, sign-flipped for shorts. Computed from the price
    ///      delta (not value - entryNotional) so PnL is exactly zero at the entry price and
    ///      rounding is symmetric for longs and shorts.
    function _pnl(bool isLong, uint256 size, uint256 entryPrice, uint256 markPrice_)
        internal
        pure
        returns (int256 pnl)
    {
        pnl = (_toInt(size) * (_toInt(markPrice_) - _toInt(entryPrice))) / int256(NOTIONAL_SCALE);
        if (!isLong) pnl = -pnl;
    }

    /// @dev Closes one position, realizes PnL against the account's own lane accumulator.
    function _closeInternal(address account, uint8 lane, bytes32 marketId, Position memory pos, uint256 price)
        internal
        returns (int256 pnl)
    {
        pnl = _pnl(pos.isLong, pos.size, pos.entryPrice, price);

        delete _positions[account][marketId];
        _removeOpenMarket(_accounts[account], marketId);

        OpenInterest storage oi = _oiStore(lane, marketId);
        if (pos.isLong) oi.longNotional -= pos.entryNotional;
        else oi.shortNotional -= pos.entryNotional;

        _adjustCollateral(account, lane, pnl);
        // The lane's insurance fund is the counterparty: it absorbs losses and pays profits.
        _settleWithLane(lane, -pnl);

        emit PositionClosed(account, lane, marketId, pos.isLong, pos.size, price, pnl);
    }

    /// @dev Lane receives `laneDelta` (> 0: inflow, < 0: outflow).
    function _settleWithLane(uint8 lane, int256 laneDelta) internal {
        if (laneDelta > 0) _creditLane(lane, uint256(laneDelta));
        else if (laneDelta < 0) _debitLane(lane, uint256(-laneDelta));
    }

    /// @return done Whether the account was liquidated.
    /// @return keeperReward Keeper share of the penalty.
    function _liquidate(address account, uint8 lane) internal returns (bool done, uint256 keeperReward) {
        if (_accounts[account].openMarkets.length == 0 || _auctions[account].active) return (false, 0);
        (int256 equity, uint256 mm,, uint256 notional) = accountHealth(account);
        if (equity >= int256(mm)) return (false, 0);
        uint256 penalty;
        uint256 badDebt;
        (penalty, keeperReward, badDebt) = _closeOut(account, lane, notional);
        emit Liquidated(lane, account, msg.sender, equity, notional, penalty, badDebt);
        return (true, keeperReward);
    }

    /// @dev Legacy close-out (liquidateBatch and auction expiry): close every leg at the oracle
    ///      price against the lane, charge the 1% penalty from what is left (keeper share returned
    ///      to the caller to credit), write negative equity off against the lane.
    function _closeOut(address account, uint8 lane, uint256 notional)
        internal
        returns (uint256 penalty, uint256 keeperReward, uint256 badDebt)
    {
        Account storage acct = _accounts[account];
        while (acct.openMarkets.length > 0) {
            bytes32 m = acct.openMarkets[acct.openMarkets.length - 1];
            _closeInternal(account, lane, m, _positions[account][m], _getPrice(m));
        }
        if (acct.collateral > 0) {
            penalty = (notional * LIQUIDATION_FEE_BPS) / BPS;
            if (penalty > uint256(acct.collateral)) penalty = uint256(acct.collateral);
            _adjustCollateral(account, lane, -int256(penalty));
            keeperReward = (penalty * KEEPER_SHARE_BPS) / BPS;
            _creditLane(lane, penalty - keeperReward);
        }
        badDebt = _writeOffNegative(account, lane);
    }

    /// @dev Transfer every leg of `account` to the taker (msg.sender, or the lane pool) at mark
    ///      and settle the discount payment. Caller has checked eligibility.
    function _take(address account, uint8 lane, uint64 startBlock, bool backstop) internal returns (uint256) {
        TakeVars memory v;
        v.discount = _discountBps(startBlock);
        v.blocks = block.number - startBlock;

        // 1. Each leg: the trader's side is closed at mark against the lane (realizing PnL);
        //    the taker opens the identical leg at mark. Lane counterparty exposure is unchanged.
        Account storage acct = _accounts[account];
        while (acct.openMarkets.length > 0) {
            bytes32 m = acct.openMarkets[acct.openMarkets.length - 1];
            Position memory pos = _positions[account][m];
            uint256 price = _getPrice(m);
            v.notional += (pos.size * price) / NOTIONAL_SCALE;
            _closeInternal(account, lane, m, pos, price);
            if (backstop) _poolAdd(lane, m, pos.isLong, pos.size, price);
            else _inherit(msg.sender, m, pos, price);
        }

        // 2. Payment P = d × notional. Trader equity E (now = collateral) pays first. For the lane
        //    pool the lane covers P − E if E < P; an external taker is capped at max(E, 0) so the
        //    lane never funds an arbitrary address. Negative E is written off against the lane.
        v.payment = (v.notional * v.discount) / BPS;
        int256 e = acct.collateral;
        if (!backstop && _toInt(v.payment) > e) v.payment = e > 0 ? uint256(e) : 0;
        uint256 traderPays = e <= 0 ? 0 : (uint256(e) < v.payment ? uint256(e) : v.payment);
        if (traderPays > 0) _adjustCollateral(account, lane, -int256(traderPays));
        v.residual = e > int256(v.payment) ? uint256(e) - v.payment : 0;
        v.shortfall = v.payment - traderPays;
        if (v.shortfall > 0) _debitLane(lane, v.shortfall);
        v.shortfall += _writeOffNegative(account, lane);

        // 3. Credit the taker.
        if (backstop) {
            BackstopPool storage pool = _poolStore(lane);
            pool.cash += _toInt(v.payment);
            PoolStats memory s = pool.stats;
            pool.stats = PoolStats(
                s.taken + 1, _u96(uint256(s.discountEarned) + v.payment), _u96(uint256(s.notionalAbsorbed) + v.notional)
            );
            _poolWriteOffNegative(lane, pool);
        } else {
            _adjustCollateral(msg.sender, lane, _toInt(v.payment));
        }

        // 4. Close the auction.
        _endAuction(account, lane);
        ++_countersStore(lane).taken;
        ++_laneStore(lane).totalLiquidations;

        emit AuctionTaken(
            lane, account, msg.sender, backstop, v.discount, v.blocks, v.notional, v.residual, v.payment, v.shortfall
        );
        return v.payment;
    }

    /// @dev External taker (same lane, checked by `take`) opens `src`'s leg at mark with the same
    ///      leverage (margin rounded up).
    function _inherit(address taker, bytes32 m, Position memory src, uint256 price) internal {
        Position storage p = _positions[taker][m];
        if (p.size != 0) revert PositionExists(m);
        Account storage t = _accounts[taker];
        if (t.openMarkets.length >= MAX_OPEN_MARKETS) revert TooManyOpenMarkets();
        uint256 notional = (src.size * price) / NOTIONAL_SCALE;
        p.isLong = src.isLong;
        p.leverage = src.leverage;
        p.size = src.size;
        p.entryPrice = price;
        p.entryNotional = notional;
        p.margin = (notional + src.leverage - 1) / src.leverage;
        t.openMarkets.push(m);
        _recordOpen(taker, m, p);
    }

    /// @dev Expire one auction if it reached the max discount and is still under maintenance.
    function _expire(address a, uint8 lane) internal returns (bool, uint256) {
        Auction memory au = _auctions[a];
        if (!au.active || _discountBps(au.startBlock) < auctionMaxDiscountBps) return (false, 0);
        (int256 equity, uint256 mm,, uint256 notional) = accountHealth(a);
        if (equity >= int256(mm)) return (false, 0);
        _endAuction(a, lane);
        (, uint256 reward, uint256 badDebt) = _closeOut(a, lane, notional);
        emit AuctionExpired(lane, a, equity, badDebt);
        return (true, reward);
    }

    function _discountBps(uint64 startBlock) internal view returns (uint16) {
        uint256 d = uint256(auctionStepBps) * (block.number - startBlock);
        uint256 max = auctionMaxDiscountBps;
        return uint16(d > max ? max : d);
    }

    /// @dev Swap-and-pop `account` out of its lane's auction list and clear its auction slot.
    function _endAuction(address account, uint8 lane) internal {
        address[] storage list = _auctionListStore(lane);
        uint256 idx = _auctions[account].index;
        uint256 last = list.length - 1;
        if (idx != last) {
            address moved = list[last];
            list[idx] = moved;
            _auctions[moved].index = uint32(idx);
        }
        list.pop();
        delete _auctions[account];
    }

    // --- backstop pool internals ---

    /// @return equity cash + unrealized PnL at mark.
    /// @return exposure Σ |size| × mark (AUSD 1e6).
    function _poolEquity(BackstopPool storage pool) internal view returns (int256 equity, uint256 exposure) {
        equity = pool.cash;
        bytes32[] storage pm = pool.markets;
        for (uint256 i; i < pm.length; ++i) {
            PoolPosition storage pp = pool.positions[pm[i]];
            uint256 price = _getPrice(pm[i]);
            int256 s = pp.size;
            equity += _pnl(s > 0, _abs(s), pp.entryPrice, price);
            exposure += (_abs(s) * price) / NOTIONAL_SCALE;
        }
    }

    /// @dev Whether `lane`'s pool, after inheriting `account` at mark and receiving the payment
    ///      at `discount`, keeps equity >= BACKSTOP_MARGIN_BPS of its (netted) exposure.
    function _poolCanTake(uint8 lane, address account, uint16 discount) internal view returns (bool) {
        BackstopPool storage pool = _poolStore(lane);
        (int256 equity, uint256 exposure, uint256 notionalIn) = _poolExposureAfter(pool, account);
        equity += _toInt((notionalIn * discount) / BPS);
        return equity >= 0 && uint256(equity) * BPS >= exposure * BACKSTOP_MARGIN_BPS;
    }

    function _poolExposureAfter(BackstopPool storage pool, address account)
        internal
        view
        returns (int256 equity, uint256 exposure, uint256 notionalIn)
    {
        equity = pool.cash;
        bytes32[] storage pm = pool.markets;
        for (uint256 i; i < pm.length; ++i) {
            PoolPosition storage pp = pool.positions[pm[i]];
            uint256 price = _getPrice(pm[i]);
            int256 s = pp.size;
            equity += _pnl(s > 0, _abs(s), pp.entryPrice, price);
            s += _signedSize(_positions[account][pm[i]]);
            exposure += (_abs(s) * price) / NOTIONAL_SCALE;
        }
        bytes32[] storage tm = _accounts[account].openMarkets;
        for (uint256 i; i < tm.length; ++i) {
            uint256 n = (_positions[account][tm[i]].size * _getPrice(tm[i])) / NOTIONAL_SCALE;
            notionalIn += n;
            if (pool.positions[tm[i]].size == 0) exposure += n;
        }
    }

    function _signedSize(Position storage p) internal view returns (int256) {
        int256 s = _toInt(p.size);
        return p.isLong ? s : -s;
    }

    /// @dev Add a leg to the pool's aggregate in `m` at `price`: same side -> size-weighted
    ///      average entry; opposite side -> realize PnL on the netted part (flip at `price`).
    function _poolAdd(uint8 lane, bytes32 m, bool isLong, uint256 size, uint256 price) internal {
        BackstopPool storage pool = _poolStore(lane);
        PoolPosition storage pp = pool.positions[m];
        int256 s = pp.size;
        uint256 abs = _abs(s);
        if (s == 0) {
            pool.markets.push(m);
            pp.entryPrice = price;
        } else if ((s > 0) == isLong) {
            pp.entryPrice = (abs * pp.entryPrice + size * price) / (abs + size);
        } else {
            _poolRealize(lane, pool, s > 0, size < abs ? size : abs, pp.entryPrice, price);
            if (size > abs) pp.entryPrice = price;
        }
        pp.size = s + (isLong ? _toInt(size) : -_toInt(size));
        _poolSync(lane, pool, m, s);
    }

    /// @dev Realize pool PnL on `size` at `price` into pool cash, against the lane fund.
    function _poolRealize(
        uint8 lane,
        BackstopPool storage pool,
        bool isLong,
        uint256 size,
        uint256 entry,
        uint256 price
    ) internal returns (int256 pnl) {
        pnl = _pnl(isLong, size, entry, price);
        pool.cash += pnl;
        _settleWithLane(lane, -pnl);
    }

    /// @dev Re-book the pool's open interest in `m` after its size changed from `oldSize`, and
    ///      drop the market from the pool when flat.
    function _poolSync(uint8 lane, BackstopPool storage pool, bytes32 m, int256 oldSize) internal {
        PoolPosition storage pp = pool.positions[m];
        OpenInterest storage oi = _oiStore(lane, m);
        uint256 old = pp.oiNotional;
        if (oldSize > 0) oi.longNotional -= old;
        else if (oldSize < 0) oi.shortNotional -= old;
        int256 s = pp.size;
        if (s == 0) {
            delete pool.positions[m];
            bytes32[] storage pm = pool.markets;
            for (uint256 i; i < pm.length; ++i) {
                if (pm[i] == m) {
                    pm[i] = pm[pm.length - 1];
                    pm.pop();
                    break;
                }
            }
            return;
        }
        uint256 n = (_abs(s) * pp.entryPrice) / NOTIONAL_SCALE;
        if (s > 0) oi.longNotional += n;
        else oi.shortNotional += n;
        pp.oiNotional = n;
    }

    /// @dev A flat pool with negative cash is insolvent: write the deficit off against the lane.
    function _poolWriteOffNegative(uint8 lane, BackstopPool storage pool) internal {
        int256 cash = pool.cash;
        if (cash >= 0 || pool.markets.length != 0) return;
        pool.cash = 0;
        _debitLane(lane, uint256(-cash));
    }

    function _u96(uint256 x) internal pure returns (uint96) {
        if (x > type(uint96).max) revert AmountTooLarge();
        return uint96(x);
    }

    /// @dev If an account with no positions has negative collateral, the lane eats it.
    function _writeOffNegative(address account, uint8 lane) internal returns (uint256 shortfall) {
        int256 coll = _accounts[account].collateral;
        if (coll >= 0) return 0;
        shortfall = uint256(-coll);
        _adjustCollateral(account, lane, -coll);
        _debitLane(lane, shortfall);
        emit BadDebtRealized(lane, account, shortfall);
    }

    /// @dev Inflow to a lane: repay bad debt first, remainder to the insurance fund.
    function _creditLane(uint8 lane, uint256 amount) internal returns (uint256 repaid) {
        Lane storage l = _laneStore(lane);
        repaid = amount < l.badDebt ? amount : l.badDebt;
        l.badDebt -= repaid;
        l.insuranceFund += amount - repaid;
    }

    /// @dev Outflow from a lane: pay from insurance, record any shortfall as lane bad debt.
    function _debitLane(uint8 lane, uint256 amount) internal {
        Lane storage l = _laneStore(lane);
        if (l.insuranceFund >= amount) {
            l.insuranceFund -= amount;
        } else {
            l.badDebt += amount - l.insuranceFund;
            l.insuranceFund = 0;
        }
    }

    function _removeOpenMarket(Account storage acct, bytes32 marketId) internal {
        bytes32[] storage mkts = acct.openMarkets;
        uint256 len = mkts.length;
        for (uint256 i; i < len; ++i) {
            if (mkts[i] == marketId) {
                mkts[i] = mkts[len - 1];
                mkts.pop();
                return;
            }
        }
    }

    /// @dev Page `[offset, offset+limit)` of `list`, keeping entries in `lane` (and, when
    ///      `onlyLiquidatable`, only liquidatable accounts not already in auction).
    function _page(address[] storage list, uint8 lane, uint256 offset, uint256 limit, bool onlyLiquidatable)
        internal
        view
        returns (address[] memory found)
    {
        if (offset >= list.length) return new address[](0);
        uint256 end = offset + limit;
        if (end > list.length) end = list.length;
        found = new address[](end - offset);
        uint256 n;
        for (uint256 i = offset; i < end; ++i) {
            address a = list[i];
            if (laneOf(a) != lane) continue;
            if (onlyLiquidatable && (_auctions[a].active || !isLiquidatable(a))) continue;
            found[n++] = a;
        }
        assembly {
            mstore(found, n)
        }
    }

    function _safeTransfer(address to, uint256 amount) internal {
        (bool ok, bytes memory data) = address(ausd).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = address(ausd).call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
