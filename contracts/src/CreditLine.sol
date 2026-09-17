// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {ICCA} from "./interfaces/ICCA.sol";
import {IAdvanceHub} from "./interfaces/IAdvanceHub.sol";
import {RevenueNote} from "./RevenueNote.sol";

/// @title CreditLine
/// @notice Custodies the USDC principal raised for one loan's Uniswap CCA auction and releases
/// it to the agent's card within a per-period draw limit. On settlement it sweeps the auction's
/// raised currency (if graduated) and burns any unsold notes it swept in, shrinking the note's
/// repayment cap to match what was actually funded. `freeze`/`close` return remaining balance to
/// note holders and the treasury, respectively.
contract CreditLine is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice Lifecycle of this credit line, mirroring the loan's auction outcome.
    enum State {
        Pending,
        Active,
        Frozen,
        Closed,
        Failed
    }

    /// @notice AdvanceHub address; the only caller allowed to `initialize`, `freeze` and `close`.
    address public immutable hub;
    /// @notice USDC token this credit line custodies and pays out.
    IERC20 public immutable usdc;
    /// @notice The agent's card; the only address allowed to `draw`.
    address public immutable card;
    /// @notice Receives any USDC left over after `freeze` covers the note's remaining cap, and
    /// the full balance on `close`.
    address public immutable treasury;
    /// @notice Maximum USDC drawable per `drawPeriod`.
    uint128 public immutable drawLimit;
    /// @notice Length, in seconds, of one draw period.
    uint64 public immutable drawPeriod;

    /// @notice Current lifecycle state.
    State public state;
    /// @notice The loan id this credit line was initialized for.
    uint256 public loanId;
    /// @notice The CCA auction this loan's notes were sold through.
    ICCA public auction;
    /// @notice The loan's revenue note.
    RevenueNote public note;
    /// @notice Whether `initialize` has already been called.
    bool public initialized;
    /// @notice Whether `settleAuction` has already been called.
    bool public settled;

    /// @notice USDC principal raised by the auction (0 if it did not graduate).
    uint256 public principal;
    /// @notice Cumulative USDC drawn by the card over the life of this credit line.
    uint256 public totalDrawn;
    /// @notice Timestamp `settleAuction` activated this credit line (0 before then).
    uint64 public activatedAt;

    /// @dev USDC already drawn within each draw period index (see `currentPeriod`).
    mapping(uint64 period => uint256 drawn) internal drawnInPeriod;

    /// @notice Emitted once `settleAuction` sweeps the auction and burns any unsold notes.
    /// @param graduated Whether the auction raised at least its required currency.
    /// @param principal USDC swept in as principal (0 if not graduated).
    /// @param unsoldBurned Unsold notes swept in and burned.
    event AuctionSettled(bool graduated, uint256 principal, uint256 unsoldBurned);
    /// @notice Emitted on every successful `draw`.
    /// @param amount USDC drawn.
    /// @param period The draw period index the draw was charged against.
    /// @param remainingInPeriod USDC still drawable in `period` after this draw.
    event Drawn(uint256 amount, uint64 period, uint256 remainingInPeriod);
    /// @notice Emitted once `freeze` splits the remaining balance.
    /// @param toNotes USDC distributed to the revenue note.
    /// @param toTreasury USDC sent to the treasury.
    event Frozen(uint256 toNotes, uint256 toTreasury);
    /// @notice Emitted once `close` sweeps the remaining balance to the treasury.
    /// @param toTreasury USDC sent to the treasury.
    event Closed(uint256 toTreasury);

    error NotHub();
    error NotCard();
    error NotActive();
    error AuctionLive();
    error AlreadySettled();
    error DrawLimitExceeded(uint256 requested, uint256 available);
    error AlreadyInitialized();
    error ZeroAddress();
    error ZeroDrawPeriod();

    /// @param hub_ AdvanceHub address; the only caller allowed to `initialize`, `freeze` and `close`.
    /// @param usdc_ USDC token this credit line custodies and pays out.
    /// @param card_ The agent's card; the only address allowed to `draw`.
    /// @param treasury_ Receives leftover USDC on `freeze`/`close`.
    /// @param drawLimit_ Maximum USDC drawable per `drawPeriod_`.
    /// @param drawPeriod_ Length, in seconds, of one draw period; must be nonzero.
    constructor(address hub_, address usdc_, address card_, address treasury_, uint128 drawLimit_, uint64 drawPeriod_) {
        if (hub_ == address(0) || usdc_ == address(0) || card_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (drawPeriod_ == 0) revert ZeroDrawPeriod();

        hub = hub_;
        usdc = IERC20(usdc_);
        card = card_;
        treasury = treasury_;
        drawLimit = drawLimit_;
        drawPeriod = drawPeriod_;
    }

    /// @notice Wires the loan id, auction and note this credit line was created for. Callable
    /// once, by the hub.
    /// @param loanId_ The loan id this credit line is initialized for.
    /// @param auction_ The CCA auction this loan's notes were sold through.
    /// @param note_ The loan's revenue note.
    function initialize(uint256 loanId_, address auction_, address note_) external {
        if (msg.sender != hub) revert NotHub();
        if (initialized) revert AlreadyInitialized();
        if (auction_ == address(0) || note_ == address(0)) revert ZeroAddress();

        initialized = true;
        loanId = loanId_;
        auction = ICCA(auction_);
        note = RevenueNote(note_);
    }

    /// @notice Settles the auction once it has ended: sweeps raised USDC as principal if
    /// graduated, sweeps and burns any unsold notes either way, activates this credit line
    /// (graduated) or marks it Failed (not graduated), and notifies the hub. Callable once, by
    /// anyone, only after the auction's `endBlock`.
    function settleAuction() external nonReentrant {
        if (settled) revert AlreadySettled();
        if (block.number < auction.endBlock()) revert AuctionLive();
        settled = true;

        bool graduated = auction.isGraduated();
        uint256 raised;

        if (graduated) {
            uint256 balanceBefore = usdc.balanceOf(address(this));
            auction.sweepCurrency();
            raised = usdc.balanceOf(address(this)) - balanceBefore;
            principal = raised;
            state = State.Active;
            activatedAt = uint64(block.timestamp);
        } else {
            state = State.Failed;
        }

        auction.sweepUnsoldTokens();
        uint256 unsoldBurned = note.balanceOf(address(this));
        if (unsoldBurned != 0) {
            note.burn(unsoldBurned);
        }

        emit AuctionSettled(graduated, raised, unsoldBurned);
        IAdvanceHub(hub).onAuctionSettled(loanId, graduated);
    }

    /// @notice Pays `amount` USDC to the card, charged against the current draw period's limit.
    /// Only callable by the card, only while Active.
    /// @param amount USDC to draw.
    function draw(uint256 amount) external nonReentrant {
        if (msg.sender != card) revert NotCard();
        if (state != State.Active) revert NotActive();

        uint64 period = currentPeriod();
        uint256 drawnSoFar = drawnInPeriod[period];
        uint256 available = drawLimit > drawnSoFar ? drawLimit - drawnSoFar : 0;
        if (amount > available) revert DrawLimitExceeded(amount, available);

        drawnInPeriod[period] = drawnSoFar + amount;
        totalDrawn += amount;

        emit Drawn(amount, period, available - amount);
        usdc.safeTransfer(card, amount);
    }

    /// @notice Freezes this credit line: distributes min(balance, note.remainingCap()) USDC to
    /// the revenue note and sends any remainder to the treasury. Only callable by the hub.
    function freeze() external nonReentrant {
        if (msg.sender != hub) revert NotHub();
        state = State.Frozen;

        uint256 balance = usdc.balanceOf(address(this));
        uint256 remainingCap = note.remainingCap();
        uint256 toNotes = balance < remainingCap ? balance : remainingCap;
        uint256 toTreasury = balance - toNotes;

        emit Frozen(toNotes, toTreasury);

        if (toNotes != 0) {
            usdc.forceApprove(address(note), toNotes);
            note.distribute(toNotes);
        }
        if (toTreasury != 0) {
            usdc.safeTransfer(treasury, toTreasury);
        }
    }

    /// @notice Closes this credit line, sweeping its entire USDC balance to the treasury. Only
    /// callable by the hub.
    function close() external nonReentrant {
        if (msg.sender != hub) revert NotHub();
        state = State.Closed;

        uint256 balance = usdc.balanceOf(address(this));
        emit Closed(balance);
        if (balance != 0) {
            usdc.safeTransfer(treasury, balance);
        }
    }

    /// @notice USDC still drawable in the current draw period.
    /// @return The remaining drawable USDC for `currentPeriod()`.
    function availableThisPeriod() external view returns (uint256) {
        uint256 drawnSoFar = drawnInPeriod[currentPeriod()];
        return drawLimit > drawnSoFar ? drawLimit - drawnSoFar : 0;
    }

    /// @notice The current draw period index, counted from `activatedAt`.
    /// @return The draw period index; 0 before activation.
    function currentPeriod() public view returns (uint64) {
        if (activatedAt == 0) return 0;
        return (uint64(block.timestamp) - activatedAt) / drawPeriod;
    }
}
