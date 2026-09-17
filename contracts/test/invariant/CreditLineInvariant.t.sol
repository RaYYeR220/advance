// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {CreditLine} from "../../src/CreditLine.sol";
import {RevenueNote} from "../../src/RevenueNote.sol";
import {MockERC20, MockAuction, MockHub} from "../utils/Mocks.sol";

/// @notice Bounded-input handler driving `draw` (and period warps) against an already-Active
/// CreditLine. Ghost state (`maxDrawnInAnyPeriod`, `sumDrawn`) is updated incrementally on every
/// call so the invariants below stay O(1) instead of re-scanning draw history each check.
contract CreditLineHandler is Test {
    CreditLine public creditLine;
    address public card;

    /// @dev Per-period cumulative draws, kept for debugging a failing run.
    mapping(uint64 period => uint256 drawn) public drawnInPeriod;
    /// @notice The highest cumulative-draws-in-a-single-period seen so far.
    uint256 public maxDrawnInAnyPeriod;
    /// @notice Sum of every amount successfully drawn.
    uint256 public sumDrawn;

    constructor(CreditLine creditLine_, address card_) {
        creditLine = creditLine_;
        card = card_;
    }

    /// @notice Draws a bounded amount within the current period's remaining allowance.
    function draw(uint256 amount) external {
        uint256 available = creditLine.availableThisPeriod();
        if (available == 0) return;
        amount = bound(amount, 1, available);

        uint64 period = creditLine.currentPeriod();

        vm.prank(card);
        creditLine.draw(amount);

        uint256 newPeriodTotal = drawnInPeriod[period] + amount;
        drawnInPeriod[period] = newPeriodTotal;
        if (newPeriodTotal > maxDrawnInAnyPeriod) maxDrawnInAnyPeriod = newPeriodTotal;
        sumDrawn += amount;
    }

    /// @notice Advances time by a bounded number of whole periods, so multiple periods get
    /// exercised over the course of a run.
    function warpPeriods(uint256 periods) external {
        periods = bound(periods, 0, 5);
        vm.warp(block.timestamp + periods * creditLine.drawPeriod());
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

        handler = new CreditLineHandler(creditLine, card);
        targetContract(address(handler));
    }

    /// @notice No draw period's cumulative draws ever exceed `drawLimit`.
    function invariant_perPeriodDrawsNeverExceedLimit() public view {
        assertLe(handler.maxDrawnInAnyPeriod(), DRAW_LIMIT);
    }

    /// @notice `draw` never pays anyone but the card: the card's USDC balance always equals
    /// `totalDrawn`, and every USDC that left the credit line is accounted for by `totalDrawn`
    /// (conservation against the swept principal).
    function invariant_cardIsOnlyDrawRecipient() public view {
        assertEq(usdc.balanceOf(card), creditLine.totalDrawn());
        assertEq(usdc.balanceOf(card), handler.sumDrawn());
        assertEq(usdc.balanceOf(address(creditLine)) + creditLine.totalDrawn(), creditLine.principal());
    }
}
