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

/// @notice Minimal mock of a CCA v2.1.0 auction, close enough for CreditLine tests: a fixed
/// `endBlock`, a settable `isGraduated` flag, a one-shot `sweepCurrency` gated to `fundsRecipient`
/// that moves this contract's whole currency balance when graduated (0 otherwise), and an
/// unrestricted `sweepUnsoldTokens` that moves this contract's whole note balance to
/// `tokensRecipient` regardless of graduation. `checkpoint` and the bid-lifecycle functions are
/// no-ops; Advance's CreditLine never calls them.
contract MockAuction is ICCA {
    using SafeERC20 for IERC20;

    IERC20 public immutable currency;
    IERC20 public immutable noteToken;
    address public immutable fundsRecipient;
    address public immutable tokensRecipient;
    uint64 public immutable endBlockNumber;

    bool public graduated;
    bool public currencySwept;

    error NotFundsRecipient();
    error AlreadySwept();

    constructor(
        address currency_,
        address noteToken_,
        address fundsRecipient_,
        address tokensRecipient_,
        uint64 endBlockNumber_
    ) {
        currency = IERC20(currency_);
        noteToken = IERC20(noteToken_);
        fundsRecipient = fundsRecipient_;
        tokensRecipient = tokensRecipient_;
        endBlockNumber = endBlockNumber_;
    }

    /// @notice Test hook: sets whether the auction graduated.
    function setGraduated(bool graduated_) external {
        graduated = graduated_;
    }

    function onTokensReceived() external {}

    function submitBid(uint256, uint128, address, uint256, bytes calldata) external payable returns (uint256) {
        return 0;
    }

    function checkpoint() external pure returns (Checkpoint memory) {
        return Checkpoint(0, 0, 0, 0, 0, 0);
    }

    function sweepCurrency() external {
        if (msg.sender != fundsRecipient) revert NotFundsRecipient();
        if (currencySwept) revert AlreadySwept();
        currencySwept = true;

        if (graduated) {
            uint256 balance = currency.balanceOf(address(this));
            if (balance != 0) currency.safeTransfer(fundsRecipient, balance);
        }
    }

    function sweepUnsoldTokens() external {
        uint256 balance = noteToken.balanceOf(address(this));
        if (balance != 0) noteToken.safeTransfer(tokensRecipient, balance);
    }

    function endBlock() external view returns (uint64) {
        return endBlockNumber;
    }

    function claimTokens(uint256) external {}

    function exitBid(uint256) external {}

    function isGraduated() external view returns (bool) {
        return graduated;
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
