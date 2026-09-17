// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {RevenueNote} from "../../src/RevenueNote.sol";
import {MockERC20} from "../utils/Mocks.sol";

/// @notice Bounded-input handler driving random distributions, transfers (direct and via
/// `transferFrom`), claims (self and `claimFor`), and the auction progressively selling its
/// held notes to actors, against a single RevenueNote.
contract NoteHandler is Test {
    RevenueNote public note;
    MockERC20 public usdc;
    address public distributor;
    address public auction;
    address[] public actors;

    uint256 public numDistributions;
    uint256 public sumClaimed;

    constructor(RevenueNote note_, MockERC20 usdc_, address distributor_, address auction_, address[] memory actors_) {
        note = note_;
        usdc = usdc_;
        distributor = distributor_;
        auction = auction_;
        actors = actors_;
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function distribute(uint256 amount) external {
        uint256 remaining = note.remainingCap();
        if (remaining == 0) return;
        amount = bound(amount, 0, remaining);
        // Zero-amount distributions are rejected by the note and shouldn't count toward the
        // dust bound (there is nothing to round away when nothing was distributed).
        if (amount == 0) return;

        usdc.mint(distributor, amount);
        vm.prank(distributor);
        usdc.approve(address(note), amount);
        vm.prank(distributor);
        note.distribute(amount);

        numDistributions++;
    }

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];

        uint256 balance = note.balanceOf(from);
        if (balance == 0) return;
        amount = bound(amount, 0, balance);

        vm.prank(from);
        assertTrue(note.transfer(to, amount));
    }

    function transferFrom(uint256 fromSeed, uint256 toSeed, uint256 spenderSeed, uint256 amount) external {
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        address spender = actors[spenderSeed % actors.length];

        uint256 balance = note.balanceOf(from);
        if (balance == 0) return;
        amount = bound(amount, 0, balance);

        vm.prank(from);
        assertTrue(note.approve(spender, amount));

        vm.prank(spender);
        assertTrue(note.transferFrom(from, to, amount));
    }

    function claim(uint256 actorSeed) external {
        address actor = actors[actorSeed % actors.length];

        vm.prank(actor);
        uint256 paid = note.claim();
        sumClaimed += paid;
    }

    function claimFor(uint256 callerSeed, uint256 holderSeed) external {
        address caller = actors[callerSeed % actors.length];
        address holder = actors[holderSeed % actors.length];

        vm.prank(caller);
        uint256 paid = note.claimFor(holder);
        sumClaimed += paid;
    }

    /// @notice The headline case: the auction still holds notes while distributions are
    /// accruing to it, and progressively sells pieces of its holding to actors, who then inherit
    /// the auction's proportional share of accrued-but-unclaimed repayment.
    function sellFromAuction(uint256 toSeed, uint256 amount) external {
        uint256 balance = note.balanceOf(auction);
        if (balance == 0) return;
        amount = bound(amount, 0, balance);
        if (amount == 0) return;

        address to = actors[toSeed % actors.length];
        vm.prank(auction);
        assertTrue(note.transfer(to, amount));
    }
}

/// @notice Invariants for RevenueNote's distribute/transfer/claim accounting: the cap is never
/// exceeded, claimable + claimed never exceeds what was actually distributed (up to bounded
/// rounding dust), and the note always holds enough USDC to cover outstanding claimables. The
/// auction holds the entire supply at the start and sells it off gradually over the run, so
/// distributions land on it before actors ever hold anything (the real CCA lifecycle).
contract NoteInvariantTest is Test {
    RevenueNote internal note;
    MockERC20 internal usdc;
    NoteHandler internal handler;

    address internal hub = makeAddr("hub");
    address internal escrow = makeAddr("escrow");
    address internal creditLine = makeAddr("creditLine");
    address internal auction = makeAddr("auction");

    address[] internal actors;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        note = new RevenueNote("Advance Note", "ADVN", hub, address(usdc));

        vm.prank(hub);
        note.initialize(escrow, creditLine);

        vm.prank(hub);
        note.mint(auction, 5e18);

        actors = new address[](5);
        for (uint256 i = 0; i < actors.length; i++) {
            actors[i] = makeAddr(string.concat("actor", vm.toString(i)));
        }

        // The auction holds the full supply going in; `sellFromAuction` sells pieces of it off
        // over the course of the fuzz run instead of everything being pre-distributed here.
        handler = new NoteHandler(note, usdc, escrow, auction, actors);
        targetContract(address(handler));
    }

    function invariant_totalRepaidNeverExceedsCap() public view {
        assertLe(note.totalRepaid(), note.capUsdc());
    }

    function invariant_claimablePlusClaimedNeverExceedsTotalRepaid() public view {
        assertLe(_sumClaimable() + handler.sumClaimed(), note.totalRepaid());
    }

    function invariant_outstandingDustIsBounded() public view {
        uint256 outstanding = note.totalRepaid() - (_sumClaimable() + handler.sumClaimed());
        assertLe(outstanding, handler.numDistributions() * (actors.length + 1));
    }

    function invariant_noteHoldsEnoughUsdcForClaimable() public view {
        assertGe(usdc.balanceOf(address(note)), _sumClaimable());
    }

    /// @dev Sums claimable over both the actors and the auction itself: the auction's notes
    /// accrue repayment even though it can never claim it directly, so it must be counted for
    /// the dust/coverage invariants to be meaningful while it still holds a balance.
    function _sumClaimable() internal view returns (uint256 total) {
        total = note.claimable(auction);
        for (uint256 i = 0; i < actors.length; i++) {
            total += note.claimable(actors[i]);
        }
    }
}
