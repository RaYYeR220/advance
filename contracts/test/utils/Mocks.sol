// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IChainlink} from "../../src/interfaces/IChainlink.sol";
import {Checkpoint, ICCA} from "../../src/interfaces/ICCA.sol";
import {IAdvanceHub} from "../../src/interfaces/IAdvanceHub.sol";

/// @notice Minimal Chainlink `AggregatorV3Interface` mock with settable answer/startedAt/updatedAt,
/// used for both the ETH/USD feed and the L2 sequencer uptime feed in OracleLib tests.
contract MockFeed is IChainlink {
    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;
    uint8 public feedDecimals = 8;

    function setAnswer(int256 answer_) external {
        answer = answer_;
    }

    function setStartedAt(uint256 startedAt_) external {
        startedAt = startedAt_;
    }

    function setUpdatedAt(uint256 updatedAt_) external {
        updatedAt = updatedAt_;
    }

    function setDecimals(uint8 decimals_) external {
        feedDecimals = decimals_;
    }

    function decimals() external view returns (uint8) {
        return feedDecimals;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer_, uint256 startedAt_, uint256 updatedAt_, uint80 answeredInRound)
    {
        return (0, answer, startedAt, updatedAt, 0);
    }
}

/// @notice Minimal mintable ERC20 with configurable decimals, standing in for USDC (6 decimals)
/// in RevenueNote tests.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Minimal but faithful mock of a CCA v2.1.0 auction. Mirrors the real contract's
/// lazy-checkpoint semantics: `isGraduated()` reflects `pendingGraduated` (set via the test hook
/// `setGraduated`, standing in for bids that have landed) only once `checkpoint()` — or, per the
/// real contract's `ensureEndBlockIsCheckpointed` modifier, `sweepCurrency()`/`sweepUnsoldTokens()`/
/// `claimTokens()` — has actually run; before that it stays at whatever it last committed to
/// (0/false by default). `sweepCurrency` is `fundsRecipient`-only, callable once, only after
/// `endBlock`, and sweeps 0 (not a revert) when not graduated. Sold notes are NOT transferred out
/// at sale time (real CCA: filled bids sit in the auction until each bidder calls `claimTokens`,
/// which reverts before graduation) — tests record a sale via `recordSale`, which only does
/// bookkeeping. `sweepUnsoldTokens` is `tokensRecipient`-only, callable once, only after
/// `endBlock`, and moves `totalSold` less than this contract's whole note balance when graduated
/// (the real contract's `remainingSupply()`), or the whole balance when not (real `TOTAL_SUPPLY`,
/// since nothing can ever be claimed pre-graduation). `claimTokens(bidId)` pays out a recorded
/// sale's `owner` after `endBlock`, once graduated, once per bid. `checkpoint` and the unused
/// bid-lifecycle functions are no-ops; Advance's CreditLine never calls them.
contract MockAuction is ICCA {
    using SafeERC20 for IERC20;

    /// @dev A test-recorded filled bid: `amount` notes sold to `owner`, claimable via
    /// `claimTokens` once the auction has ended and graduated.
    struct SoldLot {
        address owner;
        uint256 amount;
        bool claimed;
    }

    IERC20 internal immutable _currency;
    IERC20 internal immutable _noteToken;
    address internal immutable _fundsRecipient;
    address internal immutable _tokensRecipient;
    uint64 internal immutable _endBlock;

    /// @dev What `isGraduated()` will report once a checkpoint runs; simulates bids that have
    /// landed but aren't yet reflected in on-chain graduation state.
    bool public pendingGraduated;
    /// @dev The checkpointed/committed graduation status; this is what `isGraduated()` returns.
    bool internal committedGraduated;

    bool public currencySwept;
    bool public unsoldSwept;

    /// @notice Cumulative notes recorded as sold/filled via `recordSale`, still physically held
    /// by this contract until claimed.
    uint256 public totalSold;
    mapping(uint256 bidId => SoldLot) internal _soldLots;
    uint256 internal _nextBidId;

    error NotFundsRecipient();
    error NotTokensRecipient();
    error AuctionNotOver();
    error AlreadySwept();
    error NotGraduated();
    error AlreadyClaimed();

    constructor(
        address currency_,
        address noteToken_,
        address fundsRecipient_,
        address tokensRecipient_,
        uint64 endBlockNumber_
    ) {
        _currency = IERC20(currency_);
        _noteToken = IERC20(noteToken_);
        _fundsRecipient = fundsRecipient_;
        _tokensRecipient = tokensRecipient_;
        _endBlock = endBlockNumber_;
    }

    /// @notice Test hook: sets what graduation will read as once checkpointed (simulates bids
    /// landing without yet running a checkpoint).
    function setGraduated(bool graduated_) external {
        pendingGraduated = graduated_;
    }

    /// @notice Test hook: records `amount` notes as sold/filled to `owner`, matching real CCA's
    /// bid-fill bookkeeping without modeling the full bid/exit lifecycle. The notes stay
    /// physically held by this contract (not transferred) until `claimTokens` is called with the
    /// returned `bidId`.
    /// @return bidId The id to claim this sale with.
    function recordSale(address owner, uint256 amount) external returns (uint256 bidId) {
        bidId = _nextBidId++;
        _soldLots[bidId] = SoldLot({owner: owner, amount: amount, claimed: false});
        totalSold += amount;
    }

    function onTokensReceived() external {}

    function submitBid(uint256, uint128, address, uint256, bytes calldata) external payable returns (uint256) {
        return 0;
    }

    function checkpoint() external returns (Checkpoint memory) {
        _checkpoint();
        return Checkpoint(0, 0, 0, 0, 0, 0);
    }

    function sweepCurrency() external {
        if (msg.sender != _fundsRecipient) revert NotFundsRecipient();
        if (block.number < _endBlock) revert AuctionNotOver();
        if (currencySwept) revert AlreadySwept();
        currencySwept = true;
        _checkpoint();

        if (committedGraduated) {
            uint256 balance = _currency.balanceOf(address(this));
            if (balance != 0) _currency.safeTransfer(_fundsRecipient, balance);
        }
    }

    /// @notice Sweeps unsold notes: `balance - totalSold` when graduated (mirrors real CCA's
    /// `remainingSupply()`), or the whole balance when not (nothing is ever claimable
    /// pre-graduation, so `totalSold` never actually leaves in that case). Assumes, like real
    /// production usage, that this runs before any `claimTokens` call empties out sold notes —
    /// it is only ever called once, atomically, from `CreditLine.settleAuction`.
    function sweepUnsoldTokens() external {
        if (msg.sender != _tokensRecipient) revert NotTokensRecipient();
        if (block.number < _endBlock) revert AuctionNotOver();
        if (unsoldSwept) revert AlreadySwept();
        unsoldSwept = true;
        _checkpoint();

        uint256 balance = _noteToken.balanceOf(address(this));
        uint256 unsold = committedGraduated ? balance - totalSold : balance;
        if (unsold != 0) _noteToken.safeTransfer(_tokensRecipient, unsold);
    }

    function endBlock() external view returns (uint64) {
        return _endBlock;
    }

    /// @notice Pays out a recorded sale's filled notes to its owner. Only after `endBlock`, only
    /// once graduated (checkpointing first, like the real contract), and only once per bid.
    function claimTokens(uint256 bidId) external {
        if (block.number < _endBlock) revert AuctionNotOver();
        _checkpoint();
        if (!committedGraduated) revert NotGraduated();

        SoldLot storage lot = _soldLots[bidId];
        if (lot.claimed) revert AlreadyClaimed();
        lot.claimed = true;

        if (lot.amount != 0) _noteToken.safeTransfer(lot.owner, lot.amount);
    }

    function exitBid(uint256) external {}

    function isGraduated() external view returns (bool) {
        return committedGraduated;
    }

    function currency() external view returns (address) {
        return address(_currency);
    }

    function token() external view returns (address) {
        return address(_noteToken);
    }

    function tokensRecipient() external view returns (address) {
        return _tokensRecipient;
    }

    function fundsRecipient() external view returns (address) {
        return _fundsRecipient;
    }

    /// @dev Commits `pendingGraduated` into the queryable `isGraduated()` value, mirroring the
    /// real contract's checkpoint-driven `$currencyRaisedQ96X7` update.
    function _checkpoint() internal {
        committedGraduated = pendingGraduated;
    }
}

/// @notice Minimal mock of AdvanceHub's CreditLine-facing callback, recording the last
/// `onAuctionSettled` call for assertions.
contract MockHub is IAdvanceHub {
    uint256 public callCount;
    uint256 public lastLoanId;
    bool public lastGraduated;

    function onAuctionSettled(uint256 loanId_, bool graduated_) external {
        callCount++;
        lastLoanId = loanId_;
        lastGraduated = graduated_;
    }
}
