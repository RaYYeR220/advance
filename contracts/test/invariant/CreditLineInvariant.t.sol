// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {CreditLine} from "../../src/CreditLine.sol";
import {RevenueNote} from "../../src/RevenueNote.sol";
import {MockERC20, MockAuction, MockHub} from "../utils/Mocks.sol";

/// @notice Handler driving `draw` (unbounded amount, random caller, wrapped in try/catch so only
/// successful draws count) and arbitrary-second time warps against an already-Active CreditLine.
/// The per-period ghost bucket is computed independently of `creditLine.currentPeriod()` (from
/// an `activatedAt` snapshot taken once in `setUp`, plus `drawPeriod`), so a bug in that contract
/// function -- or in `activatedAt` itself, if it somehow drifted -- can't hide from the
/// invariants by consistently mis-bucketing both sides the same way.
contract CreditLineHandler is Test {
    CreditLine public creditLine;
    address public card;
    uint64 public immutable ghostDrawPeriod;
    /// @dev Snapshotted once in `setUp`, not re-read from the contract on every call.
    uint64 public immutable ghostActivatedAt;

    /// @dev Per-period cumulative draws, kept for debugging a failing run.
    mapping(uint64 period => uint256 drawn) public drawnInPeriod;
    /// @notice The highest cumulative-draws-in-a-single-period seen so far.
    uint256 public maxDrawnInAnyPeriod;
    /// @notice Sum of every amount successfully drawn.
    uint256 public sumDrawn;
    /// @notice Count of draw attempts that succeeded (always by `card`).
    uint256 public successfulDraws;
    /// @notice Set true if a `draw` call from anyone other than `card` ever succeeds. A plain
    /// `assertEq` inside the `try` success branch does not fail the invariant suite (a revert
    /// from a failed assertion inside a handler call is indistinguishable from any other
    /// handler-call revert to the runner), so this ghost flag is checked explicitly by
    /// `invariant_cardIsOnlyDrawRecipient` instead.
    bool public nonCardDrawSucceeded;

    constructor(CreditLine creditLine_, address card_, uint64 ghostActivatedAt_) {
        creditLine = creditLine_;
        card = card_;
        ghostDrawPeriod = creditLine_.drawPeriod();
        ghostActivatedAt = ghostActivatedAt_;
    }

    /// @dev Computed independently of `creditLine.currentPeriod()`: same formula, but evaluated
    /// here from a locally-held snapshot rather than by calling into the contract under test.
    function _ghostPeriod() internal view returns (uint64) {
        if (ghostActivatedAt == 0) return 0;
        return (uint64(block.timestamp) - ghostActivatedAt) / ghostDrawPeriod;
    }

    /// @notice Attempts a draw of an unbounded amount from a mostly-random caller (only `card`
    /// can ever succeed). Reverts (wrong caller, zero amount, over the period limit, insufficient
    /// USDC balance, ...) are swallowed; only a successful draw updates ghost accounting.
    function draw(uint256 amount, uint256 callerSeed) external {
        amount = bound(amount, 0, type(uint128).max);
        address caller =
            callerSeed % 4 == 0 ? card : address(uint160(uint256(keccak256(abi.encode("attacker", callerSeed)))));

        uint64 period = _ghostPeriod();

        vm.prank(caller);
        try creditLine.draw(amount) {
            if (caller != card) {
                nonCardDrawSucceeded = true;
                return;
            }
            uint256 newPeriodTotal = drawnInPeriod[period] + amount;
            drawnInPeriod[period] = newPeriodTotal;
            if (newPeriodTotal > maxDrawnInAnyPeriod) maxDrawnInAnyPeriod = newPeriodTotal;
            sumDrawn += amount;
            successfulDraws++;
        } catch {
            // Expected: wrong caller, zero amount, over the period limit, or insufficient balance.
        }
    }

    /// @notice Advances time by an arbitrary number of seconds (not restricted to whole periods).
    function warp(uint256 secondsElapsed) external {
        secondsElapsed = bound(secondsElapsed, 0, 30 days);
        vm.warp(block.timestamp + secondsElapsed);
    }
}

/// @notice Invariants for CreditLine's draw limit: no period's cumulative draws ever exceed
/// `drawLimit`, and `draw` never pays anyone but the card (proven by USDC conservation, since
/// `draw` is the only outgoing transfer this handler exercises).
contract CreditLineInvariantTest is Test {
    uint128 internal constant DRAW_LIMIT = 250_000;
    uint64 internal constant DRAW_PERIOD = 1 days;
    uint64 internal constant END_BLOCK = 1000;
    uint256 internal constant NOTE_SUPPLY = 5e18;
    uint256 internal constant RAISED = 10_000_000;

    MockERC20 internal usdc;
    MockHub internal hub;
    RevenueNote internal note;
    CreditLine internal creditLine;
    MockAuction internal auction;
    CreditLineHandler internal handler;

    address internal escrow = makeAddr("escrow");
    address internal card = makeAddr("card");
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        hub = new MockHub();
        vm.roll(1);

        note = new RevenueNote("Advance Note", "ADVN", address(hub), address(usdc));
        creditLine = new CreditLine(address(hub), address(usdc), card, treasury, DRAW_LIMIT, DRAW_PERIOD);
        auction = new MockAuction(address(usdc), address(note), address(creditLine), address(creditLine), END_BLOCK);

        vm.prank(address(hub));
        note.initialize(escrow, address(creditLine));
        vm.prank(address(hub));
        creditLine.initialize(1, address(auction), address(note));

        vm.prank(address(hub));
        note.mint(address(auction), NOTE_SUPPLY);
        usdc.mint(address(auction), RAISED);
        auction.setGraduated(true);

        vm.roll(END_BLOCK + 1);
        creditLine.settleAuction();

        handler = new CreditLineHandler(creditLine, card, creditLine.activatedAt());
        targetContract(address(handler));
    }

    /// @notice No draw period's cumulative draws ever exceed `drawLimit`.
    function invariant_perPeriodDrawsNeverExceedLimit() public view {
        assertLe(handler.maxDrawnInAnyPeriod(), DRAW_LIMIT);
    }

    /// @notice `draw` never pays anyone but the card: no non-card caller's draw ever succeeded,
    /// the card's USDC balance always equals `totalDrawn`, and every USDC that left the credit
    /// line is accounted for by `totalDrawn` (conservation against the swept principal).
    function invariant_cardIsOnlyDrawRecipient() public view {
        assertFalse(handler.nonCardDrawSucceeded());
        assertEq(usdc.balanceOf(card), creditLine.totalDrawn());
        assertEq(usdc.balanceOf(card), handler.sumDrawn());
        assertEq(usdc.balanceOf(address(creditLine)) + creditLine.totalDrawn(), creditLine.principal());
    }
}
