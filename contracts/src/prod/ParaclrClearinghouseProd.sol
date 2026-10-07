// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

/// @title ParaclrClearinghouseProd
/// @notice PRODUCTION (guarded beta) cross-margin perpetuals clearinghouse for Monad.
///         UNAUDITED BETA · CAPPED · USE ONLY WHAT YOU CAN AFFORD TO LOSE.
///
///   - Collateral and quote asset: real Agora AUSD (6 decimals, immutable address).
///   - Prices: Pyth, verified on chain, expo-normalised to 1e18, rejected if non-positive, if
///     `conf / price > maxConfBps` or if too old. **Per lane and market, prices never move
///     backwards**: every state-changing call uses the NEWEST of (caller-supplied update, the
///     price stored in Pyth, the last price this lane used), and records it as the lane's last
///     price. Only the markets a call actually touches are parsed and validated.
///   - Delayed orders: `commitOrder` escrows margin (a reservation) and a native-MON execution
///     fee; `executeOrder` (anyone) fills at the FIRST Pyth update at/after `execAfter`
///     (`parsePriceFeedUpdatesUnique`); other legs are priced deterministically from Pyth storage
///     / the lane's last price; `cancelOrder` only after the deadline. An order applies only to
///     the position as it was at commit (reduce orders can never increase anything).
///   - Trading fee (paid out of the order's margin on increases), funding from GLOBAL skew via a
///     rate-limited `updateFunding`, caps (leverage, per-account deposit, per-lane TVL, per-lane
///     per-market OI sized against lane INSURANCE, min size).
///   - Fair liquidation: per-block Dutch auction, the pool and external takers are both paid at
///     most the trader's remaining equity; accounts already below zero equity are closed out at
///     once; cure at maintenance; reduce-only orders may de-risk an account in auction.
///     Per-lane backstop pools with share epochs and single-use delayed withdrawals; the pool is
///     the second loss layer and is repaid before insurance.
///   - **Real lane isolation**: AUSD is accounted per lane (`held`). A lane's losses are borne
///     inside the lane: insurance → backstop pool cash → pro-rata haircut on the lane's
///     withdrawals; inflows repay bad debt → the pool → insurance. No lane can withdraw another
///     lane's AUSD.
///   - Admin: owner = TimelockController; guardian = `pause()` only.
///
/// ## Global storage slots and their ONLY writers
///   owner, `pyth`, `guardian`, all params, `_markets` / `_marketIds`, `isBackstopOperator`:
///   the owner (timelock). `paused`: guardian or owner (pause), owner (unpause). `_funding[m]`:
///   `updateFunding` (anyone, rate-limited) and `listMarket`; trades only READ it. Everything else
///   is keyed by lane or by account (incl. the per-lane last-used price `_lanePrice`).
///   Value transfers additionally write shared EVM balances (AUSD `balanceOf(this)`, this
///   contract's native balance); keeper paths move no value while Pyth's update fee is 0.
///
/// ## Solvency identities (exact, invariant-tested)
///   per lane:  ledger.held == ledger.collateral + lane.insurance + pool.cash
///                             + ledger.keeperRewards − lane.badDebt
///   global:    AUSD.balanceOf(this) == Σ_lanes ledger.held                 [+ donations]
///   native:    address(this).balance == Σ_lanes (nativeEscrow + nativeOwed)  [+ forced sends]
///
/// ## Rounding: always against the user / in favour of solvency (see SECURITY_NOTES.md).
contract ParaclrClearinghouseProd is Ownable {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;

    // =====================================================================================
    // Constants
    // =====================================================================================

    uint8 public constant LANE_COUNT = 8;
    uint256 public constant BPS = 10_000;
    /// @notice Maintenance margin: 2.5% of current notional.
    uint256 public constant MAINTENANCE_MARGIN_BPS = 250;
    /// @notice Margin top-ups beyond the deposit caps may restore equity to exactly 100% of initial
    ///         margin (never more: exempt money can then never fund new margin, R3-03).
    uint256 public constant TOP_UP_TARGET_BPS = 10_000;
    /// @notice Hard bound on the price deviation `replaceMarketFeed` may accept while the old feed is
    ///         live (10%).
    uint256 public constant MAX_FEED_SWAP_DEVIATION_BPS = 1_000;
    /// @notice Wider bound once the old feed is provably dead on chain (R3-02): 50%.
    uint256 public constant MAX_DEAD_FEED_SWAP_DEVIATION_BPS = 5_000;
    /// @notice A feed whose Pyth-stored price is older than this (or missing) counts as dead.
    uint256 public constant DEAD_FEED_AGE = 1 hours;
    /// @notice Auction-expiry penalty: 1% of notional, capped at remaining equity.
    uint256 public constant LIQUIDATION_FEE_BPS = 100;
    uint256 public constant KEEPER_SHARE_BPS = 5_000;
    /// @notice A backstop pool keeps equity >= 10% of its exposure (after a take / withdrawal).
    uint256 public constant BACKSTOP_MARGIN_BPS = 1_000;
    uint256 public constant MAX_OPEN_MARKETS = 8;
    uint256 public constant MAX_MARKETS = 8;
    uint256 public constant HARD_MAX_LEVERAGE = 20;
    uint256 public constant MAX_TRADING_FEE_BPS = 100;
    uint256 public constant MAX_FUNDING_BPS_PER_DAY = 10_000;
    uint256 public constant MAX_CONF_BPS_LIMIT = 500;
    uint256 public constant MAX_PRICE_AGE_LIMIT = 60;
    /// @notice Hard cap on the auction discount: well below BACKSTOP_MARGIN_BPS (R-08).
    uint256 public constant MAX_AUCTION_DISCOUNT_BPS = 500;
    uint256 public constant MAX_OI_CAP_MULTIPLIER_BPS = 100_000;
    uint256 public constant MIN_BACKSTOP_DEPOSIT = 1e6;
    /// @notice Minimum first deposit (registers the account).
    uint256 public constant MIN_FIRST_DEPOSIT = 1e6;
    /// @notice A backstop withdrawal request can be executed ONCE during this window after it ripens.
    uint256 public constant BACKSTOP_WITHDRAW_WINDOW = 1 hours;
    uint256 public constant MAX_FUTURE_PUBLISH_SKEW = 5;
    int32 public constant MIN_PRICE_EXPO = -30;
    int32 public constant MAX_PRICE_EXPO = 12;

    uint256 internal constant NOTIONAL_SCALE = 1e30;
    uint256 internal constant FUNDING_SCALE = 1e18;
    uint256 internal constant DEFAULT_BACKSTOP_MIN_DISCOUNT_BPS = 75;
    bytes4 internal constant PANIC_SELECTOR = 0x4e487b71;

    // price-resolution status codes (transient cache)
    uint8 internal constant P_OK = 1;
    uint8 internal constant P_STALE = 2;
    uint8 internal constant P_INVALID = 3;
    uint8 internal constant P_EXPO = 4;
    uint8 internal constant P_CONF = 5;

    // EIP-1153 transient slots.
    bytes32 internal constant REENTRANCY_SLOT = keccak256("paraclr.prod.reentrancy");
    bytes32 internal constant CALL_ID_SLOT = keccak256("paraclr.prod.callId");
    bytes32 internal constant FEE_SPENT_SLOT = keccak256("paraclr.prod.pythFeeSpent");
    bytes32 internal constant PRICE_CACHE_SLOT = keccak256("paraclr.prod.priceCache");
    bytes32 internal constant ORDER_CURRENT_SLOT = keccak256("paraclr.prod.orderMarketCurrent");

    // =====================================================================================
    // Types
    // =====================================================================================

    enum OrderStatus {
        None,
        Pending,
        Executed,
        Failed, // an executor had a valid price but the fill reverted (slippage, margin, caps...)
        Cancelled // cancelled after its deadline; execution fee refunded

    }

    struct Position {
        bool isLong;
        uint64 id; // per-account position id (0 = none); changes whenever a new position is created
        uint256 size; // base units, 1e18
        uint256 entryPrice; // 1e18 AUSD per base unit (size-weighted)
        uint256 entryNotional; // AUSD 1e6: exactly what is booked in lane OI; funding base
        uint256 margin; // AUSD 1e6: initial-margin requirement of this position
        int256 fundingIndex; // funding index at the last settlement
    }

    struct Account {
        int256 collateral; // AUSD 1e6 (signed: may go transiently negative under cross margin)
        uint256 reservedMargin; // escrowed by pending increase orders
        uint64 orderNonce;
        uint64 positionNonce;
        bool registered;
        bytes32[] openMarkets;
    }

    struct Order {
        address account;
        uint64 commitTime;
        OrderStatus status;
        bool reduceOnly; // set at commit: the order reduces / closes the existing position
        bytes32 market;
        int128 sizeDelta; // base units 1e18, > 0 buy, < 0 sell
        uint128 marginDelta; // AUSD 1e6 escrowed for an increase
        uint128 acceptablePrice; // 1e18: max fill price for buys, min for sells
        uint96 executionFee; // native MON (wei)
        uint64 execAfter; // commitTime + minExecDelay (at commit)
        uint64 deadline; // commitTime + maxExecDelay (at commit)
        uint64 positionId; // the position this order applies to (0 = a new position)
    }

    struct Market {
        bool listed;
        bytes32 feedId;
        uint256 skewScale; // AUSD 1e6
        uint256 maxLaneOi; // AUSD 1e6: absolute per-lane per-side OI cap
        uint256 maxFundingBpsPerDay;
        string symbol;
    }

    /// @dev One slot per market. Written only by `updateFunding` (and `listMarket`).
    struct Funding {
        int128 index;
        int64 ratePerSec;
        uint64 lastUpdate;
    }

    /// @dev One slot per lane and market: the newest price this lane has used (monotonic).
    struct LanePrice {
        uint128 price; // 1e18
        uint64 publishTime;
    }

    struct Lane {
        uint256 insuranceFund;
        uint256 badDebt;
        uint256 totalLiquidations;
        uint256 lastSettledAt;
        uint256 poolAbsorbed; // pool cash consumed by the loss waterfall, repaid before insurance (R2-08)
    }

    struct LaneLedger {
        int256 collateral; // Σ trader collateral in the lane (signed)
        uint256 keeperRewards; // AUSD owed to keepers (expiry penalty share)
        uint256 nativeEscrow; // MON held for pending orders' execution fees
        uint256 nativeOwed; // MON owed to executors / refund recipients (claimable)
        uint256 held; // AUSD attributable to this lane (in − out)
    }

    struct OpenInterest {
        uint256 longNotional;
        uint256 shortNotional;
    }

    struct Auction {
        bool active;
        uint64 startBlock;
        uint32 index;
    }

    struct AuctionCounters {
        uint64 started;
        uint64 taken;
        uint64 cancelled;
        uint64 expired;
    }

    struct PoolPosition {
        int256 size;
        uint256 entryPrice;
        uint256 oiNotional;
        int256 fundingIndex;
    }

    struct PoolStats {
        uint64 taken;
        uint96 discountEarned;
        uint96 notionalAbsorbed;
    }

    struct WithdrawRequest {
        uint128 shares;
        uint64 readyAt;
        uint64 epoch;
    }

    struct BackstopPool {
        int256 cash;
        uint256 totalShares;
        uint256 minDiscountBps;
        uint64 epoch; // bumped when an insolvent flat pool retires its shares (R-03)
        PoolStats stats;
        bytes32[] markets;
        mapping(bytes32 => PoolPosition) positions;
        mapping(uint64 => mapping(address => uint256)) shares; // epoch => lp => shares
        mapping(address => WithdrawRequest) requests;
    }

    struct TakeVars {
        uint16 discount;
        uint256 blocks;
        uint256 notional;
        uint256 payment;
        uint256 residual;
        uint256 shortfall;
    }

    struct Fill {
        address account;
        bytes32 market;
        uint8 lane;
        bool buy;
        uint256 absDelta;
        uint256 price;
        uint256 marginDelta;
        uint256 tradeNotional;
        uint256 fee;
    }

    struct FillResult {
        uint256 tradingFee;
        int256 realizedPnl;
    }

    /// @dev Markets a call touches (deduplicated, at most MAX_MARKETS).
    struct MarketSet {
        bytes32[] items;
        uint256 n;
    }

    // =====================================================================================
    // Storage
    // =====================================================================================

    IERC20 public immutable ausd;
    IPyth public pyth;
    address public guardian;
    bool public paused;

    uint256 public maxLeverage;
    uint256 public tradingFeeBps;
    uint256 public minPositionNotional;
    uint256 public maxDepositPerAccount;
    uint256 public maxTvlPerLane;
    uint256 public oiCapMultiplierBps;
    /// @notice Max age of a caller-supplied Pyth update.
    uint256 public maxPriceAge;
    /// @notice Max age of a Pyth-STORED price and of a lane's last-used price.
    uint256 public maxStoredPriceAge;
    uint256 public maxConfBps;
    uint256 public minExecDelay;
    uint256 public maxExecDelay;
    uint256 public minExecutionFee;
    uint256 public fundingUpdateInterval;
    uint256 public backstopWithdrawDelay;
    uint16 public auctionStepBps;
    uint16 public auctionMaxDiscountBps;

    /// @notice operator => lane => may call `backstopReduce` on that lane's pool.
    mapping(address => mapping(uint8 => bool)) public isBackstopOperator;

    mapping(bytes32 => Market) internal _markets;
    bytes32[] internal _marketIds;
    mapping(bytes32 => Funding) internal _funding;

    mapping(address => Account) internal _accounts;
    mapping(address => mapping(bytes32 => Position)) internal _positions;
    mapping(address => Auction) internal _auctions;
    mapping(uint256 => Order) internal _orders;
    mapping(address => mapping(bytes32 => uint256)) internal _pendingOrder;

    mapping(uint8 => address[]) internal _laneAccounts;
    Lane[8] internal _lanes;
    LaneLedger[8] internal _ledgers;
    AuctionCounters[8] internal _auctionCounters;
    mapping(uint8 => mapping(bytes32 => OpenInterest)) internal _laneOI;
    mapping(uint8 => mapping(bytes32 => LanePrice)) internal _lanePrice;
    mapping(uint8 => address[]) internal _auctionList;
    mapping(uint8 => BackstopPool) internal _pools;
    mapping(address => mapping(uint8 => uint256)) internal _keeperLaneRewards;
    mapping(address => mapping(uint8 => uint256)) internal _nativeOwed;

    // =====================================================================================
    // Events
    // =====================================================================================

    event PythUpdated(address indexed pyth);
    event GuardianUpdated(address indexed guardian);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event MarketListed(bytes32 indexed marketId, string symbol, bytes32 feedId);
    event MarketFeedReplaced(bytes32 indexed marketId, bytes32 oldFeedId, bytes32 newFeedId, uint256 newPrice);
    event MarketConfigUpdated(
        bytes32 indexed marketId, bytes32 feedId, uint256 skewScale, uint256 maxLaneOi, uint256 maxFundingBpsPerDay
    );
    event RiskParamsUpdated(uint256 maxLeverage, uint256 tradingFeeBps, uint256 minPositionNotional);
    event CapsUpdated(uint256 maxDepositPerAccount, uint256 maxTvlPerLane, uint256 oiCapMultiplierBps);
    event OracleParamsUpdated(uint256 maxPriceAge, uint256 maxStoredPriceAge, uint256 maxConfBps);
    event OrderParamsUpdated(uint256 minExecDelay, uint256 maxExecDelay, uint256 minExecutionFee);
    event FundingParamsUpdated(uint256 fundingUpdateInterval);
    event BackstopParamsUpdated(uint256 withdrawDelay);
    event AuctionParamsUpdated(uint16 stepBps, uint16 maxDiscountBps);
    event BackstopMinDiscountUpdated(uint8 indexed lane, uint16 bps);
    event BackstopOperatorSet(address indexed operator, uint8 indexed lane, bool allowed);

    event AccountRegistered(address indexed account, uint8 indexed lane);
    event Deposit(address indexed account, uint8 indexed lane, uint256 amount);
    /// @notice `amount` is what was paid out (after any lane haircut).
    event Withdraw(address indexed account, uint8 indexed lane, uint256 amount);
    /// @notice A lane with bad debt paid `paid` for a claim of `debited` (pro-rata haircut).
    event LaneHaircut(uint8 indexed lane, address indexed account, uint256 debited, uint256 paid);
    event LaneFunded(uint8 indexed lane, address indexed funder, uint256 amount, uint256 debtRepaid);
    event KeeperRewardsClaimed(address indexed keeper, uint256 amount);
    event ExecutionFeesClaimed(address indexed account, uint256 amount);
    event ExecutionFeeCredited(address indexed to, uint8 indexed lane, uint256 indexed orderId, uint256 amount);

    event OrderCommitted(
        uint256 indexed orderId,
        address indexed account,
        bytes32 indexed market,
        uint8 lane,
        int256 sizeDelta,
        uint256 marginDelta,
        uint256 acceptablePrice,
        uint256 executionFee,
        uint256 execAfter,
        uint256 deadline
    );
    event OrderExecuted(
        uint256 indexed orderId,
        address indexed account,
        bytes32 indexed market,
        address executor,
        uint256 fillPrice,
        uint256 publishTime,
        int256 sizeDelta,
        uint256 tradingFee,
        int256 realizedPnl,
        uint256 executionFee
    );
    event OrderFailed(
        uint256 indexed orderId, address indexed account, bytes32 indexed market, address executor, bytes reason
    );
    event OrderCancelled(
        uint256 indexed orderId, address indexed account, bytes32 indexed market, address caller, uint256 feeRefunded
    );
    event PositionUpdated(
        address indexed account,
        uint8 indexed lane,
        bytes32 indexed market,
        bool isLong,
        uint256 size,
        uint256 entryPrice,
        uint256 entryNotional,
        uint256 margin,
        uint256 price,
        int256 realizedPnl
    );
    event FundingSettled(address indexed account, uint8 indexed lane, bytes32 indexed market, int256 amount);
    event BackstopFundingSettled(uint8 indexed lane, bytes32 indexed market, int256 amount);
    event FundingUpdated(bytes32 indexed market, int256 ratePerSec, int256 index, int256 skewNotional);
    event BadDebtRealized(uint8 indexed lane, address indexed account, uint256 amount);
    /// @notice A lane outflow insurance could not cover was paid from the lane's pool cash.
    event BackstopLossAbsorbed(uint8 indexed lane, uint256 amount);
    /// @notice A lane inflow repaid pool cash the waterfall had consumed (before insurance).
    event BackstopRepaid(uint8 indexed lane, uint256 amount);
    /// @notice A flat pool's negative cash was covered by the lane up to what it owed the pool: the
    ///         receivable is reduced by `amount` and the lane absorbs that much of the deficit (R3-01).
    event BackstopReceivableNetted(uint8 indexed lane, uint256 amount);
    /// @notice The last LP left: orphaned pool cash went to the lane (bad debt, then insurance) and
    ///         the pool's receivable was forgiven, so a next depositor cannot capture either (R3-01).
    event BackstopSwept(uint8 indexed lane, uint256 cash, uint256 receivableForgiven);
    /// @notice A batch skipped `account` because one of its markets has no usable price.
    event AccountSkipped(uint8 indexed lane, address indexed account);

    event AuctionStarted(
        uint8 indexed lane, address indexed account, uint256 startBlock, int256 equity, uint256 notional
    );
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
    event AuctionExpired(uint8 indexed lane, address indexed account, int256 equity, uint256 badDebt);
    event BackstopDeposit(uint8 indexed lane, address indexed lp, uint256 amount, uint256 shares);
    event BackstopWithdrawRequested(uint8 indexed lane, address indexed lp, uint256 shares, uint256 readyAt);
    /// @notice `amount` is what was paid out (after any lane haircut).
    event BackstopWithdraw(uint8 indexed lane, address indexed lp, uint256 shares, uint256 amount);
    event BackstopReduced(uint8 indexed lane, bytes32 indexed market, uint256 size, uint256 price, int256 realizedPnl);
    /// @notice An insolvent flat pool retired all shares (they are now worth 0); `epoch` is the new epoch.
    event BackstopPoolReset(uint8 indexed lane, uint64 epoch, uint256 retiredShares, uint256 deficit);

    // =====================================================================================
    // Errors
    // =====================================================================================

    error ZeroAddress();
    error ZeroAmount();
    error Unauthorized();
    error RenounceDisabled();
    error Reentrancy();
    error IsPaused();
    error NotPaused();
    error InvalidParam();
    error InvalidLane(uint8 lane);
    error TooManyMarkets();
    error FeedAlreadyUsed(bytes32 feedId);
    error FeedNotOnPyth(bytes32 feedId);
    error MarketHasOpenInterest(bytes32 market);
    error FeedSwapDeviation(uint8 lane, uint256 referencePrice, uint256 newPrice);
    error NoReferencePrice(bytes32 market);
    error BackstopReceivableOutstanding(uint8 lane, uint256 receivable);
    error BackstopGainCapBinding(uint8 lane, int256 unrealized, uint256 insurance);
    error BackstopPositionsOpen(uint8 lane);
    error CollateralAboveCap(int256 collateral, uint256 cap);
    error MarginAboveNotional(uint256 margin, uint256 notional);
    error MarketNotListed(bytes32 market);
    error MarketAlreadyListed(bytes32 market);
    error NotRegistered(address account);
    error AccountNotInLane(address account, uint8 lane);
    error InvalidPrice(bytes32 market);
    error InvalidPriceExpo(int32 expo);
    error PriceConfidenceTooWide(bytes32 market, uint256 conf, uint256 price);
    error StalePrice(bytes32 market, uint256 publishTime);
    error InvalidPythResponse();
    error InsufficientPythFee(uint256 provided, uint256 required);
    error RefundFailed();
    error TransferAmountMismatch(uint256 expected, uint256 actual);
    error DepositTooSmall(uint256 amount, uint256 minimum);
    error DepositCapExceeded(int256 balanceAfter, uint256 cap);
    error LaneTvlCapExceeded(uint256 tvlAfter, uint256 cap);
    error LaneInDeficit(uint8 lane);
    error LaneInsolvent(uint8 lane, uint256 held);
    error InsufficientFreeCollateral(uint256 requested, uint256 available);
    error InsufficientCollateral(uint256 committed, int256 collateral);
    error ExecutionFeeTooLow(uint256 provided, uint256 minimum);
    error InvalidAcceptablePrice();
    error OrderAlreadyPending(uint256 orderId);
    error OrderNotPending(uint256 orderId);
    error OrderNotReady(uint256 orderId, uint256 execAfter);
    error OrderExpired(uint256 orderId, uint256 deadline);
    error OrderNotExpired(uint256 orderId, uint256 deadline);
    error OrderWouldFlip();
    error PositionChanged(uint64 expected, uint64 actual);
    error MarginOnReduce();
    error MarginRequired();
    error SlippageExceeded(uint256 fillPrice, uint256 acceptablePrice);
    error LeverageTooHigh(uint256 notional, uint256 margin);
    error BelowMinPositionSize(uint256 notional, uint256 minimum);
    error OiCapExceeded(uint256 oiAfter, uint256 cap);
    error TooManyOpenMarkets();
    error PositionExists(bytes32 market);
    error NoPosition(bytes32 market);
    error InsufficientMargin(int256 equity, uint256 required);
    error FundingUpdateTooSoon(uint256 nextUpdate);
    error AccountInAuction(address account);
    error NotInAuction(address account);
    error NotLiquidatable(address account);
    error SelfTake();
    error InvalidBps();
    error InsufficientShares(uint256 requested, uint256 available);
    error BackstopInsolvent(uint8 lane);
    error BackstopMarginBreached(int256 equityAfter, uint256 required);
    error InsufficientBackstopCash(uint256 requested, int256 cash);
    error NoWithdrawRequest(uint8 lane, address lp);
    error WithdrawNotReady(uint256 readyAt);
    error WithdrawRequestExpired(uint256 expiredAt);
    error AmountTooLarge();

    // =====================================================================================
    // Modifiers
    // =====================================================================================

    modifier nonReentrant() {
        _enter();
        _;
        _exit();
    }

    /// @dev Refund `msg.value` minus the Pyth fees actually forwarded (last effect of the call).
    modifier refundsExcess() {
        _;
        _refundExcess();
    }

    modifier validLane(uint8 lane) {
        _checkLane(lane);
        _;
    }

    // =====================================================================================
    // Constructor
    // =====================================================================================

    constructor(address initialOwner, IERC20 ausd_, IPyth pyth_) Ownable(initialOwner) {
        if (address(ausd_) == address(0) || address(pyth_) == address(0)) revert ZeroAddress();
        if (address(ausd_).code.length == 0 || address(pyth_).code.length == 0) revert InvalidParam();
        if (IERC20Metadata(address(ausd_)).decimals() != 6) revert InvalidParam();
        ausd = ausd_;
        pyth = pyth_;
        maxLeverage = 10;
        tradingFeeBps = 5;
        minPositionNotional = 10e6;
        maxDepositPerAccount = 50e6;
        maxTvlPerLane = 500e6;
        oiCapMultiplierBps = 50_000; // 5x lane insurance
        maxPriceAge = 30;
        maxStoredPriceAge = 15;
        maxConfBps = 200;
        minExecDelay = 3;
        maxExecDelay = 60;
        minExecutionFee = 0.1 ether;
        fundingUpdateInterval = 60;
        backstopWithdrawDelay = 1 hours;
        auctionStepBps = 25;
        auctionMaxDiscountBps = 500;
        for (uint8 k; k < LANE_COUNT; ++k) {
            _pools[k].minDiscountBps = DEFAULT_BACKSTOP_MIN_DISCOUNT_BPS;
        }
        emit PythUpdated(address(pyth_));
        emit RiskParamsUpdated(10, 5, 10e6);
        emit CapsUpdated(50e6, 500e6, 50_000);
        emit OracleParamsUpdated(30, 15, 200);
        emit OrderParamsUpdated(3, 60, 0.1 ether);
        emit FundingParamsUpdated(60);
        emit BackstopParamsUpdated(1 hours);
        emit AuctionParamsUpdated(25, 500);
    }

    // =====================================================================================
    // Admin (owner = TimelockController; guardian = pause only)
    // =====================================================================================

    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /// @notice Emergency pause (guardian or owner). Blocks fresh deposits (accounts without
    ///         positions), pool deposits, and committing / executing increase orders. Withdrawals,
    ///         margin top-ups, reduce / close orders, cancels, liquidations, pool withdrawals,
    ///         funding updates and claims keep working (see SECURITY_NOTES for why outflows stay
    ///         open).
    function pause() external {
        if (msg.sender != guardian && msg.sender != owner()) revert Unauthorized();
        if (paused) revert IsPaused();
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        if (!paused) revert NotPaused();
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianUpdated(guardian_);
    }

    /// @notice Oracle change (timelock). The new contract must expose every listed feed and the
    ///         update-fee interface.
    function setPyth(IPyth pyth_) external onlyOwner {
        if (address(pyth_).code.length == 0) revert InvalidParam();
        pyth_.getUpdateFee(new bytes[](0));
        for (uint256 i; i < _marketIds.length; ++i) {
            bytes32 feed = _markets[_marketIds[i]].feedId;
            try pyth_.getPriceUnsafe(feed) returns (PythStructs.Price memory) {}
            catch {
                revert FeedNotOnPyth(feed);
            }
        }
        pyth = pyth_;
        emit PythUpdated(address(pyth_));
    }

    function listMarket(
        string calldata symbol,
        bytes32 feedId,
        uint256 skewScale,
        uint256 maxLaneOi,
        uint256 maxFundingBpsPerDay
    ) external onlyOwner returns (bytes32 marketId) {
        marketId = keccak256(bytes(symbol));
        if (_markets[marketId].listed) revert MarketAlreadyListed(marketId);
        if (_marketIds.length >= MAX_MARKETS) revert TooManyMarkets();
        Market storage m = _markets[marketId];
        m.listed = true;
        m.symbol = symbol;
        _marketIds.push(marketId);
        _configureMarket(marketId, feedId, skewScale, maxLaneOi, maxFundingBpsPerDay);
        _funding[marketId] = Funding(0, 0, uint64(block.timestamp));
        emit MarketListed(marketId, symbol, feedId);
    }

    /// @notice Re-configure a listed market. A feed change here needs zero open interest; with open
    ///         interest use `replaceMarketFeed` (price-checked).
    function setMarketConfig(
        bytes32 marketId,
        bytes32 feedId,
        uint256 skewScale,
        uint256 maxLaneOi,
        uint256 maxFundingBpsPerDay
    ) external onlyOwner {
        Market storage m = _markets[marketId];
        if (!m.listed) revert MarketNotListed(marketId);
        if (feedId != m.feedId) {
            for (uint8 k; k < LANE_COUNT; ++k) {
                OpenInterest storage oi = _laneOI[k][marketId];
                if (oi.longNotional != 0 || oi.shortNotional != 0) revert MarketHasOpenInterest(marketId);
            }
            _resetLanePrices(marketId);
        }
        _configureMarket(marketId, feedId, skewScale, maxLaneOi, maxFundingBpsPerDay);
    }

    /// @notice Dead-feed recovery (R2-02), timelock only: point `marketId` at `newFeedId` even with
    ///         open interest. The new feed's Pyth-stored price must be valid and fresh (<=
    ///         `maxStoredPriceAge`) and within `maxDeviationBps` of the market's newest price in
    ///         EVERY lane that has open interest (the lane's last-used price; the old feed's last
    ///         stored price if a lane never recorded one). `maxDeviationBps` may be up to 10% while
    ///         the old feed is live, and up to 50% once it is provably dead on chain (its stored
    ///         price is missing or older than `DEAD_FEED_AGE`, R3-02). Lane price markers of the
    ///         market are reset (they belong to the old feed). Procedure: SECURITY_NOTES §4.
    function replaceMarketFeed(bytes32 marketId, bytes32 newFeedId, uint256 maxDeviationBps) external onlyOwner {
        Market storage m = _markets[marketId];
        if (!m.listed) revert MarketNotListed(marketId);
        bytes32 oldFeed = m.feedId;
        uint256 maxAllowed = _feedIsDead(oldFeed) ? MAX_DEAD_FEED_SWAP_DEVIATION_BPS : MAX_FEED_SWAP_DEVIATION_BPS;
        if (newFeedId == bytes32(0) || newFeedId == oldFeed || maxDeviationBps == 0 || maxDeviationBps > maxAllowed) {
            revert InvalidParam();
        }
        for (uint256 i; i < _marketIds.length; ++i) {
            if (_markets[_marketIds[i]].feedId == newFeedId) revert FeedAlreadyUsed(newFeedId);
        }
        uint256 newPrice = _freshFeedPrice(marketId, newFeedId);
        _checkFeedSwapDeviation(marketId, _oldFeedReference(marketId, oldFeed), newPrice, maxDeviationBps);
        _resetLanePrices(marketId);
        m.feedId = newFeedId;
        emit MarketFeedReplaced(marketId, oldFeed, newFeedId, newPrice);
        emit MarketConfigUpdated(marketId, newFeedId, m.skewScale, m.maxLaneOi, m.maxFundingBpsPerDay);
    }

    /// @dev The new feed's Pyth-stored price: must be valid and no older than `maxStoredPriceAge`.
    function _freshFeedPrice(bytes32 marketId, bytes32 feed) internal view returns (uint256 price) {
        (bool ok, PythStructs.Price memory p) = _storedPythPrice(feed);
        if (!ok) revert FeedNotOnPyth(feed);
        (uint8 st, uint256 a, uint256 b) = _check(p);
        if (st != P_OK) _revertPrice(marketId, st, p.publishTime, a, b);
        if (_age(p.publishTime) > maxStoredPriceAge) revert StalePrice(marketId, p.publishTime);
        return a;
    }

    /// @dev Every lane with open interest: |newPrice - reference| <= maxDeviationBps of the
    ///      reference (the lane's last-used price, else the old feed's last stored price).
    function _checkFeedSwapDeviation(bytes32 marketId, uint256 oldRef, uint256 newPrice, uint256 maxDeviationBps)
        internal
        view
    {
        for (uint8 k; k < LANE_COUNT; ++k) {
            OpenInterest storage oi = _laneOI[k][marketId];
            if (oi.longNotional == 0 && oi.shortNotional == 0) continue;
            uint256 ref = _lanePrice[k][marketId].price;
            if (ref == 0) ref = oldRef;
            if (ref == 0) revert NoReferencePrice(marketId);
            uint256 diff = newPrice > ref ? newPrice - ref : ref - newPrice;
            if (diff * BPS > ref * maxDeviationBps) revert FeedSwapDeviation(k, ref, newPrice);
        }
    }

    /// @dev Provably dead: Pyth has no stored price for the feed, the stored one is older than
    ///      `DEAD_FEED_AGE`, or it is unusable (fails `_check`: non-positive, bad exponent, confidence
    ///      wider than `maxConfBps`), i.e. a "zombie" feed that publishes but never prices (R4-04).
    function _feedIsDead(bytes32 feed) internal view returns (bool) {
        (bool ok, PythStructs.Price memory p) = _storedPythPrice(feed);
        if (!ok || p.publishTime + DEAD_FEED_AGE < block.timestamp) return true;
        (uint8 st,,) = _check(p);
        return st != P_OK;
    }

    /// @dev Reference for a lane that never recorded a price: the old feed's last stored price
    ///      (normalised; age AND confidence ignored, since it only has to catch a wrong-asset feed,
    ///      so a wide-confidence zombie still provides one, R4-04), else the market's newest marker
    ///      in any lane; 0 if neither exists.
    function _oldFeedReference(bytes32 marketId, bytes32 feed) internal view returns (uint256 ref) {
        (bool ok, PythStructs.Price memory p) = _storedPythPrice(feed);
        if (ok && p.price > 0 && p.expo >= MIN_PRICE_EXPO && p.expo <= MAX_PRICE_EXPO) {
            ref = _scale(uint256(uint64(p.price)), p.expo);
            if (ref != 0 && ref <= type(uint128).max) return ref;
        }
        ref = 0;
        uint256 newest;
        for (uint8 k; k < LANE_COUNT; ++k) {
            LanePrice memory lp = _lanePrice[k][marketId];
            if (lp.publishTime > newest) {
                newest = lp.publishTime;
                ref = lp.price;
            }
        }
    }

    function _resetLanePrices(bytes32 marketId) internal {
        for (uint8 k; k < LANE_COUNT; ++k) {
            delete _lanePrice[k][marketId];
        }
    }

    function _configureMarket(
        bytes32 marketId,
        bytes32 feedId,
        uint256 skewScale,
        uint256 maxLaneOi,
        uint256 maxFundingBpsPerDay
    ) internal {
        if (feedId == bytes32(0) || skewScale == 0 || maxFundingBpsPerDay > MAX_FUNDING_BPS_PER_DAY) {
            revert InvalidParam();
        }
        for (uint256 i; i < _marketIds.length; ++i) {
            bytes32 other = _marketIds[i];
            if (other != marketId && _markets[other].feedId == feedId) revert FeedAlreadyUsed(feedId);
        }
        (bool exists,) = _storedPythPrice(feedId);
        if (!exists) revert FeedNotOnPyth(feedId);
        Market storage m = _markets[marketId];
        m.feedId = feedId;
        m.skewScale = skewScale;
        m.maxLaneOi = maxLaneOi;
        m.maxFundingBpsPerDay = maxFundingBpsPerDay;
        emit MarketConfigUpdated(marketId, feedId, skewScale, maxLaneOi, maxFundingBpsPerDay);
    }

    function setRiskParams(uint256 maxLeverage_, uint256 tradingFeeBps_, uint256 minPositionNotional_)
        external
        onlyOwner
    {
        if (maxLeverage_ == 0 || maxLeverage_ > HARD_MAX_LEVERAGE || tradingFeeBps_ > MAX_TRADING_FEE_BPS) {
            revert InvalidParam();
        }
        maxLeverage = maxLeverage_;
        tradingFeeBps = tradingFeeBps_;
        minPositionNotional = minPositionNotional_;
        emit RiskParamsUpdated(maxLeverage_, tradingFeeBps_, minPositionNotional_);
    }

    function setCaps(uint256 maxDepositPerAccount_, uint256 maxTvlPerLane_, uint256 oiCapMultiplierBps_)
        external
        onlyOwner
    {
        if (oiCapMultiplierBps_ > MAX_OI_CAP_MULTIPLIER_BPS) revert InvalidParam();
        maxDepositPerAccount = maxDepositPerAccount_;
        maxTvlPerLane = maxTvlPerLane_;
        oiCapMultiplierBps = oiCapMultiplierBps_;
        emit CapsUpdated(maxDepositPerAccount_, maxTvlPerLane_, oiCapMultiplierBps_);
    }

    /// @dev Both ages in [5, 60] s; confidence in (0, 5%].
    function setOracleParams(uint256 maxPriceAge_, uint256 maxStoredPriceAge_, uint256 maxConfBps_)
        external
        onlyOwner
    {
        if (
            maxPriceAge_ < 5 || maxPriceAge_ > MAX_PRICE_AGE_LIMIT || maxStoredPriceAge_ < 5
                || maxStoredPriceAge_ > MAX_PRICE_AGE_LIMIT || maxConfBps_ == 0 || maxConfBps_ > MAX_CONF_BPS_LIMIT
        ) revert InvalidParam();
        maxPriceAge = maxPriceAge_;
        maxStoredPriceAge = maxStoredPriceAge_;
        maxConfBps = maxConfBps_;
        emit OracleParamsUpdated(maxPriceAge_, maxStoredPriceAge_, maxConfBps_);
    }

    function setOrderParams(uint256 minExecDelay_, uint256 maxExecDelay_, uint256 minExecutionFee_)
        external
        onlyOwner
    {
        if (
            minExecDelay_ == 0 || minExecDelay_ > 60 || maxExecDelay_ < minExecDelay_ + 5 || maxExecDelay_ > 1 hours
                || minExecutionFee_ > type(uint96).max
        ) revert InvalidParam();
        minExecDelay = minExecDelay_;
        maxExecDelay = maxExecDelay_;
        minExecutionFee = minExecutionFee_;
        emit OrderParamsUpdated(minExecDelay_, maxExecDelay_, minExecutionFee_);
    }

    function setFundingParams(uint256 fundingUpdateInterval_) external onlyOwner {
        if (fundingUpdateInterval_ < 10 || fundingUpdateInterval_ > 1 days) revert InvalidParam();
        fundingUpdateInterval = fundingUpdateInterval_;
        emit FundingParamsUpdated(fundingUpdateInterval_);
    }

    /// @dev LP withdrawal delay in [1 min, 7 days].
    function setBackstopParams(uint256 withdrawDelay) external onlyOwner {
        if (withdrawDelay < 1 minutes || withdrawDelay > 7 days) revert InvalidParam();
        backstopWithdrawDelay = withdrawDelay;
        emit BackstopParamsUpdated(withdrawDelay);
    }

    /// @notice Auction clock: `stepBps` per block, capped at `maxDiscountBps` (<= 5%).
    function setAuctionParams(uint16 stepBps, uint16 maxDiscountBps) external onlyOwner {
        if (stepBps == 0 || maxDiscountBps < stepBps || maxDiscountBps > MAX_AUCTION_DISCOUNT_BPS) revert InvalidBps();
        auctionStepBps = stepBps;
        auctionMaxDiscountBps = maxDiscountBps;
        emit AuctionParamsUpdated(stepBps, maxDiscountBps);
    }

    function setBackstopMinDiscount(uint8 lane, uint16 bps) external onlyOwner validLane(lane) {
        if (bps > BPS) revert InvalidBps();
        _pools[lane].minDiscountBps = bps;
        emit BackstopMinDiscountUpdated(lane, bps);
    }

    /// @notice Grant / revoke the role that may call `backstopReduce` on ONE lane's pool.
    function setBackstopOperator(address operator, uint8 lane, bool allowed) external onlyOwner validLane(lane) {
        if (operator == address(0)) revert ZeroAddress();
        isBackstopOperator[operator][lane] = allowed;
        emit BackstopOperatorSet(operator, lane, allowed);
    }

    // =====================================================================================
    // Collateral
    // =====================================================================================

    /// @notice Deposit AUSD (requires `approve`). Credits the balance delta.
    ///         Caps: the account's collateral <= `maxDepositPerAccount`, the lane's TVL <=
    ///         `maxTvlPerLane`, >= 1 AUSD to register, refused while the lane has bad debt.
    ///         **Margin top-up exemption** (R2-01): an account holding positions whose equity is
    ///         BELOW its initial margin may deposit, outside the caps, up to the amount that brings
    ///         equity back to its initial margin (`topUpAllowance`, needs usable prices; use
    ///         `depositWithPrice` when Pyth storage is stale); only the rest of the deposit is
    ///         subject to the caps. Pause blocks accounts without positions.
    function deposit(uint256 amount) external nonReentrant {
        _deposit(amount);
    }

    /// @notice `deposit` with a Pyth update for the account's markets (R3-04): the margin top-up
    ///         exemption (`topUpAllowance`) is computed at the lane's monotonic fresh prices even when
    ///         Pyth storage is stale. `priceUpdate` is ignored for accounts without positions. Pay
    ///         `IPyth.getUpdateFee(priceUpdate)`; excess refunded.
    function depositWithPrice(uint256 amount, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
        refundsExcess
    {
        if (_accounts[msg.sender].openMarkets.length != 0) {
            MarketSet memory s = _newSet();
            _addAccountMarkets(s, msg.sender);
            _beginPricing(laneOf(msg.sender), priceUpdate, s);
        }
        _deposit(amount);
    }

    function _deposit(uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        Account storage acct = _accounts[msg.sender];
        uint8 lane = laneOf(msg.sender);
        if (acct.openMarkets.length == 0 && paused) revert IsPaused();
        uint256 exempt = topUpAllowance(msg.sender);
        if (exempt > amount) exempt = amount;
        uint256 capped = amount - exempt;
        if (capped != 0) {
            if (_lanes[lane].badDebt != 0) revert LaneInDeficit(lane);
            if (!acct.registered && amount < MIN_FIRST_DEPOSIT) revert DepositTooSmall(amount, MIN_FIRST_DEPOSIT);
            int256 after_ = acct.collateral + capped.toInt256();
            if (after_ > maxDepositPerAccount.toInt256()) revert DepositCapExceeded(after_, maxDepositPerAccount);
            uint256 tvlAfter = laneTvl(lane) + capped;
            if (tvlAfter > maxTvlPerLane) revert LaneTvlCapExceeded(tvlAfter, maxTvlPerLane);
        }
        uint256 received = _pullAusd(msg.sender, amount);
        if (!acct.registered) {
            acct.registered = true;
            _laneAccounts[lane].push(msg.sender);
            emit AccountRegistered(msg.sender, lane);
        }
        _ledgers[lane].held += received;
        _adjustCollateral(msg.sender, lane, received.toInt256());
        emit Deposit(msg.sender, lane, received);
    }

    /// @notice How much `account` may deposit OUTSIDE the deposit caps right now: if it holds
    ///         positions and its equity is below its initial margin, the amount that brings equity
    ///         back to its initial margin; else 0. Uses the lane's current prices (or the prices
    ///         resolved by `depositWithPrice`); 0 if a leg has no usable price.
    function topUpAllowance(address account) public view returns (uint256) {
        Account storage acct = _accounts[account];
        bytes32[] storage mkts = acct.openMarkets;
        if (mkts.length == 0) return 0;
        uint8 lane = laneOf(account);
        int256 equity = acct.collateral;
        uint256 im;
        for (uint256 i; i < mkts.length; ++i) {
            bytes32 m = mkts[i];
            (uint8 st,, uint256 price,) = _lookup(lane, m);
            if (st != P_OK) return 0;
            Position storage pos = _positions[account][m];
            equity += _pnl(pos.isLong, pos.size, pos.entryPrice, price);
            equity += _fundingCredit(pos.isLong, pos.entryNotional, pos.fundingIndex, _fundingIndexNow(m));
            im += pos.margin;
        }
        if (equity >= im.toInt256()) return 0;
        int256 target = _ceilDiv(im * TOP_UP_TARGET_BPS, BPS).toInt256();
        return uint256(target - equity);
    }

    /// @notice Withdraw up to `freeCollateral`, priced with the lane's monotonic fresh prices.
    ///         If the lane has bad debt, the payout is haircut pro rata (`previewWithdraw`).
    /// @param priceUpdate Optional Pyth update for (some of) the account's markets; empty = Pyth
    ///        storage / the lane's last price. Pay `IPyth.getUpdateFee(priceUpdate)`; excess refunded.
    function withdraw(uint256 amount, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
        refundsExcess
    {
        if (amount == 0) revert ZeroAmount();
        _notInAuction(msg.sender);
        uint8 lane = laneOf(msg.sender);
        if (_accounts[msg.sender].openMarkets.length != 0) {
            MarketSet memory s = _newSet();
            _addAccountMarkets(s, msg.sender);
            _beginPricing(lane, priceUpdate, s);
        }
        uint256 available = freeCollateral(msg.sender);
        if (amount > available) revert InsufficientFreeCollateral(amount, available);
        _adjustCollateral(msg.sender, lane, -amount.toInt256());
        uint256 paid = _laneOutflow(lane, amount, msg.sender);
        if (paid > 0) _pushAusd(msg.sender, paid);
        emit Withdraw(msg.sender, lane, paid);
    }

    /// @notice Top up a lane's insurance fund (anyone). Repays that lane's bad debt first.
    function fundLane(uint8 lane, uint256 amount) external nonReentrant validLane(lane) {
        if (amount == 0) revert ZeroAmount();
        uint256 received = _pullAusd(msg.sender, amount);
        _ledgers[lane].held += received;
        uint256 repaid = _creditLane(lane, received);
        emit LaneFunded(lane, msg.sender, received, repaid);
    }

    /// @notice Withdraw AUSD expiry rewards (all lanes; each lane's haircut applies). A lane that
    ///         cannot pay its share right now is skipped (its rewards stay claimable) instead of
    ///         blocking the other lanes (I2-8).
    function claimKeeperRewards() external nonReentrant returns (uint256 amount) {
        uint256 debited;
        for (uint8 k; k < LANE_COUNT; ++k) {
            uint256 r = _keeperLaneRewards[msg.sender][k];
            if (r == 0 || r > _ledgers[k].held + _lanes[k].badDebt) continue;
            _keeperLaneRewards[msg.sender][k] = 0;
            _ledgers[k].keeperRewards -= r;
            amount += _laneOutflow(k, r, msg.sender);
            debited += r;
        }
        if (debited == 0) revert ZeroAmount();
        if (amount > 0) _pushAusd(msg.sender, amount);
        emit KeeperRewardsClaimed(msg.sender, amount);
    }

    /// @notice Withdraw native MON credited to the caller (execution fees, unpushed refunds).
    function claimExecutionFees() external nonReentrant returns (uint256 amount) {
        for (uint8 k; k < LANE_COUNT; ++k) {
            uint256 r = _nativeOwed[msg.sender][k];
            if (r == 0) continue;
            _nativeOwed[msg.sender][k] = 0;
            _ledgers[k].nativeOwed -= r;
            amount += r;
        }
        if (amount == 0) revert ZeroAmount();
        _tstore(CALL_ID_SLOT, _tload(CALL_ID_SLOT) + 1);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert RefundFailed();
        emit ExecutionFeesClaimed(msg.sender, amount);
    }

    // =====================================================================================
    // Delayed orders
    // =====================================================================================

    /// @notice Commit an order for one market (see the contract header). msg.value is the
    ///         executor's fee (>= `minExecutionFee`). An account in auction may commit reduce-only
    ///         orders (they fill only if they leave it at or above maintenance, which ends the auction). The order records whether it reduces the
    ///         current position (`reduceOnly`) and which position it applies to; if that position
    ///         changes before the fill (taken, closed, inherited), the fill fails.
    /// @return orderId `(uint160(account) << 96) | nonce`.
    function commitOrder(bytes32 market, int256 sizeDelta, uint256 marginDelta, uint256 acceptablePrice)
        external
        payable
        nonReentrant
        returns (uint256 orderId)
    {
        if (!_markets[market].listed) revert MarketNotListed(market);
        int128 sd = sizeDelta.toInt128();
        if (sd == 0) revert ZeroAmount();
        if (acceptablePrice == 0) revert InvalidAcceptablePrice();
        if (msg.value < minExecutionFee) revert ExecutionFeeTooLow(msg.value, minExecutionFee);
        Account storage acct = _accounts[msg.sender];
        if (!acct.registered) revert NotRegistered(msg.sender);
        uint256 existing = _pendingOrder[msg.sender][market];
        if (existing != 0) revert OrderAlreadyPending(existing);

        Position storage pos = _positions[msg.sender][market];
        bool reduceOnly = _commitChecks(acct, pos, sizeDelta, marginDelta);

        uint8 lane = laneOf(msg.sender);
        uint64 nonce = ++acct.orderNonce;
        orderId = (uint256(uint160(msg.sender)) << 96) | nonce;
        Order storage o = _orders[orderId];
        o.account = msg.sender;
        o.commitTime = uint64(block.timestamp);
        o.status = OrderStatus.Pending;
        o.reduceOnly = reduceOnly;
        o.market = market;
        o.sizeDelta = sd;
        o.marginDelta = marginDelta.toUint128();
        o.acceptablePrice = acceptablePrice.toUint128();
        o.executionFee = msg.value.toUint96();
        o.execAfter = uint64(block.timestamp + minExecDelay);
        o.deadline = uint64(block.timestamp + maxExecDelay);
        o.positionId = pos.id;
        _pendingOrder[msg.sender][market] = orderId;
        acct.reservedMargin += marginDelta;
        _ledgers[lane].nativeEscrow += msg.value;
        _emitCommitted(orderId, o, lane);
    }

    /// @dev Commit-time rules; returns whether the order reduces the existing position.
    function _commitChecks(Account storage acct, Position storage pos, int256 sizeDelta, uint256 marginDelta)
        internal
        view
        returns (bool reduceOnly)
    {
        reduceOnly = pos.size != 0 && pos.isLong != (sizeDelta > 0);
        if (!reduceOnly) {
            _notInAuction(msg.sender); // an account in auction may only commit reduce-only orders (R2-05)
            if (paused) revert IsPaused();
            if (pos.size == 0 && marginDelta == 0) revert MarginRequired();
            if (marginDelta > 0) {
                // No new margin while collateral is above the account cap: exempt top-ups (rescue
                // money beyond the cap) can never fund new risk (R4-03).
                if (acct.collateral > maxDepositPerAccount.toInt256()) {
                    revert CollateralAboveCap(acct.collateral, maxDepositPerAccount);
                }
                // Price-free escrow check. The trading fee is paid out of the margin at fill, so
                // "deposit X, commit all of it as margin" fills (R-06).
                uint256 committed = acct.reservedMargin + marginDelta + _sumMargins(msg.sender);
                if (acct.collateral < 0 || committed > uint256(acct.collateral)) {
                    revert InsufficientCollateral(committed, acct.collateral);
                }
            }
        } else {
            if (marginDelta != 0) revert MarginOnReduce();
            if (_abs(sizeDelta) > pos.size) revert OrderWouldFlip();
        }
    }

    function _emitCommitted(uint256 orderId, Order storage o, uint8 lane) internal {
        emit OrderCommitted(
            orderId,
            o.account,
            o.market,
            lane,
            o.sizeDelta,
            o.marginDelta,
            o.acceptablePrice,
            o.executionFee,
            o.execAfter,
            o.deadline
        );
    }

    /// @notice Execute a pending order (anyone) within [execAfter, deadline]. Fill price: Pyth's
    ///         FIRST update of the market's feed at/after `execAfter` (in `priceUpdate`). The
    ///         account's OTHER legs are priced through the lane's monotonic path from the same
    ///         `priceUpdate` (newest of supplied / Pyth-stored / the lane's last price, never older
    ///         than the lane price), so no separate Pyth push is needed. Recommended blob order:
    ///         [latest for the account's feeds, the unique update at execAfter].
    ///         Fill-level failures mark the order Failed (escrow released, executor paid); oracle
    ///         problems, out-of-gas and panics revert.
    function executeOrder(uint256 orderId, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
        refundsExcess
    {
        Order storage o = _orders[orderId];
        if (o.status != OrderStatus.Pending) revert OrderNotPending(orderId);
        if (block.timestamp > o.deadline) revert OrderExpired(orderId, o.deadline);
        if (block.timestamp < o.execAfter) revert OrderNotReady(orderId, o.execAfter);
        (uint256 fillPrice, uint256 publishTime) = _executionPrices(o, priceUpdate);
        _fillOrFail(orderId, o, fillPrice, publishTime);

        uint256 fee = o.executionFee;
        uint8 lane = laneOf(o.account);
        LaneLedger storage g = _ledgers[lane];
        g.nativeEscrow -= fee;
        g.nativeOwed += fee;
        _nativeOwed[msg.sender][lane] += fee;
        emit ExecutionFeeCredited(msg.sender, lane, orderId, fee);
    }

    /// @dev Pause check and every price the fill needs, all cached before the self-call (so the
    ///      fill makes no external call and oracle problems revert the whole call). Other legs go
    ///      through `_beginPricing` with the executor's blob (monotonic, R2-03). For a reduce-only
    ///      order of an account in auction, the order market's CURRENT price is stashed as well
    ///      (`_orderCurrentPrice`): the fill must leave the account at/above maintenance at both.
    function _executionPrices(Order storage o, bytes[] calldata priceUpdate)
        internal
        returns (uint256 fillPrice, uint256 publishTime)
    {
        address account = o.account;
        bytes32 market = o.market;
        if (paused && !o.reduceOnly) revert IsPaused();
        uint8 lane = laneOf(account);
        bool needCurrent = o.reduceOnly && _auctions[account].active;
        bytes32[] storage mkts = _accounts[account].openMarkets;
        MarketSet memory s = _newSet();
        for (uint256 i; i < mkts.length; ++i) {
            if (mkts[i] != market) _addMarket(s, mkts[i]);
        }
        if (s.n != 0) _beginPricing(lane, priceUpdate, s);
        for (uint256 i; i < s.n; ++i) {
            _priceFor(lane, s.items[i]); // reverts if unavailable (order stays pending)
        }
        if (needCurrent) _orderCurrentPrice(lane, market, o.execAfter, priceUpdate);
        (fillPrice, publishTime) = _ingestUnique(priceUpdate, market, o.execAfter, o.deadline);
    }

    /// @dev R3-05: the order market's CURRENT price for an in-auction reduce, stashed for
    ///      `_cureByReduce`. Resolved like any lane price (newest of supplied, stored and lane
    ///      price), but the supplied message is parsed on its own with publishTime >= minT, and the
    ///      resolved price must also be >= minT, where minT = max(execAfter + 1, now -
    ///      maxStoredPriceAge): strictly newer than the fill message (publishTime == execAfter at
    ///      the earliest) and no older than `maxStoredPriceAge`. Blob order, or pushing the fill
    ///      message into Pyth storage, can therefore no longer make "current" equal the fill price.
    ///      Reverts (order stays pending) if no such price is available.
    function _orderCurrentPrice(uint8 lane, bytes32 market, uint64 execAfter, bytes[] calldata updates) internal {
        uint256 freshFrom = block.timestamp > maxStoredPriceAge ? block.timestamp - maxStoredPriceAge : 0;
        uint64 minT = uint64(freshFrom > execAfter ? freshFrom : uint256(execAfter) + 1);
        MarketSet memory s = _newSet();
        _addMarket(s, market);
        PythStructs.Price[] memory sup = new PythStructs.Price[](1);
        if (updates.length != 0) _parseSupplied(updates, s, sup, minT);
        _resolve(lane, market, sup[0]);
        uint256 w = _tload(_cacheKey(market, 0));
        (uint8 st, uint256 t, uint256 a, uint256 b) = _lookup(lane, market);
        if (st != P_OK) _revertPrice(market, st, t, a, b);
        if (t < minT) revert StalePrice(market, t);
        _tstore(_cacheKey(ORDER_CURRENT_SLOT, 0), w);
    }

    function _fillOrFail(uint256 orderId, Order storage o, uint256 fillPrice, uint256 publishTime) internal {
        try this.selfFill(orderId, fillPrice) returns (FillResult memory r) {
            emit OrderExecuted(
                orderId,
                o.account,
                o.market,
                msg.sender,
                fillPrice,
                publishTime,
                o.sizeDelta,
                r.tradingFee,
                r.realizedPnl,
                o.executionFee
            );
        } catch (bytes memory reason) {
            if (reason.length < 4 || bytes4(reason) == PANIC_SELECTOR) {
                assembly {
                    revert(add(reason, 32), mload(reason))
                }
            }
            o.status = OrderStatus.Failed;
            _releaseOrder(o, o.account, o.market);
            emit OrderFailed(orderId, o.account, o.market, msg.sender, reason);
        }
    }

    /// @notice Internal entry point of `executeOrder` (self-call only).
    function selfFill(uint256 orderId, uint256 fillPrice) external returns (FillResult memory r) {
        if (msg.sender != address(this)) revert Unauthorized();
        Order storage o = _orders[orderId];
        Fill memory f;
        f.account = o.account;
        f.market = o.market;
        f.lane = laneOf(f.account);
        f.buy = o.sizeDelta > 0;
        f.absDelta = _abs(o.sizeDelta);
        f.price = fillPrice;
        f.marginDelta = o.marginDelta;
        f.tradeNotional = (f.absDelta * fillPrice) / NOTIONAL_SCALE;
        f.fee = _ceilDiv(f.tradeNotional * tradingFeeBps, BPS);
        r.tradingFee = f.fee;
        bool inAuction = _auctions[f.account].active;
        if (inAuction && !o.reduceOnly) revert AccountInAuction(f.account);
        if (f.buy ? fillPrice > o.acceptablePrice : fillPrice < o.acceptablePrice) {
            revert SlippageExceeded(fillPrice, o.acceptablePrice);
        }
        Position storage pos = _positions[f.account][f.market];
        // The order applies only to the position it was committed against (R-11).
        if (pos.id != o.positionId) revert PositionChanged(o.positionId, pos.id);
        if (pos.size != 0) _settleFunding(f.account, f.lane, f.market, pos);
        if (o.reduceOnly) {
            if (pos.isLong == f.buy || f.absDelta > pos.size) revert OrderWouldFlip();
            r.realizedPnl = _reduce(f);
        } else {
            int256 coll = _accounts[f.account].collateral;
            if (f.marginDelta != 0 && coll > maxDepositPerAccount.toInt256()) {
                revert CollateralAboveCap(coll, maxDepositPerAccount); // re-checked at fill (R4-03)
            }
            _increase(f);
        }
        if (f.fee > 0) {
            _adjustCollateral(f.account, f.lane, -f.fee.toInt256());
            _creditLane(f.lane, f.fee);
        }
        o.status = OrderStatus.Executed;
        _releaseOrder(o, f.account, f.market);
        if (!o.reduceOnly) {
            _requireInitialMargin(f.account);
        } else if (inAuction) {
            _cureByReduce(f.account, f.lane, f.market);
        } else if (_accounts[f.account].openMarkets.length == 0) {
            _writeOffNegative(f.account, f.lane);
        }
    }

    /// @dev A reduce-only fill of an account in auction must leave it at/above maintenance at the
    ///      fill price AND at the order market's current price; it then ends the auction (R2-05).
    function _cureByReduce(address account, uint8 lane, bytes32 market) internal {
        _requireMaintenance(account);
        if (_positions[account][market].size != 0) {
            bytes32 key = _cacheKey(market, 0);
            uint256 fillWord = _tload(key);
            _tstore(key, _tload(_cacheKey(ORDER_CURRENT_SLOT, 0)));
            _requireMaintenance(account);
            _tstore(key, fillWord);
        }
        _endAuction(account, lane);
        ++_auctionCounters[lane].cancelled;
        emit AuctionCancelled(lane, account);
    }

    function _requireMaintenance(address account) internal view {
        (int256 equity, uint256 mm,,) = accountHealth(account);
        if (equity < mm.toInt256()) revert InsufficientMargin(equity, mm);
    }

    /// @notice Cancel a pending order after its deadline (anyone). Fee back to the account.
    function cancelOrder(uint256 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        if (o.status != OrderStatus.Pending) revert OrderNotPending(orderId);
        if (block.timestamp <= o.deadline) revert OrderNotExpired(orderId, o.deadline);
        address account = o.account;
        bytes32 market = o.market;
        o.status = OrderStatus.Cancelled;
        _releaseOrder(o, account, market);
        uint256 fee = o.executionFee;
        uint8 lane = laneOf(account);
        LaneLedger storage g = _ledgers[lane];
        g.nativeEscrow -= fee;
        emit OrderCancelled(orderId, account, market, msg.sender, fee);
        if (fee == 0) return;
        _tstore(CALL_ID_SLOT, _tload(CALL_ID_SLOT) + 1);
        (bool ok,) = account.call{value: fee, gas: 100_000}("");
        if (!ok) {
            g.nativeOwed += fee;
            _nativeOwed[account][lane] += fee;
            emit ExecutionFeeCredited(account, lane, orderId, fee);
        }
    }

    function _releaseOrder(Order storage o, address account, bytes32 market) internal {
        _accounts[account].reservedMargin -= o.marginDelta;
        delete _pendingOrder[account][market];
    }

    /// @dev Increase (or open). The trading fee is paid out of the order's margin (R-06):
    ///      leverage is checked on the gross margin, the position keeps margin − fee.
    function _increase(Fill memory f) internal {
        Position storage pos = _positions[f.account][f.market];
        if (pos.size == 0) {
            Account storage acct = _accounts[f.account];
            if (acct.openMarkets.length >= MAX_OPEN_MARKETS) revert TooManyOpenMarkets();
            acct.openMarkets.push(f.market);
            pos.isLong = f.buy;
            pos.id = ++acct.positionNonce;
            pos.entryPrice = f.price;
            pos.fundingIndex = _fundingIndexNow(f.market);
        } else {
            uint256 num = pos.size * pos.entryPrice + f.absDelta * f.price;
            uint256 den = pos.size + f.absDelta;
            pos.entryPrice = f.buy ? _ceilDiv(num, den) : num / den;
        }
        pos.size += f.absDelta;
        pos.entryNotional += f.tradeNotional;
        uint256 grossMargin = pos.margin + f.marginDelta;
        uint256 feeFromMargin = f.fee < f.marginDelta ? f.fee : f.marginDelta;
        pos.margin = grossMargin - feeFromMargin;

        uint256 notional = (pos.size * f.price) / NOTIONAL_SCALE;
        if (notional < minPositionNotional) revert BelowMinPositionSize(notional, minPositionNotional);
        if (notional > grossMargin * maxLeverage) revert LeverageTooHigh(notional, grossMargin);
        // Margin may not exceed notional (>= 1x): dust orders cannot park collateral as margin (R2-01).
        if (f.marginDelta != 0 && grossMargin > notional) revert MarginAboveNotional(grossMargin, notional);

        OpenInterest storage oi = _laneOI[f.lane][f.market];
        uint256 sideAfter = f.buy ? (oi.longNotional += f.tradeNotional) : (oi.shortNotional += f.tradeNotional);
        uint256 cap = laneOiCap(f.lane, f.market);
        if (sideAfter > cap) revert OiCapExceeded(sideAfter, cap);

        _emitPosition(f.account, f.lane, f.market, f.price, 0);
    }

    function _reduce(Fill memory f) internal returns (int256 pnl) {
        Position storage pos = _positions[f.account][f.market];
        uint256 size = pos.size;
        if (f.absDelta == size) {
            return _closeLeg(f.account, f.lane, f.market, f.price);
        }
        bool isLong = pos.isLong;
        pnl = _pnl(isLong, f.absDelta, pos.entryPrice, f.price);
        uint256 remaining = size - f.absDelta;
        uint256 newEntryNotional = (pos.entryNotional * remaining) / size;
        OpenInterest storage oi = _laneOI[f.lane][f.market];
        if (isLong) oi.longNotional -= pos.entryNotional - newEntryNotional;
        else oi.shortNotional -= pos.entryNotional - newEntryNotional;
        pos.size = remaining;
        pos.entryNotional = newEntryNotional;
        pos.margin = _ceilDiv(pos.margin * remaining, size);
        uint256 notional = (remaining * f.price) / NOTIONAL_SCALE;
        if (notional < minPositionNotional) revert BelowMinPositionSize(notional, minPositionNotional);
        _adjustCollateral(f.account, f.lane, pnl);
        _settleWithLane(f.lane, -pnl);
        _emitPosition(f.account, f.lane, f.market, f.price, pnl);
    }

    function _emitPosition(address account, uint8 lane, bytes32 market, uint256 price, int256 pnl) internal {
        Position storage p = _positions[account][market];
        emit PositionUpdated(account, lane, market, p.isLong, p.size, p.entryPrice, p.entryNotional, p.margin, price, pnl);
    }

    function _closeLeg(address account, uint8 lane, bytes32 market, uint256 price) internal returns (int256 pnl) {
        Position storage pos = _positions[account][market];
        _settleFunding(account, lane, market, pos);
        bool isLong = pos.isLong;
        pnl = _pnl(isLong, pos.size, pos.entryPrice, price);
        OpenInterest storage oi = _laneOI[lane][market];
        if (isLong) oi.longNotional -= pos.entryNotional;
        else oi.shortNotional -= pos.entryNotional;
        uint256 entry = pos.entryPrice;
        delete _positions[account][market];
        _removeOpenMarket(_accounts[account], market);
        _adjustCollateral(account, lane, pnl);
        _settleWithLane(lane, -pnl);
        emit PositionUpdated(account, lane, market, isLong, 0, entry, 0, 0, price, pnl);
    }

    // =====================================================================================
    // Funding
    // =====================================================================================

    /// @notice Recompute `market`'s funding rate from the GLOBAL skew (anyone, rate-limited).
    function updateFunding(bytes32 market) external nonReentrant returns (int256 ratePerSec) {
        Market storage m = _markets[market];
        if (!m.listed) revert MarketNotListed(market);
        Funding memory f = _funding[market];
        uint256 next = uint256(f.lastUpdate) + fundingUpdateInterval;
        if (block.timestamp < next) revert FundingUpdateTooSoon(next);
        int256 index = _fundingIndexNow(market);
        int256 skew;
        for (uint8 k; k < LANE_COUNT; ++k) {
            OpenInterest storage oi = _laneOI[k][market];
            skew += oi.longNotional.toInt256() - oi.shortNotional.toInt256();
        }
        int256 maxRate = ((m.maxFundingBpsPerDay * FUNDING_SCALE) / BPS / 1 days).toInt256();
        int256 scale = m.skewScale.toInt256();
        if (skew >= scale) ratePerSec = maxRate;
        else if (skew <= -scale) ratePerSec = -maxRate;
        else ratePerSec = (maxRate * skew) / scale;
        _funding[market] = Funding(index.toInt128(), ratePerSec.toInt64(), uint64(block.timestamp));
        emit FundingUpdated(market, ratePerSec, index, skew);
    }

    function _fundingIndexNow(bytes32 market) internal view returns (int256) {
        Funding memory f = _funding[market];
        return int256(f.index) + int256(f.ratePerSec) * int256(block.timestamp - uint256(f.lastUpdate));
    }

    function _fundingCredit(bool isLong, uint256 entryNotional, int256 fromIndex, int256 toIndex)
        internal
        pure
        returns (int256)
    {
        int256 num = entryNotional.toInt256() * (toIndex - fromIndex);
        if (isLong) num = -num;
        return _floorDiv(num, int256(FUNDING_SCALE));
    }

    function _settleFunding(address account, uint8 lane, bytes32 market, Position storage pos) internal {
        int256 idx = _fundingIndexNow(market);
        int256 credit = _fundingCredit(pos.isLong, pos.entryNotional, pos.fundingIndex, idx);
        pos.fundingIndex = idx;
        if (credit == 0) return;
        _adjustCollateral(account, lane, credit);
        _settleWithLane(lane, -credit);
        emit FundingSettled(account, lane, market, credit);
    }

    // =====================================================================================
    // Auctions (fair liquidation)
    // =====================================================================================

    /// @notice Put every under-maintenance account in `accounts` (all in `lane`) into auction.
    ///         Accounts whose equity is already NEGATIVE are not auctioned (nobody would pay for
    ///         them): they are closed out at once through the expiry path (`AuctionExpired`), so the
    ///         lane's books show the loss immediately (R2-07). Healthy / already-in-auction accounts
    ///         are skipped; accounts that cannot be priced are skipped with `AccountSkipped`; an
    ///         out-of-lane account reverts the batch. Returns the number of auctions started.
    function startAuctions(uint8 lane, address[] calldata accounts, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
        refundsExcess
        validLane(lane)
        returns (uint256 started)
    {
        _beginBatchPricing(lane, accounts, priceUpdate, false);
        uint256 closedOut;
        for (uint256 i; i < accounts.length; ++i) {
            uint8 res = _startOne(lane, accounts[i]);
            if (res == 1) ++started;
            else if (res == 2) ++closedOut;
        }
        if (started > 0) _auctionCounters[lane].started += uint64(started);
        if (closedOut > 0) {
            _auctionCounters[lane].expired += uint64(closedOut);
            Lane storage l = _lanes[lane];
            l.totalLiquidations += closedOut;
            l.lastSettledAt = block.timestamp;
        }
    }

    /// @dev 0 = nothing, 1 = auction started, 2 = closed out at once (negative equity).
    function _startOne(uint8 lane, address a) internal returns (uint8) {
        Auction storage au = _auctions[a];
        if (au.active || _accounts[a].openMarkets.length == 0) return 0;
        if (!_accountPriceable(lane, a)) {
            emit AccountSkipped(lane, a);
            return 0;
        }
        (int256 equity, uint256 mm,, uint256 notional) = accountHealth(a);
        if (equity >= mm.toInt256()) return 0;
        if (equity < 0) {
            _closeOut(a, lane, equity, notional); // no penalty possible (E < 0), no keeper reward
            return 2;
        }
        address[] storage list = _auctionList[lane];
        au.active = true;
        au.startBlock = uint64(block.number);
        au.index = list.length.toUint32();
        list.push(a);
        emit AuctionStarted(lane, a, block.number, equity, notional);
        return 1;
    }

    /// @notice External take by a registered same-lane account: inherits every leg at mark and is
    ///         paid `min(discount × notional, max(E, 0))` (only from the trader's own equity).
    function take(address account, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
        refundsExcess
        returns (uint256 payment)
    {
        Auction memory au = _auctions[account];
        if (!au.active) revert NotInAuction(account);
        uint8 lane = laneOf(account);
        _requireLane(msg.sender, lane);
        if (msg.sender == account) revert SelfTake();
        if (!_accounts[msg.sender].registered) revert NotRegistered(msg.sender);
        _notInAuction(msg.sender);
        MarketSet memory s = _newSet();
        _addAccountMarkets(s, account);
        _addAccountMarkets(s, msg.sender);
        _beginPricing(lane, priceUpdate, s);
        if (!isLiquidatable(account)) revert NotLiquidatable(account);
        payment = _take(account, lane, au.startBlock, false);
        _requireInitialMargin(msg.sender);
    }

    /// @notice Let `lane`'s backstop pool take every auction in `accounts` at/above the pool's
    ///         minimum discount that the pool can carry. Anyone may call.
    function backstopTakeBatch(uint8 lane, address[] calldata accounts, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
        refundsExcess
        validLane(lane)
        returns (uint256 taken)
    {
        _beginBatchPricing(lane, accounts, priceUpdate, true);
        uint256 minDiscount = _pools[lane].minDiscountBps;
        bool poolOk = _poolPriceable(lane);
        for (uint256 i; i < accounts.length; ++i) {
            address a = accounts[i];
            Auction memory au = _auctions[a];
            if (!au.active) continue;
            uint16 d = _discountBps(au.startBlock);
            if (d < minDiscount) continue;
            if (!poolOk || !_accountPriceable(lane, a)) {
                emit AccountSkipped(lane, a);
                continue;
            }
            if (!isLiquidatable(a) || !_poolCanTake(lane, a, d)) continue;
            _take(a, lane, au.startBlock, true);
            ++taken;
        }
        if (taken > 0) {
            _lanes[lane].lastSettledAt = block.timestamp;
            _poolSettleIfBroke(lane);
        }
    }

    /// @notice Cure: end `account`'s auction once equity >= maintenance (not in the auction's
    ///         start block; prices are monotonic per lane, so a cure cannot use an older price than
    ///         the one the auction started on). Anyone may call.
    function cancelAuction(address account, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
        refundsExcess
        returns (bool cancelled)
    {
        Auction memory au = _auctions[account];
        if (!au.active || block.number <= au.startBlock) return false;
        uint8 lane = laneOf(account);
        MarketSet memory s = _newSet();
        _addAccountMarkets(s, account);
        _beginPricing(lane, priceUpdate, s);
        (int256 equity, uint256 mm,,) = accountHealth(account);
        if (equity < mm.toInt256()) return false;
        _endAuction(account, lane);
        ++_auctionCounters[lane].cancelled;
        emit AuctionCancelled(lane, account);
        return true;
    }

    /// @notice Expiry fallback at the max discount (legacy close-out, 1% penalty).
    function expireBatch(uint8 lane, address[] calldata accounts, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
        refundsExcess
        validLane(lane)
        returns (uint256 expired)
    {
        _beginBatchPricing(lane, accounts, priceUpdate, false);
        uint256 keeperReward;
        for (uint256 i; i < accounts.length; ++i) {
            address a = accounts[i];
            Auction memory au = _auctions[a];
            if (!au.active || _discountBps(au.startBlock) < auctionMaxDiscountBps) continue;
            if (!_accountPriceable(lane, a)) {
                emit AccountSkipped(lane, a);
                continue;
            }
            (bool done, uint256 reward) = _expire(a, lane);
            if (!done) continue;
            keeperReward += reward;
            ++expired;
        }
        if (expired > 0) {
            _auctionCounters[lane].expired += uint64(expired);
            Lane storage l = _lanes[lane];
            l.totalLiquidations += expired;
            l.lastSettledAt = block.timestamp;
            _creditKeeper(msg.sender, lane, keeperReward);
        }
    }

    // =====================================================================================
    // Backstop pools
    // =====================================================================================

    /// @notice Deposit AUSD into `lane`'s backstop pool for shares at the FULL NAV (cash + uncapped
    ///         unrealised PnL; >= 1 AUSD, counts toward the lane TVL cap). Refused while paused,
    ///         while the lane has bad debt, while the pool has a receivable outstanding
    ///         (`backstopReceivable`), and while the pool's unrealised gain exceeds lane insurance:
    ///         in those states the NAV would misprice what existing LPs own (R3-01). Exits are
    ///         priced lower (gains count 0 until realised, R4-01), never higher.
    function backstopDeposit(uint8 lane, uint256 amount, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
        refundsExcess
        validLane(lane)
        returns (uint256 shares)
    {
        if (paused) revert IsPaused();
        if (amount < MIN_BACKSTOP_DEPOSIT) revert ZeroAmount();
        _poolSettleIfBroke(lane); // first: settling a broke pool can itself create bad debt
        if (_lanes[lane].badDebt != 0) revert LaneInDeficit(lane);
        uint256 receivable = _lanes[lane].poolAbsorbed;
        if (receivable != 0) revert BackstopReceivableOutstanding(lane, receivable);
        uint256 tvlAfter = laneTvl(lane) + amount;
        if (tvlAfter > maxTvlPerLane) revert LaneTvlCapExceeded(tvlAfter, maxTvlPerLane);
        BackstopPool storage pool = _pools[lane];
        int256 equity = pool.cash;
        if (pool.markets.length != 0) {
            MarketSet memory s = _newSet();
            _addPoolMarkets(s, lane);
            _beginPricing(lane, priceUpdate, s);
            (int256 unrealized,) = _poolUnrealized(lane, pool);
            uint256 ins = _lanes[lane].insuranceFund;
            if (unrealized > ins.toInt256()) revert BackstopGainCapBinding(lane, unrealized, ins);
            equity += unrealized;
        }
        uint256 received = _pullAusd(msg.sender, amount);
        uint256 supply = pool.totalShares;
        if (supply == 0) {
            shares = received; // supply 0 implies cash 0 and no receivable (swept, R3-01)
        } else {
            if (equity <= 0) revert BackstopInsolvent(lane);
            shares = (received * supply) / uint256(equity);
        }
        if (shares == 0) revert ZeroAmount();
        pool.totalShares = supply + shares;
        pool.shares[pool.epoch][msg.sender] += shares;
        pool.cash += received.toInt256();
        _ledgers[lane].held += received;
        emit BackstopDeposit(lane, msg.sender, received, shares);
    }

    /// @notice Step 1 of an LP withdrawal: request `shares` (0 cancels). Executable ONCE after
    ///         `backstopWithdrawDelay`, within `BACKSTOP_WITHDRAW_WINDOW` (1 h), at the NAV of that
    ///         time; any withdrawal (even partial) consumes the request.
    function backstopRequestWithdraw(uint8 lane, uint256 shares) external nonReentrant validLane(lane) {
        BackstopPool storage pool = _pools[lane];
        uint256 owned = pool.shares[pool.epoch][msg.sender];
        if (shares > owned) revert InsufficientShares(shares, owned);
        uint256 readyAt = block.timestamp + backstopWithdrawDelay;
        pool.requests[msg.sender] = WithdrawRequest(shares.toUint128(), uint64(readyAt), pool.epoch);
        emit BackstopWithdrawRequested(lane, msg.sender, shares, readyAt);
    }

    /// @notice Step 2: redeem up to the requested shares at the current NAV (floored, lane
    ///         haircut applies). Reverts if the payout exceeds pool cash or would leave pool
    ///         equity below `BACKSTOP_MARGIN_BPS` of its exposure, and the last shares cannot leave
    ///         while the pool holds any position (`BackstopPositionsOpen`, R4-02). The exit NAV
    ///         values the receivable and unrealised gains at 0 (R4-01; losses count in full),
    ///         which is conservative for the LPs who stay: an LP exiting while a receivable is
    ///         outstanding forfeits its share of it, and when the last LP leaves the receivable is
    ///         forgiven and any orphaned cash goes to the lane (`BackstopSwept`, R3-01).
    function backstopWithdraw(uint8 lane, uint256 shares, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
        refundsExcess
        validLane(lane)
        returns (uint256 amount)
    {
        if (shares == 0) revert ZeroAmount();
        BackstopPool storage pool = _pools[lane];
        _checkWithdrawRequest(lane, pool, shares);
        uint256 owned = pool.shares[pool.epoch][msg.sender];
        if (shares > owned) revert InsufficientShares(shares, owned);
        if (pool.markets.length != 0) {
            // the last shares may only leave a FLAT pool, so the sweep always runs (R4-02)
            if (shares == pool.totalShares) revert BackstopPositionsOpen(lane);
            MarketSet memory s = _newSet();
            _addPoolMarkets(s, lane);
            _beginPricing(lane, priceUpdate, s);
        }
        (int256 equity, uint256 exposure) = _poolEquity(lane, pool);
        if (equity <= 0) revert BackstopInsolvent(lane);
        amount = (shares * uint256(equity)) / pool.totalShares;
        int256 remaining = equity - amount.toInt256();
        uint256 required = _ceilDiv(exposure * BACKSTOP_MARGIN_BPS, BPS);
        if (remaining < required.toInt256()) revert BackstopMarginBreached(remaining, required);
        if (amount.toInt256() > pool.cash) revert InsufficientBackstopCash(amount, pool.cash);
        delete pool.requests[msg.sender]; // single-use: any withdrawal ends the request (R2-04)
        pool.shares[pool.epoch][msg.sender] = owned - shares;
        pool.totalShares -= shares;
        pool.cash -= amount.toInt256();
        amount = _laneOutflow(lane, amount, msg.sender);
        if (pool.totalShares == 0) _poolSweepIfEmpty(lane);
        if (amount > 0) _pushAusd(msg.sender, amount);
        emit BackstopWithdraw(lane, msg.sender, shares, amount);
    }

    function _checkWithdrawRequest(uint8 lane, BackstopPool storage pool, uint256 shares) internal view {
        WithdrawRequest memory r = pool.requests[msg.sender];
        if (r.epoch != pool.epoch || r.shares < shares) revert NoWithdrawRequest(lane, msg.sender);
        if (block.timestamp < r.readyAt) revert WithdrawNotReady(r.readyAt);
        if (block.timestamp > uint256(r.readyAt) + BACKSTOP_WITHDRAW_WINDOW) {
            revert WithdrawRequestExpired(uint256(r.readyAt) + BACKSTOP_WITHDRAW_WINDOW);
        }
    }

    /// @notice Close up to `size` of the pool's exposure in `market` at mark against the lane.
    ///         Owner or a backstop operator OF THIS LANE.
    function backstopReduce(uint8 lane, bytes32 market, uint256 size, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
        refundsExcess
        validLane(lane)
        returns (int256 realizedPnl)
    {
        if (msg.sender != owner() && !isBackstopOperator[msg.sender][lane]) revert Unauthorized();
        if (size == 0) revert ZeroAmount();
        BackstopPool storage pool = _pools[lane];
        PoolPosition storage pp = pool.positions[market];
        int256 s = pp.size;
        if (s == 0) revert NoPosition(market);
        MarketSet memory ms = _newSet();
        _addMarket(ms, market);
        _beginPricing(lane, priceUpdate, ms);
        uint256 abs = _abs(s);
        if (size > abs) size = abs;
        uint256 price = _priceFor(lane, market);
        _poolSettleFunding(lane, pool, market);
        realizedPnl = _poolRealize(lane, pool, s > 0, size, pp.entryPrice, price);
        pp.size = s > 0 ? s - size.toInt256() : s + size.toInt256();
        _poolSync(lane, pool, market, s);
        _poolSettleIfBroke(lane);
        emit BackstopReduced(lane, market, size, price, realizedPnl);
    }

    // =====================================================================================
    // Views
    // =====================================================================================

    function laneOf(address account) public pure returns (uint8) {
        return uint8(uint160(account) % LANE_COUNT);
    }

    /// @notice Cross-margin health (prices: the call's resolved prices, else the newest of the
    ///         Pyth-stored price and the lane's last price; reverts if a needed price is unusable).
    function accountHealth(address account)
        public
        view
        returns (int256 equity, uint256 maintenanceMargin, uint256 initialMargin, uint256 notional)
    {
        Account storage acct = _accounts[account];
        uint8 lane = laneOf(account);
        equity = acct.collateral;
        bytes32[] storage mkts = acct.openMarkets;
        for (uint256 i; i < mkts.length; ++i) {
            bytes32 m = mkts[i];
            Position storage pos = _positions[account][m];
            uint256 price = _priceFor(lane, m);
            equity += _pnl(pos.isLong, pos.size, pos.entryPrice, price);
            equity += _fundingCredit(pos.isLong, pos.entryNotional, pos.fundingIndex, _fundingIndexNow(m));
            notional += (pos.size * price) / NOTIONAL_SCALE;
            initialMargin += pos.margin;
        }
        maintenanceMargin = _ceilDiv(notional * MAINTENANCE_MARGIN_BPS, BPS);
    }

    function isLiquidatable(address account) public view returns (bool) {
        if (_accounts[account].openMarkets.length == 0) return false;
        (int256 equity, uint256 mm,,) = accountHealth(account);
        return equity < mm.toInt256();
    }

    /// @notice Debitable now: min(collateral, equity − IM) − reservedMargin, floored at 0; 0 in
    ///         auction. The payout may be lower if the lane has bad debt (`previewWithdraw`).
    function freeCollateral(address account) public view returns (uint256) {
        if (_auctions[account].active) return 0;
        Account storage acct = _accounts[account];
        int256 free = acct.collateral;
        if (acct.openMarkets.length != 0) {
            (int256 equity,, uint256 im,) = accountHealth(account);
            int256 byEquity = equity - im.toInt256();
            if (byEquity < free) free = byEquity;
        }
        free -= acct.reservedMargin.toInt256();
        return free > 0 ? uint256(free) : 0;
    }

    /// @notice What a withdrawal debiting `amount` from `account` would pay out now (lane
    ///         haircut applied; 0 if the lane cannot pay it).
    function previewWithdraw(address account, uint256 amount) external view returns (uint256) {
        return _previewOutflow(laneOf(account), amount);
    }

    function getAccount(address account)
        external
        view
        returns (
            int256 collateral,
            uint8 lane,
            bool registered,
            bytes32[] memory openMarkets,
            uint256 reservedMargin,
            uint256 orderNonce
        )
    {
        Account storage acct = _accounts[account];
        return (
            acct.collateral, laneOf(account), acct.registered, acct.openMarkets, acct.reservedMargin, acct.orderNonce
        );
    }

    function getPosition(address account, bytes32 market) external view returns (Position memory) {
        return _positions[account][market];
    }

    function unrealizedPnl(address account, bytes32 market) external view returns (int256 pnl, int256 funding) {
        Position storage pos = _positions[account][market];
        if (pos.size == 0) return (0, 0);
        pnl = _pnl(pos.isLong, pos.size, pos.entryPrice, _priceFor(laneOf(account), market));
        funding = _fundingCredit(pos.isLong, pos.entryNotional, pos.fundingIndex, _fundingIndexNow(market));
    }

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    function pendingOrderOf(address account, bytes32 market) external view returns (uint256) {
        return _pendingOrder[account][market];
    }

    /// @notice Per-lane TVL counted against `maxTvlPerLane`: trader collateral + pool cash.
    function laneTvl(uint8 lane) public view validLane(lane) returns (uint256) {
        int256 c = _ledgers[lane].collateral;
        int256 p = _pools[lane].cash;
        return (c > 0 ? uint256(c) : 0) + (p > 0 ? uint256(p) : 0);
    }

    /// @notice Per-lane per-side OI cap: min(maxLaneOi, lane INSURANCE × oiCapMultiplierBps / BPS).
    ///         Pool cash does not count (it can leave; R-07).
    function laneOiCap(uint8 lane, bytes32 market) public view returns (uint256) {
        uint256 byBacking = (_lanes[lane].insuranceFund * oiCapMultiplierBps) / BPS;
        uint256 abs = _markets[market].maxLaneOi;
        return byBacking < abs ? byBacking : abs;
    }

    function laneOpenInterest(uint8 lane, bytes32 market)
        external
        view
        returns (uint256 longNotional, uint256 shortNotional)
    {
        OpenInterest storage oi = _laneOI[lane][market];
        return (oi.longNotional, oi.shortNotional);
    }

    function openInterest(bytes32 market) external view returns (uint256 longNotional, uint256 shortNotional) {
        for (uint8 k; k < LANE_COUNT; ++k) {
            OpenInterest storage oi = _laneOI[k][market];
            longNotional += oi.longNotional;
            shortNotional += oi.shortNotional;
        }
    }

    function fundingState(bytes32 market)
        external
        view
        returns (int256 index, int256 ratePerSec, uint256 lastUpdate, int256 indexNow, uint256 nextUpdate)
    {
        Funding memory f = _funding[market];
        return (f.index, f.ratePerSec, f.lastUpdate, _fundingIndexNow(market), f.lastUpdate + fundingUpdateInterval);
    }

    function getMarket(bytes32 market)
        external
        view
        returns (
            bool listed,
            string memory symbol,
            bytes32 feedId,
            uint256 skewScale,
            uint256 maxLaneOi,
            uint256 maxFundingBpsPerDay
        )
    {
        Market storage m = _markets[market];
        return (m.listed, m.symbol, m.feedId, m.skewScale, m.maxLaneOi, m.maxFundingBpsPerDay);
    }

    function getMarkets() external view returns (bytes32[] memory ids, string[] memory symbols, bytes32[] memory feeds) {
        ids = _marketIds;
        symbols = new string[](ids.length);
        feeds = new bytes32[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            symbols[i] = _markets[ids[i]].symbol;
            feeds[i] = _markets[ids[i]].feedId;
        }
    }

    function isMarketListed(bytes32 market) external view returns (bool) {
        return _markets[market].listed;
    }

    /// @notice Validated Pyth-STORED price (1e18): reverts if older than `maxStoredPriceAge`,
    ///         non-positive or too uncertain. Lane-specific prices: `markPriceInLane`.
    function markPrice(bytes32 market) external view returns (uint256) {
        (uint8 st, uint256 t, uint256 a, uint256 b) = _candidate(0, false, market, _noPrice());
        if (st != P_OK) _revertPrice(market, st, t, a, b);
        return a;
    }

    /// @notice The price `lane` would use for `market` now with no update supplied: the newest of
    ///         the Pyth-stored price and the lane's last price.
    function markPriceInLane(uint8 lane, bytes32 market) external view validLane(lane) returns (uint256) {
        return _priceFor(lane, market);
    }

    /// @notice The newest price `lane` has used for `market` (monotonic marker).
    function lanePrice(uint8 lane, bytes32 market) external view returns (uint256 price, uint256 publishTime) {
        LanePrice memory lp = _lanePrice[lane][market];
        return (lp.price, lp.publishTime);
    }

    /// @notice Raw latest Pyth-stored price, normalised, WITHOUT age / confidence checks.
    function latestPrice(bytes32 market) external view returns (uint256 price, uint256 conf, uint256 publishTime) {
        PythStructs.Price memory p = pyth.getPriceUnsafe(_markets[market].feedId);
        if (p.price <= 0 || p.expo < MIN_PRICE_EXPO || p.expo > MAX_PRICE_EXPO) revert InvalidPrice(market);
        price = _scale(uint256(uint64(p.price)), p.expo);
        conf = _scale(uint256(p.conf), p.expo);
        publishTime = p.publishTime;
    }

    function keeperRewards(address keeper) external view returns (uint256 total) {
        for (uint8 k; k < LANE_COUNT; ++k) {
            total += _keeperLaneRewards[keeper][k];
        }
    }

    function executionFeesOwed(address account) external view returns (uint256 total) {
        for (uint8 k; k < LANE_COUNT; ++k) {
            total += _nativeOwed[account][k];
        }
    }

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
        Lane storage l = _lanes[lane];
        return (l.insuranceFund, l.badDebt, l.totalLiquidations, l.lastSettledAt, _laneAccounts[lane].length);
    }

    function laneAccountCount(uint8 lane) external view returns (uint256) {
        return _laneAccounts[lane].length;
    }

    function getLaneAccounts(uint8 lane, uint256 offset, uint256 limit) external view returns (address[] memory) {
        return _page(_laneAccounts[lane], offset, limit, false);
    }

    /// @notice Accounts in a page of a lane that are under maintenance and not yet in auction.
    ///         Accounts that cannot be priced are left out (never reverts on a bad feed).
    function getLiquidatableAccounts(uint8 lane, uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory)
    {
        return _page(_laneAccounts[lane], offset, limit, true);
    }

    function getAuctionAccounts(uint8 lane, uint256 offset, uint256 limit)
        external
        view
        validLane(lane)
        returns (address[] memory)
    {
        return _page(_auctionList[lane], offset, limit, false);
    }

    function auctionOf(address account) external view returns (bool active, uint64 startBlock, uint16 discountBps) {
        Auction memory au = _auctions[account];
        if (!au.active) return (false, 0, 0);
        return (true, au.startBlock, _discountBps(au.startBlock));
    }

    function auctionStats(uint8 lane)
        external
        view
        validLane(lane)
        returns (uint256 active, uint256 started, uint256 taken, uint256 cancelled, uint256 expired)
    {
        AuctionCounters memory c = _auctionCounters[lane];
        return (_auctionList[lane].length, c.started, c.taken, c.cancelled, c.expired);
    }

    /// @notice The pool's EXIT NAV (what `backstopWithdraw` pays per share): cash plus unrealised
    ///         PnL with gains counted as 0 until realised (R4-01). `unrealized` = `equity - cash`
    ///         (<= 0). The uncapped unrealised PnL is in `backstopDepositStatus`.
    function backstopNav(uint8 lane)
        external
        view
        validLane(lane)
        returns (int256 equity, int256 cash, int256 unrealized, uint256 shareSupply)
    {
        BackstopPool storage pool = _pools[lane];
        (equity,) = _poolEquity(lane, pool);
        cash = pool.cash;
        unrealized = equity - cash;
        shareSupply = pool.totalShares;
    }

    /// @notice Whether `backstopDeposit` would currently accept a deposit into `lane`'s pool (at
    ///         the lane's current view prices; pause and caps aside), and the inputs of that rule:
    ///         no lane bad debt, no receivable outstanding, and the pool's uncapped unrealised PnL
    ///         not above lane insurance (R3-01). Reverts like `backstopNav` if a pool leg is unpriceable.
    function backstopDepositStatus(uint8 lane)
        external
        view
        validLane(lane)
        returns (bool open, uint256 receivable, int256 unrealizedUncapped, uint256 insurance)
    {
        Lane storage l = _lanes[lane];
        receivable = l.poolAbsorbed;
        insurance = l.insuranceFund;
        (unrealizedUncapped,) = _poolUnrealized(lane, _pools[lane]);
        open = l.badDebt == 0 && receivable == 0 && unrealizedUncapped <= insurance.toInt256();
    }

    /// @notice Shares of `lp` in the pool's CURRENT epoch (shares retired by a reset are 0).
    function backstopSharesOf(uint8 lane, address lp) external view validLane(lane) returns (uint256) {
        BackstopPool storage pool = _pools[lane];
        return pool.shares[pool.epoch][lp];
    }

    /// @notice Pool cash the lane's loss waterfall has consumed and still owes back to the pool
    ///         (repaid from lane inflows before insurance; not counted in NAV, so pool deposits
    ///         are refused while it is > 0; forgiven when the last LP leaves).
    function backstopReceivable(uint8 lane) external view validLane(lane) returns (uint256) {
        return _lanes[lane].poolAbsorbed;
    }

    function backstopEpoch(uint8 lane) external view validLane(lane) returns (uint256) {
        return _pools[lane].epoch;
    }

    /// @return shares Requested shares (0 if none or from an old epoch).
    /// @return readyAt Earliest execution time.
    /// @return expiresAt Latest execution time.
    function backstopWithdrawRequest(uint8 lane, address lp)
        external
        view
        validLane(lane)
        returns (uint256 shares, uint256 readyAt, uint256 expiresAt)
    {
        BackstopPool storage pool = _pools[lane];
        WithdrawRequest memory r = pool.requests[lp];
        if (r.epoch != pool.epoch || r.shares == 0) return (0, 0, 0);
        return (r.shares, r.readyAt, uint256(r.readyAt) + BACKSTOP_WITHDRAW_WINDOW);
    }

    function backstopPositions(uint8 lane)
        external
        view
        validLane(lane)
        returns (bytes32[] memory markets, int256[] memory signedSizes, uint256[] memory entryPrices)
    {
        BackstopPool storage pool = _pools[lane];
        markets = pool.markets;
        signedSizes = new int256[](markets.length);
        entryPrices = new uint256[](markets.length);
        for (uint256 i; i < markets.length; ++i) {
            PoolPosition storage pp = pool.positions[markets[i]];
            signedSizes[i] = pp.size;
            entryPrices[i] = pp.entryPrice;
        }
    }

    function backstopStats(uint8 lane)
        external
        view
        validLane(lane)
        returns (uint256 taken, uint256 discountEarned, uint256 notionalAbsorbed)
    {
        PoolStats memory s = _pools[lane].stats;
        return (s.taken, s.discountEarned, s.notionalAbsorbed);
    }

    function backstopMinDiscountBps(uint8 lane) external view validLane(lane) returns (uint256) {
        return _pools[lane].minDiscountBps;
    }

    /// @notice Global AUSD proof: held vs Σ lane ledgers (surplus 0 unless donated).
    function solvency() external view returns (uint256 ausdHeld, uint256 liabilities, int256 surplus, bool solvent) {
        ausdHeld = ausd.balanceOf(address(this));
        int256 total;
        for (uint8 k; k < LANE_COUNT; ++k) {
            total += _ledgers[k].held.toInt256();
        }
        liabilities = total > 0 ? uint256(total) : 0;
        surplus = ausdHeld.toInt256() - total;
        solvent = surplus >= 0;
    }

    /// @notice Per-lane solvency (R-05). `claims` = Σ trader collateral + pool cash + keeper
    ///         rewards (realised, signed); `surplus` = held − claims = insurance − bad debt (< 0:
    ///         the lane owes more than it holds; withdrawals are haircut by `haircutBps`).
    function laneSolvency(uint8 lane)
        external
        view
        validLane(lane)
        returns (uint256 held, int256 claims, int256 surplus, uint256 insurance, uint256 badDebt, uint256 haircutBps)
    {
        LaneLedger storage g = _ledgers[lane];
        Lane storage l = _lanes[lane];
        held = g.held;
        insurance = l.insuranceFund;
        badDebt = l.badDebt;
        claims = g.collateral + _pools[lane].cash + g.keeperRewards.toInt256();
        surplus = held.toInt256() - claims;
        haircutBps = badDebt == 0 ? 0 : _ceilDiv(badDebt * BPS, held + badDebt);
    }

    function nativeSolvency() external view returns (uint256 held, uint256 liabilities, bool solvent) {
        held = address(this).balance;
        for (uint8 k; k < LANE_COUNT; ++k) {
            liabilities += _ledgers[k].nativeEscrow + _ledgers[k].nativeOwed;
        }
        solvent = held >= liabilities;
    }

    function laneLedger(uint8 lane)
        external
        view
        validLane(lane)
        returns (
            int256 collateral,
            uint256 insurance,
            int256 backstopCash,
            uint256 keeperRewardsOwed,
            uint256 badDebt,
            uint256 nativeEscrow,
            uint256 nativeOwed
        )
    {
        Lane storage l = _lanes[lane];
        LaneLedger storage g = _ledgers[lane];
        return (
            g.collateral, l.insuranceFund, _pools[lane].cash, g.keeperRewards, l.badDebt, g.nativeEscrow, g.nativeOwed
        );
    }

    // =====================================================================================
    // Internal: transient storage, reentrancy, Pyth fees
    // =====================================================================================

    function _tload(bytes32 slot) private view returns (uint256 v) {
        assembly {
            v := tload(slot)
        }
    }

    function _tstore(bytes32 slot, uint256 v) private {
        assembly {
            tstore(slot, v)
        }
    }

    function _enter() private {
        if (_tload(REENTRANCY_SLOT) != 0) revert Reentrancy();
        _tstore(REENTRANCY_SLOT, 1);
        _tstore(CALL_ID_SLOT, _tload(CALL_ID_SLOT) + 1);
        _tstore(FEE_SPENT_SLOT, 0);
    }

    function _exit() private {
        _tstore(REENTRANCY_SLOT, 0);
        _tstore(CALL_ID_SLOT, _tload(CALL_ID_SLOT) + 1);
        _tstore(FEE_SPENT_SLOT, 0);
    }

    /// @dev Invalidates this call's price cache first, so views called during the refund push
    ///      never see caller-chosen prices (I-8).
    function _refundExcess() private {
        _tstore(CALL_ID_SLOT, _tload(CALL_ID_SLOT) + 1);
        uint256 spent = _tload(FEE_SPENT_SLOT);
        if (msg.value > spent) {
            (bool ok,) = msg.sender.call{value: msg.value - spent}("");
            if (!ok) revert RefundFailed();
        }
    }

    function _meterPythFee(uint256 fee) private returns (uint256 spentBefore) {
        spentBefore = _tload(FEE_SPENT_SLOT);
        uint256 total = spentBefore + fee;
        if (total > msg.value) revert InsufficientPythFee(msg.value, total);
        _tstore(FEE_SPENT_SLOT, total);
    }

    // =====================================================================================
    // Internal: prices (Pyth, per-lane monotonic)
    // =====================================================================================

    function _cacheKey(bytes32 market, uint256 word) private view returns (bytes32) {
        return keccak256(abi.encode(PRICE_CACHE_SLOT, _tload(CALL_ID_SLOT), market, word));
    }

    function _noPrice() internal pure returns (PythStructs.Price memory p) {}

    function _age(uint256 t) private view returns (uint256) {
        return block.timestamp > t ? block.timestamp - t : 0;
    }

    function _storedPythPrice(bytes32 feed) internal view returns (bool ok, PythStructs.Price memory p) {
        try pyth.getPriceUnsafe(feed) returns (PythStructs.Price memory q) {
            return (true, q);
        } catch {
            return (false, p);
        }
    }

    /// @dev The price `lane` may use for market `m` (non-reverting):
    ///      newest of {supplied (already range-checked by Pyth), Pyth-stored}, unless the lane has
    ///      already used a price at least as new: then that one (prices never go back in a lane).
    ///      Age limits: supplied `maxPriceAge` (by Pyth's range), stored and lane price
    ///      `maxStoredPriceAge`. The newest candidate is the ONLY candidate: if it is invalid,
    ///      the market is unusable (no fallback to an older price).
    /// @return st status; t publish time; a price (OK) / raw (CONF) / expo (EXPO); b conf (CONF).
    function _candidate(uint8 lane, bool useLane, bytes32 m, PythStructs.Price memory supplied)
        internal
        view
        returns (uint8 st, uint256 t, uint256 a, uint256 b)
    {
        bytes32 feed = _markets[m].feedId;
        if (feed == bytes32(0)) revert MarketNotListed(m);
        PythStructs.Price memory best = supplied;
        uint256 ageLimit = maxPriceAge;
        (bool ok, PythStructs.Price memory s) = _storedPythPrice(feed);
        if (ok && s.publishTime > best.publishTime) {
            best = s;
            ageLimit = maxStoredPriceAge;
        }
        if (useLane) {
            LanePrice memory lp = _lanePrice[lane][m];
            if (lp.publishTime != 0 && lp.publishTime > best.publishTime) {
                t = lp.publishTime;
                if (_age(t) > maxStoredPriceAge) return (P_STALE, t, 0, 0);
                return (P_OK, t, lp.price, 0);
            }
        }
        t = best.publishTime;
        if (t == 0 || _age(t) > ageLimit) return (P_STALE, t, 0, 0);
        (st, a, b) = _check(best);
    }

    /// @dev Validate a Pyth price (non-reverting).
    function _check(PythStructs.Price memory p) internal view returns (uint8 st, uint256 a, uint256 b) {
        if (p.price <= 0) return (P_INVALID, 0, 0);
        if (p.expo < MIN_PRICE_EXPO || p.expo > MAX_PRICE_EXPO) return (P_EXPO, uint256(uint32(p.expo)), 0);
        uint256 raw = uint256(uint64(p.price));
        if (uint256(p.conf) * BPS > maxConfBps * raw) return (P_CONF, raw, p.conf);
        uint256 price = _scale(raw, p.expo);
        if (price == 0 || price > type(uint128).max) return (P_INVALID, 0, 0);
        return (P_OK, price, 0);
    }

    function _revertPrice(bytes32 m, uint8 st, uint256 t, uint256 a, uint256 b) internal pure {
        if (st == P_STALE) revert StalePrice(m, t);
        if (st == P_EXPO) revert InvalidPriceExpo(int32(uint32(a)));
        if (st == P_CONF) revert PriceConfidenceTooWide(m, b, a);
        revert InvalidPrice(m);
    }

    /// @dev Cached resolution of this call, else the view candidate (no lane write).
    function _lookup(uint8 lane, bytes32 m) internal view returns (uint8 st, uint256 t, uint256 a, uint256 b) {
        uint256 w = _tload(_cacheKey(m, 0));
        if (w != 0) {
            st = uint8(w >> 248);
            t = (w >> 128) & type(uint120).max;
            a = w & type(uint128).max;
            if (st == P_CONF) b = _tload(_cacheKey(m, 1));
            return (st, t, a, b);
        }
        return _candidate(lane, true, m, _noPrice());
    }

    function _priceFor(uint8 lane, bytes32 m) internal view returns (uint256) {
        (uint8 st, uint256 t, uint256 a, uint256 b) = _lookup(lane, m);
        if (st != P_OK) _revertPrice(m, st, t, a, b);
        return a;
    }

    function _tryPriceFor(uint8 lane, bytes32 m) internal view returns (bool) {
        (uint8 st,,,) = _lookup(lane, m);
        return st == P_OK;
    }

    function _cacheSet(bytes32 m, uint8 st, uint256 t, uint256 a, uint256 b) private {
        _tstore(_cacheKey(m, 0), (uint256(st) << 248) | ((t & type(uint120).max) << 128) | (a & type(uint128).max));
        if (st == P_CONF) _tstore(_cacheKey(m, 1), b);
    }

    /// @dev Resolve `m` for this call in `lane`, cache it, and advance the lane's monotonic price.
    function _resolve(uint8 lane, bytes32 m, PythStructs.Price memory supplied) internal {
        (uint8 st, uint256 t, uint256 a, uint256 b) = _candidate(lane, true, m, supplied);
        _cacheSet(m, st, t, a, b);
        if (st != P_OK) return;
        LanePrice storage lp = _lanePrice[lane][m];
        if (t > lp.publishTime || (t == lp.publishTime && a != lp.price)) {
            lp.price = uint128(a);
            lp.publishTime = uint64(t);
        }
    }

    /// @dev Parse `updates` for the markets this call touches (partial blobs are fine: only these
    ///      feeds are requested), then resolve each market. Never reverts on a bad feed: an
    ///      unusable market is cached as such and only reverts where it is actually needed.
    function _beginPricing(uint8 lane, bytes[] calldata updates, MarketSet memory s) internal {
        PythStructs.Price[] memory sup = new PythStructs.Price[](s.n);
        if (updates.length != 0 && s.n != 0) {
            _parseSupplied(updates, s, sup, block.timestamp > maxPriceAge ? uint64(block.timestamp - maxPriceAge) : 0);
        }
        for (uint256 i; i < s.n; ++i) {
            _resolve(lane, s.items[i], sup[i]);
        }
    }

    /// @dev Pyth's first message per feed with publishTime in [minT, now + MAX_FUTURE_PUBLISH_SKEW]
    ///      (non-reverting: on any parse failure `sup` stays empty and storage / lane prices apply).
    function _parseSupplied(
        bytes[] calldata updates,
        MarketSet memory s,
        PythStructs.Price[] memory sup,
        uint64 minT
    ) private {
        uint256 n = s.n;
        bytes32[] memory ids = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = _markets[s.items[i]].feedId;
        }
        IPyth p = pyth;
        uint256 fee = p.getUpdateFee(updates);
        uint256 spentBefore = _meterPythFee(fee);
        uint64 maxT = uint64(block.timestamp + MAX_FUTURE_PUBLISH_SKEW);
        try p.parsePriceFeedUpdates{value: fee}(updates, ids, minT, maxT) returns (
            PythStructs.PriceFeed[] memory feeds
        ) {
            if (feeds.length != n) revert InvalidPythResponse();
            for (uint256 i; i < n; ++i) {
                PythStructs.Price memory pr = feeds[i].price;
                if (feeds[i].id != ids[i] || pr.publishTime < minT || pr.publishTime > maxT) {
                    revert InvalidPythResponse();
                }
                sup[i] = pr;
            }
        } catch {
            _tstore(FEE_SPENT_SLOT, spentBefore);
        }
    }

    /// @dev Pricing for a lane batch: every account's markets (+ the pool's for pool takes).
    function _beginBatchPricing(uint8 lane, address[] calldata accounts, bytes[] calldata updates, bool withPool)
        internal
    {
        MarketSet memory s = _newSet();
        for (uint256 i; i < accounts.length; ++i) {
            _requireLane(accounts[i], lane);
            _addAccountMarkets(s, accounts[i]);
        }
        if (withPool) _addPoolMarkets(s, lane);
        _beginPricing(lane, updates, s);
    }

    /// @dev The order's fill price: Pyth's FIRST update of `market`'s feed with publishTime in
    ///      [minT, maxT] (previous publish time < minT). Historical by design: it does not advance
    ///      the lane's monotonic price.
    function _ingestUnique(bytes[] calldata updates, bytes32 market, uint64 minT, uint64 maxT)
        internal
        returns (uint256 price, uint256 publishTime)
    {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = _markets[market].feedId;
        IPyth p = pyth;
        uint256 fee = p.getUpdateFee(updates);
        _meterPythFee(fee);
        PythStructs.PriceFeed[] memory feeds = p.parsePriceFeedUpdatesUnique{value: fee}(updates, ids, minT, maxT);
        if (feeds.length != 1 || feeds[0].id != ids[0]) revert InvalidPythResponse();
        PythStructs.Price memory pr = feeds[0].price;
        publishTime = pr.publishTime;
        if (publishTime < minT || publishTime > maxT) revert InvalidPythResponse();
        (uint8 st, uint256 a, uint256 b) = _check(pr);
        if (st != P_OK) _revertPrice(market, st, publishTime, a, b);
        price = a;
        _cacheSet(market, P_OK, publishTime, price, 0);
    }

    function _scale(uint256 raw, int32 expo) internal pure returns (uint256) {
        int256 e = int256(expo) + 18;
        return e >= 0 ? raw * 10 ** uint256(e) : raw / 10 ** uint256(-e);
    }

    // --- market sets ---

    function _newSet() internal pure returns (MarketSet memory s) {
        s.items = new bytes32[](MAX_MARKETS);
    }

    function _addMarket(MarketSet memory s, bytes32 m) internal pure {
        for (uint256 i; i < s.n; ++i) {
            if (s.items[i] == m) return;
        }
        s.items[s.n++] = m;
    }

    function _addAccountMarkets(MarketSet memory s, address a) internal view {
        bytes32[] storage mkts = _accounts[a].openMarkets;
        for (uint256 i; i < mkts.length; ++i) {
            _addMarket(s, mkts[i]);
        }
    }

    function _addPoolMarkets(MarketSet memory s, uint8 lane) internal view {
        bytes32[] storage pm = _pools[lane].markets;
        for (uint256 i; i < pm.length; ++i) {
            _addMarket(s, pm[i]);
        }
    }

    function _accountPriceable(uint8 lane, address a) internal view returns (bool) {
        bytes32[] storage mkts = _accounts[a].openMarkets;
        for (uint256 i; i < mkts.length; ++i) {
            if (!_tryPriceFor(lane, mkts[i])) return false;
        }
        return true;
    }

    function _poolPriceable(uint8 lane) internal view returns (bool) {
        bytes32[] storage pm = _pools[lane].markets;
        for (uint256 i; i < pm.length; ++i) {
            if (!_tryPriceFor(lane, pm[i])) return false;
        }
        return true;
    }

    // =====================================================================================
    // Internal: accounting
    // =====================================================================================

    function _checkLane(uint8 lane) private pure {
        if (lane >= LANE_COUNT) revert InvalidLane(lane);
    }

    function _requireLane(address account, uint8 lane) internal pure {
        if (laneOf(account) != lane) revert AccountNotInLane(account, lane);
    }

    function _notInAuction(address account) internal view {
        if (_auctions[account].active) revert AccountInAuction(account);
    }

    function _requireInitialMargin(address account) internal view {
        (int256 equity,, uint256 im,) = accountHealth(account);
        if (equity < im.toInt256()) revert InsufficientMargin(equity, im);
    }

    function _sumMargins(address account) internal view returns (uint256 total) {
        bytes32[] storage mkts = _accounts[account].openMarkets;
        for (uint256 i; i < mkts.length; ++i) {
            total += _positions[account][mkts[i]].margin;
        }
    }

    function _adjustCollateral(address account, uint8 lane, int256 delta) internal {
        _accounts[account].collateral += delta;
        _ledgers[lane].collateral += delta;
    }

    function _creditKeeper(address keeper, uint8 lane, uint256 amount) internal {
        if (amount == 0) return;
        _keeperLaneRewards[keeper][lane] += amount;
        _ledgers[lane].keeperRewards += amount;
    }

    /// @dev Pay out a claim of `debited` from `lane` (R-05). If the lane has bad debt (then its
    ///      insurance is 0) every claimant is paid pro rata `held / (held + badDebt)`, floored, and
    ///      the haircut retires the matching bad debt. A lane never pays more than it holds.
    function _laneOutflow(uint8 lane, uint256 debited, address to) internal returns (uint256 paid) {
        LaneLedger storage g = _ledgers[lane];
        Lane storage l = _lanes[lane];
        uint256 held = g.held;
        uint256 debt = l.badDebt;
        if (debited > held + debt) revert LaneInsolvent(lane, held);
        paid = debited;
        if (debt != 0) {
            paid = (debited * held) / (held + debt);
            l.badDebt = debt - (debited - paid);
            emit LaneHaircut(lane, to, debited, paid);
        }
        g.held = held - paid;
    }

    function _previewOutflow(uint8 lane, uint256 debited) internal view returns (uint256) {
        uint256 held = _ledgers[lane].held;
        uint256 debt = _lanes[lane].badDebt;
        if (debited > held + debt) return 0;
        return debt == 0 ? debited : (debited * held) / (held + debt);
    }

    /// @dev PnL = size × (mark − entry) / 1e30 (sign-flipped for shorts), floored toward −∞.
    function _pnl(bool isLong, uint256 size, uint256 entryPrice, uint256 mark) internal pure returns (int256) {
        int256 diff = mark.toInt256() - entryPrice.toInt256();
        if (!isLong) diff = -diff;
        return _floorDiv(size.toInt256() * diff, int256(NOTIONAL_SCALE));
    }

    function _floorDiv(int256 a, int256 b) internal pure returns (int256 q) {
        q = a / b;
        if (a % b != 0 && (a < 0) != (b < 0)) --q;
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }

    function _settleWithLane(uint8 lane, int256 laneDelta) internal {
        if (laneDelta > 0) _creditLane(lane, uint256(laneDelta));
        else if (laneDelta < 0) _debitLane(lane, uint256(-laneDelta));
    }

    /// @dev Inflow: repay bad debt first, then the pool cash the waterfall consumed (R2-08), then
    ///      insurance.
    function _creditLane(uint8 lane, uint256 amount) internal returns (uint256 repaid) {
        Lane storage l = _lanes[lane];
        repaid = amount < l.badDebt ? amount : l.badDebt;
        l.badDebt -= repaid;
        uint256 rest = amount - repaid;
        uint256 owed = l.poolAbsorbed;
        if (owed != 0 && rest != 0) {
            uint256 toPool = rest < owed ? rest : owed;
            l.poolAbsorbed = owed - toPool;
            _pools[lane].cash += toPool.toInt256();
            rest -= toPool;
            emit BackstopRepaid(lane, toPool);
        }
        l.insuranceFund += rest;
    }

    /// @dev Outflow waterfall, all inside the lane: insurance → backstop pool cash → bad debt
    ///      (bad debt is then borne by the lane's claimants through the withdrawal haircut).
    function _debitLane(uint8 lane, uint256 amount) internal {
        Lane storage l = _lanes[lane];
        uint256 ins = l.insuranceFund;
        if (ins >= amount) {
            l.insuranceFund = ins - amount;
            return;
        }
        l.insuranceFund = 0;
        amount -= ins;
        BackstopPool storage pool = _pools[lane];
        int256 cash = pool.cash;
        if (cash > 0) {
            uint256 fromPool = uint256(cash) < amount ? uint256(cash) : amount;
            pool.cash = cash - int256(fromPool);
            l.poolAbsorbed += fromPool;
            amount -= fromPool;
            emit BackstopLossAbsorbed(lane, fromPool);
        }
        if (amount > 0) l.badDebt += amount;
    }

    function _writeOffNegative(address account, uint8 lane) internal returns (uint256 shortfall) {
        int256 coll = _accounts[account].collateral;
        if (coll >= 0) return 0;
        shortfall = uint256(-coll);
        _adjustCollateral(account, lane, -coll);
        _debitLane(lane, shortfall);
        emit BadDebtRealized(lane, account, shortfall);
    }

    function _removeOpenMarket(Account storage acct, bytes32 market) internal {
        bytes32[] storage mkts = acct.openMarkets;
        uint256 len = mkts.length;
        for (uint256 i; i < len; ++i) {
            if (mkts[i] == market) {
                mkts[i] = mkts[len - 1];
                mkts.pop();
                return;
            }
        }
    }

    function _pullAusd(address from, uint256 amount) internal returns (uint256 received) {
        uint256 before = ausd.balanceOf(address(this));
        ausd.safeTransferFrom(from, address(this), amount);
        uint256 afterBal = ausd.balanceOf(address(this));
        if (afterBal <= before) revert TransferAmountMismatch(amount, 0);
        received = afterBal - before;
        if (received > amount) revert TransferAmountMismatch(amount, received);
    }

    function _pushAusd(address to, uint256 amount) internal {
        uint256 before = ausd.balanceOf(address(this));
        ausd.safeTransfer(to, amount);
        uint256 afterBal = ausd.balanceOf(address(this));
        if (afterBal > before || before - afterBal != amount) {
            revert TransferAmountMismatch(amount, afterBal > before ? 0 : before - afterBal);
        }
    }

    // =====================================================================================
    // Internal: auctions
    // =====================================================================================

    /// @dev Transfer every leg of `account` to the taker (msg.sender, or the lane pool) at mark.
    ///      Both kinds of taker are paid `min(P, max(E, 0))` (R-09): the lane never funds a
    ///      discount; it only absorbs negative equity (insurance → pool cash → bad debt).
    function _take(address account, uint8 lane, uint64 startBlock, bool backstop) internal returns (uint256) {
        TakeVars memory v;
        v.discount = _discountBps(startBlock);
        v.blocks = block.number - startBlock;

        Account storage acct = _accounts[account];
        while (acct.openMarkets.length > 0) {
            bytes32 m = acct.openMarkets[acct.openMarkets.length - 1];
            Position memory pos = _positions[account][m];
            uint256 price = _priceFor(lane, m);
            v.notional += (pos.size * price) / NOTIONAL_SCALE;
            _closeLeg(account, lane, m, price);
            if (backstop) _poolAdd(lane, m, pos.isLong, pos.size, price);
            else _inherit(msg.sender, lane, m, pos, price);
        }

        v.payment = (v.notional * v.discount) / BPS;
        int256 e = acct.collateral;
        if (v.payment.toInt256() > e) v.payment = e > 0 ? uint256(e) : 0;
        if (v.payment > 0) _adjustCollateral(account, lane, -v.payment.toInt256());
        v.residual = e > v.payment.toInt256() ? uint256(e) - v.payment : 0;
        v.shortfall = _writeOffNegative(account, lane);

        if (backstop) {
            BackstopPool storage pool = _pools[lane];
            pool.cash += v.payment.toInt256();
            PoolStats memory s = pool.stats;
            pool.stats = PoolStats(
                s.taken + 1, _u96(uint256(s.discountEarned) + v.payment), _u96(uint256(s.notionalAbsorbed) + v.notional)
            );
        } else {
            _adjustCollateral(msg.sender, lane, v.payment.toInt256());
        }

        _endAuction(account, lane);
        ++_auctionCounters[lane].taken;
        ++_lanes[lane].totalLiquidations;

        emit AuctionTaken(
            lane, account, msg.sender, backstop, v.discount, v.blocks, v.notional, v.residual, v.payment, v.shortfall
        );
        return v.payment;
    }

    function _inherit(address taker, uint8 lane, bytes32 m, Position memory src, uint256 price) internal {
        Position storage p = _positions[taker][m];
        if (p.size != 0) revert PositionExists(m);
        Account storage t = _accounts[taker];
        if (t.openMarkets.length >= MAX_OPEN_MARKETS) revert TooManyOpenMarkets();
        uint256 notional = (src.size * price) / NOTIONAL_SCALE;
        p.isLong = src.isLong;
        p.id = ++t.positionNonce;
        p.size = src.size;
        p.entryPrice = price;
        p.entryNotional = notional;
        p.margin = src.entryNotional == 0 ? notional : _ceilDiv(notional * src.margin, src.entryNotional);
        p.fundingIndex = _fundingIndexNow(m);
        t.openMarkets.push(m);
        OpenInterest storage oi = _laneOI[lane][m];
        if (src.isLong) oi.longNotional += notional;
        else oi.shortNotional += notional;
        _emitPosition(taker, lane, m, price, 0);
    }

    function _expire(address a, uint8 lane) internal returns (bool, uint256) {
        (int256 equity, uint256 mm,, uint256 notional) = accountHealth(a);
        if (equity >= mm.toInt256()) return (false, 0);
        _endAuction(a, lane);
        return (true, _closeOut(a, lane, equity, notional));
    }

    /// @dev Legacy close-out at mark against the lane: 1% penalty capped at the remaining
    ///      collateral (half returned as the caller's keeper reward), negative equity written off.
    function _closeOut(address a, uint8 lane, int256 equity, uint256 notional) internal returns (uint256 reward) {
        Account storage acct = _accounts[a];
        while (acct.openMarkets.length > 0) {
            bytes32 m = acct.openMarkets[acct.openMarkets.length - 1];
            _closeLeg(a, lane, m, _priceFor(lane, m));
        }
        if (acct.collateral > 0) {
            uint256 penalty = (notional * LIQUIDATION_FEE_BPS) / BPS;
            if (penalty > uint256(acct.collateral)) penalty = uint256(acct.collateral);
            _adjustCollateral(a, lane, -penalty.toInt256());
            reward = (penalty * KEEPER_SHARE_BPS) / BPS;
            _creditLane(lane, penalty - reward);
        }
        uint256 badDebt = _writeOffNegative(a, lane);
        emit AuctionExpired(lane, a, equity, badDebt);
    }

    function _discountBps(uint64 startBlock) internal view returns (uint16) {
        uint256 d = uint256(auctionStepBps) * (block.number - startBlock);
        uint256 max = auctionMaxDiscountBps;
        return uint16(d > max ? max : d);
    }

    function _endAuction(address account, uint8 lane) internal {
        address[] storage list = _auctionList[lane];
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

    // =====================================================================================
    // Internal: backstop pools
    // =====================================================================================

    /// @dev Exit NAV = cash + unrealised PnL, with unrealised GAINS counted as 0: a gain is paid to
    ///      LPs only once realised, so no exit can be priced on a cap that moves with insurance
    ///      (R4-01; v3–v4 counted gains up to lane insurance). Losses count in full.
    function _poolEquity(uint8 lane, BackstopPool storage pool)
        internal
        view
        returns (int256 equity, uint256 exposure)
    {
        int256 unrealized;
        (unrealized, exposure) = _poolUnrealized(lane, pool);
        equity = pool.cash + (unrealized < 0 ? unrealized : int256(0));
    }

    /// @dev Uncapped unrealised PnL + pending funding of the pool's exposure, and its notional.
    function _poolUnrealized(uint8 lane, BackstopPool storage pool)
        internal
        view
        returns (int256 unrealized, uint256 exposure)
    {
        bytes32[] storage pm = pool.markets;
        for (uint256 i; i < pm.length; ++i) {
            PoolPosition storage pp = pool.positions[pm[i]];
            uint256 price = _priceFor(lane, pm[i]);
            int256 s = pp.size;
            unrealized += _pnl(s > 0, _abs(s), pp.entryPrice, price);
            unrealized += _fundingCredit(s > 0, pp.oiNotional, pp.fundingIndex, _fundingIndexNow(pm[i]));
            exposure += (_abs(s) * price) / NOTIONAL_SCALE;
        }
    }

    function _capGain(uint8 lane, int256 unrealized) internal view returns (int256) {
        int256 ins = _lanes[lane].insuranceFund.toInt256();
        return unrealized > ins ? ins : unrealized;
    }

    /// @dev The pool takes only if it has LPs (R-08) and keeps equity >= BACKSTOP_MARGIN_BPS of
    ///      its netted exposure after inheriting (payment counted at most at E⁺).
    function _poolCanTake(uint8 lane, address account, uint16 discount) internal view returns (bool) {
        BackstopPool storage pool = _pools[lane];
        if (pool.totalShares == 0) return false;
        (int256 equity, uint256 exposure, uint256 notionalIn) = _poolExposureAfter(lane, pool, account);
        (int256 e,,,) = accountHealth(account);
        uint256 pay = (notionalIn * discount) / BPS;
        if (e <= 0) pay = 0;
        else if (pay > uint256(e)) pay = uint256(e);
        equity += pay.toInt256();
        return equity >= 0 && uint256(equity) * BPS >= exposure * BACKSTOP_MARGIN_BPS;
    }

    function _poolExposureAfter(uint8 lane, BackstopPool storage pool, address account)
        internal
        view
        returns (int256 equity, uint256 exposure, uint256 notionalIn)
    {
        int256 unrealized;
        bytes32[] storage pm = pool.markets;
        for (uint256 i; i < pm.length; ++i) {
            PoolPosition storage pp = pool.positions[pm[i]];
            uint256 price = _priceFor(lane, pm[i]);
            int256 s = pp.size;
            unrealized += _pnl(s > 0, _abs(s), pp.entryPrice, price);
            unrealized += _fundingCredit(s > 0, pp.oiNotional, pp.fundingIndex, _fundingIndexNow(pm[i]));
            Position storage tp = _positions[account][pm[i]];
            if (tp.size != 0) s += tp.isLong ? tp.size.toInt256() : -tp.size.toInt256();
            exposure += (_abs(s) * price) / NOTIONAL_SCALE;
        }
        equity = pool.cash + _capGain(lane, unrealized);
        bytes32[] storage tm = _accounts[account].openMarkets;
        for (uint256 i; i < tm.length; ++i) {
            uint256 n = (_positions[account][tm[i]].size * _priceFor(lane, tm[i])) / NOTIONAL_SCALE;
            notionalIn += n;
            if (pool.positions[tm[i]].size == 0) exposure += n;
        }
    }

    function _poolSettleFunding(uint8 lane, BackstopPool storage pool, bytes32 m) internal {
        PoolPosition storage pp = pool.positions[m];
        int256 idx = _fundingIndexNow(m);
        int256 s = pp.size;
        if (s != 0) {
            int256 credit = _fundingCredit(s > 0, pp.oiNotional, pp.fundingIndex, idx);
            if (credit != 0) {
                pool.cash += credit;
                _settleWithLane(lane, -credit);
                emit BackstopFundingSettled(lane, m, credit);
            }
        }
        pp.fundingIndex = idx;
    }

    function _poolAdd(uint8 lane, bytes32 m, bool isLong, uint256 size, uint256 price) internal {
        BackstopPool storage pool = _pools[lane];
        PoolPosition storage pp = pool.positions[m];
        _poolSettleFunding(lane, pool, m);
        int256 s = pp.size;
        uint256 abs = _abs(s);
        if (s == 0) {
            pool.markets.push(m);
            pp.entryPrice = price;
        } else if ((s > 0) == isLong) {
            uint256 num = abs * pp.entryPrice + size * price;
            uint256 den = abs + size;
            pp.entryPrice = isLong ? _ceilDiv(num, den) : num / den;
        } else {
            _poolRealize(lane, pool, s > 0, size < abs ? size : abs, pp.entryPrice, price);
            if (size > abs) pp.entryPrice = price;
        }
        pp.size = s + (isLong ? size.toInt256() : -size.toInt256());
        _poolSync(lane, pool, m, s);
    }

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

    function _poolSync(uint8 lane, BackstopPool storage pool, bytes32 m, int256 oldSize) internal {
        PoolPosition storage pp = pool.positions[m];
        OpenInterest storage oi = _laneOI[lane][m];
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

    /// @dev Settle a FLAT pool whose cash is <= 0 (R3-01):
    ///      1. Net the receivable first: the lane absorbs the pool's negative cash up to what it owes
    ///         the pool (insurance → bad debt), and the receivable shrinks by the same amount.
    ///      2. Only if cash + receivable was <= 0 (cash still < 0, or 0 with nothing owed) is the pool
    ///         insolvent: any remaining deficit is written off against the lane and every share is
    ///         retired by bumping the epoch, so new deposits start fresh at 1:1 (R-03).
    ///      A flat pool with cash 0 and a receivable outstanding keeps its shares (its LPs are owed).
    function _poolSettleIfBroke(uint8 lane) internal {
        BackstopPool storage pool = _pools[lane];
        if (pool.markets.length != 0) return;
        int256 cash = pool.cash;
        if (cash > 0) return;
        Lane storage l = _lanes[lane];
        uint256 rec = l.poolAbsorbed;
        if (cash < 0 && rec != 0) {
            uint256 net = uint256(-cash) < rec ? uint256(-cash) : rec;
            l.poolAbsorbed = rec - net;
            rec -= net;
            cash += int256(net);
            pool.cash = cash; // <= 0: the pool layer of _debitLane takes nothing
            _debitLane(lane, net);
            emit BackstopReceivableNetted(lane, net);
        }
        if (rec != 0) return; // cash is 0 here and the lane still owes the pool: not insolvent
        uint256 deficit;
        if (cash < 0) {
            pool.cash = 0;
            deficit = uint256(-cash);
            _debitLane(lane, deficit);
        }
        uint256 retired = pool.totalShares;
        if (retired == 0) return;
        pool.totalShares = 0;
        uint64 epoch = ++pool.epoch;
        emit BackstopPoolReset(lane, epoch, retired, deficit);
    }

    /// @dev Once a pool has no shares left, nothing may stay in it for a next depositor to capture:
    ///      orphaned cash goes to the lane (bad debt, then insurance) and the receivable is forgiven.
    function _poolSweepIfEmpty(uint8 lane) internal {
        BackstopPool storage pool = _pools[lane];
        if (pool.totalShares != 0 || pool.markets.length != 0) return;
        Lane storage l = _lanes[lane];
        uint256 forgiven = l.poolAbsorbed;
        l.poolAbsorbed = 0;
        int256 cash = pool.cash;
        uint256 swept;
        if (cash > 0) {
            swept = uint256(cash);
            pool.cash = 0;
            _creditLane(lane, swept); // receivable already 0: bad debt, then insurance
        }
        if (swept != 0 || forgiven != 0) emit BackstopSwept(lane, swept, forgiven);
    }

    function _u96(uint256 x) internal pure returns (uint96) {
        if (x > type(uint96).max) revert AmountTooLarge();
        return uint96(x);
    }

    function _page(address[] storage list, uint256 offset, uint256 limit, bool onlyLiquidatable)
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
            if (onlyLiquidatable) {
                if (_auctions[a].active || _accounts[a].openMarkets.length == 0) continue;
                if (!_accountPriceable(laneOf(a), a) || !isLiquidatable(a)) continue;
            }
            found[n++] = a;
        }
        assembly {
            mstore(found, n)
        }
    }
}
