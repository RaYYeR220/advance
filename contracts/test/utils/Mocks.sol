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
/// real contract's `ensureEndBlockIsCheckpointed` modifier, `sweepCurrency()`/`sweepUnsoldTokens()`
/// — has actually run; before that it stays at whatever it last committed to (0/false by
/// default). `sweepCurrency` is `fundsRecipient`-only, callable once, only after `endBlock`,
/// and sweeps 0 (not a revert) when not graduated. `sweepUnsoldTokens` is `tokensRecipient`-only,
/// callable once, only after `endBlock`, and moves this contract's whole note balance — which
/// equals `remainingSupply()` when graduated (bids "sold" are simulated by tests transferring
/// notes out of this contract) and the full `TOTAL_SUPPLY` when not (nothing can be transferred
/// out pre-graduation in the real contract, since claiming requires it). `checkpoint` and the
/// bid-lifecycle functions beyond that are no-ops; Advance's CreditLine never calls them.
contract MockAuction is ICCA {
    using SafeERC20 for IERC20;

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

    error NotFundsRecipient();
    error NotTokensRecipient();
    error AuctionNotOver();
    error AlreadySwept();

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

    function sweepUnsoldTokens() external {
        if (msg.sender != _tokensRecipient) revert NotTokensRecipient();
        if (block.number < _endBlock) revert AuctionNotOver();
        if (unsoldSwept) revert AlreadySwept();
        unsoldSwept = true;
        _checkpoint();

        uint256 balance = _noteToken.balanceOf(address(this));
        if (balance != 0) _noteToken.safeTransfer(_tokensRecipient, balance);
    }

    function endBlock() external view returns (uint64) {
        return _endBlock;
    }

    function claimTokens(uint256) external {}

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
