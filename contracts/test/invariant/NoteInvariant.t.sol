// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {RevenueNote} from "../../src/RevenueNote.sol";
import {MockERC20} from "../utils/Mocks.sol";

/// @notice Bounded-input handler driving random distributions, transfers between a fixed set
/// of actors, and claims against a single RevenueNote.
contract NoteHandler is Test {
    RevenueNote public note;
    MockERC20 public usdc;
    address public distributor;
    address[] public actors;

    uint256 public numDistributions;
    uint256 public sumClaimed;

    constructor(RevenueNote note_, MockERC20 usdc_, address distributor_, address[] memory actors_) {
        note = note_;
        usdc = usdc_;
        distributor = distributor_;
        actors = actors_;
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function distribute(uint256 amount) external {
        uint256 remaining = note.remainingCap();
        if (remaining == 0) return;
        amount = bound(amount, 0, remaining);

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

    function claim(uint256 actorSeed) external {
        address actor = actors[actorSeed % actors.length];

        vm.prank(actor);
        uint256 paid = note.claim();
        sumClaimed += paid;
    }
}

/// @notice Invariants for RevenueNote's distribute/transfer/claim accounting: the cap is never
/// exceeded, claimable + claimed never exceeds what was actually distributed (up to bounded
/// rounding dust), and the note always holds enough USDC to cover outstanding claimables.
contract NoteInvariantTest is Test {
    RevenueNote internal note;
    MockERC20 internal usdc;
    NoteHandler internal handler;

    address internal hub = makeAddr("hub");
    address internal escrow = makeAddr("escrow");
    address internal creditLine = makeAddr("creditLine");

    address[] internal actors;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        note = new RevenueNote("Advance Note", "ADVN", hub, address(usdc));

        vm.prank(hub);
        note.initialize(escrow, creditLine);

        address auction = makeAddr("auction");
        vm.prank(hub);
        note.mint(auction, 5e18);

        actors = new address[](5);
        for (uint256 i = 0; i < actors.length; i++) {
            actors[i] = makeAddr(string.concat("actor", vm.toString(i)));
        }

        vm.startPrank(auction);
        for (uint256 i = 0; i < actors.length; i++) {
            assertTrue(note.transfer(actors[i], 1e18));
        }
        vm.stopPrank();

        handler = new NoteHandler(note, usdc, escrow, actors);
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
        assertLe(outstanding, handler.numDistributions() * actors.length);
    }

    function invariant_noteHoldsEnoughUsdcForClaimable() public view {
        assertGe(usdc.balanceOf(address(note)), _sumClaimable());
    }

    function _sumClaimable() internal view returns (uint256 total) {
        for (uint256 i = 0; i < actors.length; i++) {
            total += note.claimable(actors[i]);
        }
    }
}
