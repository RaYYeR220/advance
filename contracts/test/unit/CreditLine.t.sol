// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {CreditLine} from "../../src/CreditLine.sol";
import {RevenueNote} from "../../src/RevenueNote.sol";
import {MockERC20, MockAuction, MockHub} from "../utils/Mocks.sol";

/// @notice Unit tests for CreditLine: auction settlement (graduated/failed/partial-sale, and the
/// lazy-checkpoint graduation hazard), state-machine guards, the per-period draw limit, freeze's
/// split to notes/treasury, close, and auction-wiring validation.
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

    function test_settleAuction_revertsFromFailedState() public {
        _mintNoteSupplyToAuction();
        auction.setGraduated(false);
        vm.roll(END_BLOCK + 1);
        creditLine.settleAuction();

        // Failed is terminal: a second attempt still reverts, not just a re-run of graduated logic.
        vm.expectRevert(CreditLine.AlreadySettled.selector);
        creditLine.settleAuction();
    }

    // -- CRITICAL regression: real CCA v2.1.0's `isGraduated()` reads a lazily-checkpointed
    // storage slot ($currencyRaisedQ96X7) that only updates via `checkpoint`/`sweepCurrency`/
    // `sweepUnsoldTokens`. If `settleAuction` read `isGraduated()` BEFORE sweeping currency, an
    // auction with bids that graduated it but was never externally checkpointed would read as
    // stale-false, get marked Failed, and skip `sweepCurrency` entirely -- stranding the raised
    // USDC in the auction forever (only `fundsRecipient`, i.e. this contract, may sweep it, and
    // `state` would already be terminal). `settleAuction` must sweep currency (which itself
    // checkpoints) BEFORE reading graduation. --

    function test_settleAuction_graduatesEvenWithoutExternalCheckpoint() public {
        _mintNoteSupplyToAuction();
        usdc.mint(address(auction), 4_200_000);
        auction.setGraduated(true); // sets pendingGraduated; nothing has checkpointed yet

        assertFalse(auction.isGraduated()); // stale, exactly like real CCA before any checkpoint

        vm.roll(END_BLOCK + 1);
        creditLine.settleAuction(); // must checkpoint (via sweepCurrency) before reading graduation

        assertEq(creditLine.principal(), 4_200_000);
        assertEq(usdc.balanceOf(address(creditLine)), 4_200_000);
        assertEq(usdc.balanceOf(address(auction)), 0); // nothing stranded in the auction
        assertEq(uint8(creditLine.state()), uint8(CreditLine.State.Active));
        assertEq(hub.callCount(), 1);
        assertTrue(hub.lastGraduated());
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

    // -- Important #4/#9: partial sale -- 5e18 supply, 3e18 sold at $0.90 => principal 2.7e6,
    // only 2e18 unsold burned (the 3e18 sold stays inside the auction, unclaimed, at settle
    // time -- real CCA: filled bids sit in the auction until each bidder calls `claimTokens`,
    // which reverts before graduation), note.capUsdc() becomes 3e6, and the bidder can claim
    // their 3e18 from the auction afterwards. --

    function test_settleAuction_partialSaleBurnsOnlyUnsoldRemainder() public {
        _mintNoteSupplyToAuction(); // full 5e18 supply sits in the auction; nothing moves at sale time
        uint256 bidId = auction.recordSale(alice, 3e18); // 3e18 filled/sold to alice, still held by the auction

        usdc.mint(address(auction), 2_700_000); // 3e18 notes * $0.90 raised
        auction.setGraduated(true);

        vm.roll(END_BLOCK + 1);
        creditLine.settleAuction();

        assertEq(creditLine.principal(), 2_700_000);
        assertEq(usdc.balanceOf(address(creditLine)), 2_700_000);
        assertEq(note.balanceOf(address(creditLine)), 0); // swept-in unsold burned
        assertEq(note.balanceOf(address(auction)), 3e18); // sold notes still held, awaiting claim
        assertEq(note.totalSupply(), 3e18); // 5e18 - 2e18 unsold burned
        assertEq(note.capUsdc(), 3_000_000);
        assertEq(uint8(creditLine.state()), uint8(CreditLine.State.Active));

        // The bidder claims their filled notes from the auction after settlement.
        assertEq(note.balanceOf(alice), 0);
        auction.claimTokens(bidId);
        assertEq(note.balanceOf(alice), 3e18);
        assertEq(note.balanceOf(address(auction)), 0);
    }

    // -- 3. not graduated: state Failed, hub callback (loanId,false), draw => NotActive.
    // Important #9: USDC sitting in the auction (simulating unrefunded bids) is never swept, and
    // the entire note supply is burned as unsold. --

    function test_settleAuction_notGraduatedFails() public {
        _mintNoteSupplyToAuction();
        usdc.mint(address(auction), 500_000); // currency sitting in the auction from bids
        auction.setGraduated(false);

        vm.roll(END_BLOCK + 1);
        creditLine.settleAuction();

        assertEq(creditLine.principal(), 0);
        assertEq(usdc.balanceOf(address(creditLine)), 0); // nothing swept
        assertEq(usdc.balanceOf(address(auction)), 500_000); // stays for bidders to reclaim
        assertEq(note.balanceOf(address(creditLine)), 0);
        assertEq(note.totalSupply(), 0); // entire unsold supply burned
        assertEq(uint8(creditLine.state()), uint8(CreditLine.State.Failed));

        assertEq(hub.callCount(), 1);
        assertEq(hub.lastLoanId(), LOAN_ID);
        assertFalse(hub.lastGraduated());

        vm.prank(card);
        vm.expectRevert(CreditLine.NotActive.selector);
        creditLine.draw(1);
    }

    // -- 4. draw: non-card => NotCard; zero amount => ZeroAmount; limit enforced with exact
    // error data; resets next period --

    function test_draw_accessControlAndPerPeriodLimit() public {
        _settleGraduated(300_000);

        vm.prank(alice);
        vm.expectRevert(CreditLine.NotCard.selector);
        creditLine.draw(1);

        vm.prank(card);
        creditLine.draw(DRAW_LIMIT);
        assertEq(usdc.balanceOf(card), DRAW_LIMIT);
        assertEq(creditLine.availableThisPeriod(), 0); // period limit exhausted

        vm.prank(card);
        vm.expectRevert(abi.encodeWithSelector(CreditLine.DrawLimitExceeded.selector, 1, 0));
        creditLine.draw(1);

        vm.warp(block.timestamp + DRAW_PERIOD);
        assertEq(creditLine.availableThisPeriod(), 300_000 - DRAW_LIMIT);

        vm.prank(card);
        creditLine.draw(1);
        assertEq(usdc.balanceOf(card), DRAW_LIMIT + 1);
        assertEq(creditLine.totalDrawn(), DRAW_LIMIT + 1);
    }

    function test_draw_revertsOnZeroAmount() public {
        _settleGraduated(300_000);

        vm.prank(card);
        vm.expectRevert(CreditLine.ZeroAmount.selector);
        creditLine.draw(0);
    }

    // -- Minor: draw must reject an amount that is within the period's theoretical limit but
    // exceeds the contract's actual USDC balance, with the same DrawLimitExceeded(requested,
    // available) shape availableThisPeriod already reports (available = balance, not the limit). --

    function test_draw_revertsWhenWithinLimitButAboveBalance() public {
        _settleGraduated(100_000); // balance 100_000 < drawLimit 250_000

        vm.prank(card);
        vm.expectRevert(abi.encodeWithSelector(CreditLine.DrawLimitExceeded.selector, 150_000, 100_000));
        creditLine.draw(150_000); // within the period limit, but above the actual balance
    }

    // -- Minor #6: availableThisPeriod is 0 unless Active, and caps to the actual USDC balance,
    // not just the theoretical period limit. --

    function test_availableThisPeriod_zeroUnlessActiveAndCapsToBalance() public {
        assertEq(creditLine.availableThisPeriod(), 0); // Pending: not yet settled

        _settleGraduated(100_000); // balance 100_000 < drawLimit 250_000
        assertEq(creditLine.availableThisPeriod(), 100_000); // capped to actual balance

        vm.prank(card);
        creditLine.draw(100_000);
        assertEq(creditLine.availableThisPeriod(), 0); // balance exhausted, period limit unused

        vm.prank(address(hub));
        creditLine.close();
        assertEq(creditLine.availableThisPeriod(), 0); // Closed, not Active
    }

    // -- Important #2: state-machine guards. settleAuction only from Pending (covered above via
    // AlreadySettled); freeze/close only from Active; Frozen/Closed/Failed are terminal. --

    function test_freeze_revertsBeforeSettleThenSettleAuctionStillSucceeds() public {
        vm.prank(address(hub));
        vm.expectRevert(abi.encodeWithSelector(CreditLine.InvalidState.selector, CreditLine.State.Pending));
        creditLine.freeze();

        // The failed attempt must not have corrupted state.
        _settleGraduated(1_000_000);
        assertEq(uint8(creditLine.state()), uint8(CreditLine.State.Active));
    }

    function test_close_revertsBeforeSettleThenSettleAuctionStillSucceeds() public {
        vm.prank(address(hub));
        vm.expectRevert(abi.encodeWithSelector(CreditLine.InvalidState.selector, CreditLine.State.Pending));
        creditLine.close();

        _settleGraduated(1_000_000);
        assertEq(uint8(creditLine.state()), uint8(CreditLine.State.Active));
    }

    function test_freeze_revertsIfAlreadyFrozen() public {
        _settleGraduated(1_000_000);
        vm.prank(address(hub));
        creditLine.freeze();

        vm.prank(address(hub));
        vm.expectRevert(abi.encodeWithSelector(CreditLine.InvalidState.selector, CreditLine.State.Frozen));
        creditLine.freeze();
    }

    function test_close_revertsIfAlreadyClosed() public {
        _settleGraduated(1_000_000);
        vm.prank(address(hub));
        creditLine.close();

        vm.prank(address(hub));
        vm.expectRevert(abi.encodeWithSelector(CreditLine.InvalidState.selector, CreditLine.State.Closed));
        creditLine.close();
    }

    function test_freeze_revertsAfterClose() public {
        _settleGraduated(1_000_000);
        vm.prank(address(hub));
        creditLine.close();

        vm.prank(address(hub));
        vm.expectRevert(abi.encodeWithSelector(CreditLine.InvalidState.selector, CreditLine.State.Closed));
        creditLine.freeze();
    }

    function test_close_revertsAfterFreeze() public {
        _settleGraduated(1_000_000);
        vm.prank(address(hub));
        creditLine.freeze();

        vm.prank(address(hub));
        vm.expectRevert(abi.encodeWithSelector(CreditLine.InvalidState.selector, CreditLine.State.Frozen));
        creditLine.close();
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
        MockAuction freshAuction =
            new MockAuction(address(usdc), address(note), address(fresh), address(fresh), END_BLOCK);

        vm.prank(alice);
        vm.expectRevert(CreditLine.NotHub.selector);
        fresh.initialize(LOAN_ID, address(freshAuction), address(note));

        vm.prank(address(hub));
        fresh.initialize(LOAN_ID, address(freshAuction), address(note));

        vm.prank(address(hub));
        vm.expectRevert(CreditLine.AlreadyInitialized.selector);
        fresh.initialize(LOAN_ID, address(freshAuction), address(note));
    }

    // -- Minor #8: initialize verifies the auction is actually wired to this credit line. --

    function test_initialize_revertsOnBadAuctionWiring() public {
        CreditLine fresh = new CreditLine(address(hub), address(usdc), card, treasury, DRAW_LIMIT, DRAW_PERIOD);

        MockAuction wrongFunds = new MockAuction(address(usdc), address(note), alice, address(fresh), END_BLOCK);
        vm.prank(address(hub));
        vm.expectRevert(CreditLine.InvalidAuctionWiring.selector);
        fresh.initialize(LOAN_ID, address(wrongFunds), address(note));

        MockAuction wrongTokens = new MockAuction(address(usdc), address(note), address(fresh), alice, END_BLOCK);
        vm.prank(address(hub));
        vm.expectRevert(CreditLine.InvalidAuctionWiring.selector);
        fresh.initialize(LOAN_ID, address(wrongTokens), address(note));

        MockERC20 otherCurrency = new MockERC20("Other", "OTH", 6);
        MockAuction wrongCurrency =
            new MockAuction(address(otherCurrency), address(note), address(fresh), address(fresh), END_BLOCK);
        vm.prank(address(hub));
        vm.expectRevert(CreditLine.InvalidAuctionWiring.selector);
        fresh.initialize(LOAN_ID, address(wrongCurrency), address(note));

        RevenueNote otherNote = new RevenueNote("Other Note", "ON", address(hub), address(usdc));
        MockAuction wrongToken =
            new MockAuction(address(usdc), address(otherNote), address(fresh), address(fresh), END_BLOCK);
        vm.prank(address(hub));
        vm.expectRevert(CreditLine.InvalidAuctionWiring.selector);
        fresh.initialize(LOAN_ID, address(wrongToken), address(note));

        // Correctly wired still succeeds.
        MockAuction correct = new MockAuction(address(usdc), address(note), address(fresh), address(fresh), END_BLOCK);
        vm.prank(address(hub));
        fresh.initialize(LOAN_ID, address(correct), address(note));
    }

    // -- constructor: rejects zero addresses and zero draw period --

    function test_constructor_revertsOnZeroAddressOrPeriod() public {
        vm.expectRevert(CreditLine.ZeroAddress.selector);
        new CreditLine(address(0), address(usdc), card, treasury, DRAW_LIMIT, DRAW_PERIOD);

        vm.expectRevert(CreditLine.ZeroDrawPeriod.selector);
        new CreditLine(address(hub), address(usdc), card, treasury, DRAW_LIMIT, 0);
    }
}
