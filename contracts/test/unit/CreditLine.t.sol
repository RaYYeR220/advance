// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {CreditLine} from "../../src/CreditLine.sol";
import {RevenueNote} from "../../src/RevenueNote.sol";
import {MockERC20, MockAuction, MockHub} from "../utils/Mocks.sol";

/// @notice Unit tests for CreditLine: auction settlement (graduated/failed), the per-period draw
/// limit, freeze's split to notes/treasury, and close.
contract CreditLineTest is Test {
    uint256 internal constant LOAN_ID = 7;
    uint256 internal constant NOTE_SUPPLY = 5e18; // capUsdc = 5_000_000
    uint128 internal constant DRAW_LIMIT = 250_000;
    uint64 internal constant DRAW_PERIOD = 1 days;
    uint64 internal constant END_BLOCK = 1000;

    MockERC20 internal usdc;
    MockHub internal hub;
    address internal escrow = makeAddr("escrow");
    address internal card = makeAddr("card");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");

    RevenueNote internal note;
    CreditLine internal creditLine;
    MockAuction internal auction;

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
        creditLine.initialize(LOAN_ID, address(auction), address(note));
    }

    /// @dev Mints the full note supply to the auction (as production would) so `settleAuction`
    /// has unsold notes to sweep and burn.
    function _mintNoteSupplyToAuction() internal {
        vm.prank(address(hub));
        note.mint(address(auction), NOTE_SUPPLY);
    }

    function _settleGraduated(uint256 raised) internal {
        _mintNoteSupplyToAuction();
        usdc.mint(address(auction), raised);
        auction.setGraduated(true);
        vm.roll(END_BLOCK + 1);
        creditLine.settleAuction();
    }

    // -- 1. settleAuction: before endBlock => AuctionLive; twice => AlreadySettled --

    function test_settleAuction_beforeEndBlockReverts() public {
        vm.expectRevert(CreditLine.AuctionLive.selector);
        creditLine.settleAuction();
    }

    function test_settleAuction_twiceReverts() public {
        _settleGraduated(1_000_000);

        vm.expectRevert(CreditLine.AlreadySettled.selector);
        creditLine.settleAuction();
    }

    // -- 2. graduated: principal = swept USDC, unsold notes burned, hub callback (loanId,true),
    // state Active, activatedAt = block.timestamp --

    function test_settleAuction_graduatedActivates() public {
        _mintNoteSupplyToAuction();
        usdc.mint(address(auction), 3_000_000);
        auction.setGraduated(true);

        vm.roll(END_BLOCK + 1);
        vm.warp(12345);
        creditLine.settleAuction();

        assertEq(creditLine.principal(), 3_000_000);
        assertEq(usdc.balanceOf(address(creditLine)), 3_000_000);
        assertEq(note.balanceOf(address(creditLine)), 0);
        assertEq(note.totalSupply(), 0); // entire unsold supply was burned
        assertEq(uint8(creditLine.state()), uint8(CreditLine.State.Active));
        assertEq(creditLine.activatedAt(), 12345);

        assertEq(hub.callCount(), 1);
        assertEq(hub.lastLoanId(), LOAN_ID);
        assertTrue(hub.lastGraduated());
    }

    // -- 3. not graduated: state Failed, hub callback (loanId,false), draw => NotActive --

    function test_settleAuction_notGraduatedFails() public {
        _mintNoteSupplyToAuction();
        auction.setGraduated(false);

        vm.roll(END_BLOCK + 1);
        creditLine.settleAuction();

        assertEq(creditLine.principal(), 0);
        assertEq(note.balanceOf(address(creditLine)), 0);
        assertEq(uint8(creditLine.state()), uint8(CreditLine.State.Failed));

        assertEq(hub.callCount(), 1);
        assertEq(hub.lastLoanId(), LOAN_ID);
        assertFalse(hub.lastGraduated());

        vm.prank(card);
        vm.expectRevert(CreditLine.NotActive.selector);
        creditLine.draw(1);
    }

    // -- 4. draw: non-card => NotCard; limit enforced with exact error data; resets next period --

    function test_draw_accessControlAndPerPeriodLimit() public {
        _settleGraduated(300_000);

        vm.prank(alice);
        vm.expectRevert(CreditLine.NotCard.selector);
        creditLine.draw(1);

        vm.prank(card);
        creditLine.draw(DRAW_LIMIT);
        assertEq(usdc.balanceOf(card), DRAW_LIMIT);
        assertEq(creditLine.availableThisPeriod(), 0);

        vm.prank(card);
        vm.expectRevert(abi.encodeWithSelector(CreditLine.DrawLimitExceeded.selector, 1, 0));
        creditLine.draw(1);

        vm.warp(block.timestamp + DRAW_PERIOD);
        assertEq(creditLine.availableThisPeriod(), DRAW_LIMIT);

        vm.prank(card);
        creditLine.draw(1);
        assertEq(usdc.balanceOf(card), DRAW_LIMIT + 1);
        assertEq(creditLine.totalDrawn(), DRAW_LIMIT + 1);
    }

    // -- 5. freeze: balance 3e6, note.remainingCap() 2e6 => 2e6 distributed, 1e6 to treasury;
    // draw after => NotActive --

    function test_freeze_splitsBetweenNoteAndTreasury() public {
        // Note supply corresponds to a 2_000_000 cap; sell the whole supply away from the
        // auction first so settlement has nothing unsold to burn.
        vm.prank(address(hub));
        note.mint(address(auction), 2e18);
        vm.prank(address(auction));
        assertTrue(note.transfer(alice, 2e18));

        usdc.mint(address(auction), 3_000_000);
        auction.setGraduated(true);
        vm.roll(END_BLOCK + 1);
        creditLine.settleAuction();

        assertEq(creditLine.principal(), 3_000_000);
        assertEq(note.remainingCap(), 2_000_000);

        vm.prank(address(hub));
        creditLine.freeze();

        assertEq(note.totalRepaid(), 2_000_000);
        assertEq(usdc.balanceOf(treasury), 1_000_000);
        assertEq(usdc.balanceOf(address(creditLine)), 0);
        assertEq(uint8(creditLine.state()), uint8(CreditLine.State.Frozen));

        vm.prank(card);
        vm.expectRevert(CreditLine.NotActive.selector);
        creditLine.draw(1);
    }

    function test_freeze_onlyHub() public {
        vm.prank(alice);
        vm.expectRevert(CreditLine.NotHub.selector);
        creditLine.freeze();
    }

    // -- 6. close: balance to treasury --

    function test_close_sweepsBalanceToTreasury() public {
        _settleGraduated(1_500_000);

        vm.prank(address(hub));
        creditLine.close();

        assertEq(usdc.balanceOf(treasury), 1_500_000);
        assertEq(usdc.balanceOf(address(creditLine)), 0);
        assertEq(uint8(creditLine.state()), uint8(CreditLine.State.Closed));
    }

    function test_close_onlyHub() public {
        vm.prank(alice);
        vm.expectRevert(CreditLine.NotHub.selector);
        creditLine.close();
    }

    // -- initialize: onlyHub, once --

    function test_initialize_onlyHubOnce() public {
        CreditLine fresh = new CreditLine(address(hub), address(usdc), card, treasury, DRAW_LIMIT, DRAW_PERIOD);

        vm.prank(alice);
        vm.expectRevert(CreditLine.NotHub.selector);
        fresh.initialize(LOAN_ID, address(auction), address(note));

        vm.prank(address(hub));
        fresh.initialize(LOAN_ID, address(auction), address(note));

        vm.prank(address(hub));
        vm.expectRevert(CreditLine.AlreadyInitialized.selector);
        fresh.initialize(LOAN_ID, address(auction), address(note));
    }

    // -- constructor: rejects zero addresses and zero draw period --

    function test_constructor_revertsOnZeroAddressOrPeriod() public {
        vm.expectRevert(CreditLine.ZeroAddress.selector);
        new CreditLine(address(0), address(usdc), card, treasury, DRAW_LIMIT, DRAW_PERIOD);

        vm.expectRevert(CreditLine.ZeroDrawPeriod.selector);
        new CreditLine(address(hub), address(usdc), card, treasury, DRAW_LIMIT, 0);
    }
}
