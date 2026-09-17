// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {RevenueNote} from "../../src/RevenueNote.sol";
import {MockERC20} from "../utils/Mocks.sol";

/// @notice Unit tests for RevenueNote: access control, pro-rata distribution, transferable
/// accrued-but-unclaimed repayment, claiming, and cap-reducing burns.
contract RevenueNoteTest is Test {
    RevenueNote internal note;
    MockERC20 internal usdc;

    address internal hub = makeAddr("hub");
    address internal escrow = makeAddr("escrow");
    address internal creditLine = makeAddr("creditLine");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        note = new RevenueNote("Advance Note", "ADVN", hub, address(usdc));
    }

    function _initialize() internal {
        vm.prank(hub);
        note.initialize(escrow, creditLine);
    }

    function _mint(address to, uint256 amount) internal {
        vm.prank(hub);
        note.mint(to, amount);
    }

    function _fundDistributor(address distributor, uint256 amount) internal {
        usdc.mint(distributor, amount);
        vm.prank(distributor);
        usdc.approve(address(note), amount);
    }

    // -- construction / decimals --

    function test_decimals_is18() public view {
        assertEq(note.decimals(), 18);
    }

    // -- initialize: onlyHub, once --

    function test_initialize_onlyHubOnce() public {
        vm.prank(alice);
        vm.expectRevert(RevenueNote.NotHub.selector);
        note.initialize(escrow, creditLine);

        _initialize();
        assertEq(note.escrow(), escrow);
        assertEq(note.creditLine(), creditLine);

        vm.prank(hub);
        vm.expectRevert(RevenueNote.AlreadyInitialized.selector);
        note.initialize(escrow, creditLine);
    }

    // 1. mint once; second mint => AlreadyInitialized; non-hub => NotHub.
    function test_mint_onlyHubOnce() public {
        vm.prank(alice);
        vm.expectRevert(RevenueNote.NotHub.selector);
        note.mint(alice, 1e18);

        _mint(alice, 5e18);
        assertEq(note.totalSupply(), 5e18);

        vm.prank(hub);
        vm.expectRevert(RevenueNote.AlreadyInitialized.selector);
        note.mint(alice, 1e18);
    }

    // 2. holders A 3e18 / B 2e18, distribute 1_000_000 => claimable A 600_000, B 400_000 (+-1 wei).
    function test_distribute_splitsProRata() public {
        _initialize();
        _mint(alice, 5e18);
        vm.prank(alice);
        assertTrue(note.transfer(bob, 2e18)); // alice 3e18, bob 2e18

        _fundDistributor(escrow, 1_000_000);
        vm.prank(escrow);
        note.distribute(1_000_000);

        assertApproxEqAbs(note.claimable(alice), 600_000, 1);
        assertApproxEqAbs(note.claimable(bob), 400_000, 1);
        assertEq(note.totalRepaid(), 1_000_000);
    }

    function test_distribute_onlyEscrowOrCreditLine() public {
        _initialize();
        _mint(alice, 5e18);

        vm.prank(alice);
        vm.expectRevert(RevenueNote.NotDistributor.selector);
        note.distribute(1);
    }

    // 3. distribute more than remaining cap (cap 5 USDC) => ExceedsCap.
    function test_distribute_revertsIfExceedsCap() public {
        _initialize();
        _mint(alice, 5e18); // capUsdc = 5e18 / 1e12 = 5_000_000

        _fundDistributor(escrow, 5_000_001);
        vm.prank(escrow);
        vm.expectRevert(abi.encodeWithSelector(RevenueNote.ExceedsCap.selector, 5_000_001, 5_000_000));
        note.distribute(5_000_001);
    }

    // 4. after distribute 1_000_000, A transfers 1.5e18 to C => claimable A 300_000, C 300_000, B 400_000;
    // then distribute 500_000 => A +150_000, C +150_000, B +200_000.
    function test_transfer_movesAccruedUnclaimedRepayment() public {
        _initialize();
        _mint(alice, 5e18);
        vm.prank(alice);
        assertTrue(note.transfer(bob, 2e18)); // alice 3e18, bob 2e18

        _fundDistributor(escrow, 1_000_000);
        vm.prank(escrow);
        note.distribute(1_000_000);

        vm.prank(alice);
        assertTrue(note.transfer(carol, 1.5e18)); // alice 1.5e18, carol 1.5e18

        assertApproxEqAbs(note.claimable(alice), 300_000, 1);
        assertApproxEqAbs(note.claimable(carol), 300_000, 1);
        assertApproxEqAbs(note.claimable(bob), 400_000, 1);

        uint256 aliceBefore = note.claimable(alice);
        uint256 carolBefore = note.claimable(carol);
        uint256 bobBefore = note.claimable(bob);

        _fundDistributor(escrow, 500_000);
        vm.prank(escrow);
        note.distribute(500_000);

        assertApproxEqAbs(note.claimable(alice) - aliceBefore, 150_000, 1);
        assertApproxEqAbs(note.claimable(carol) - carolBefore, 150_000, 1);
        assertApproxEqAbs(note.claimable(bob) - bobBefore, 200_000, 1);
    }

    // 5. claim transfers USDC and zeroes claimable; claimFor pays the holder not the caller.
    function test_claim_paysAndZeroesClaimable() public {
        _initialize();
        _mint(alice, 5e18);
        _fundDistributor(escrow, 1_000_000);
        vm.prank(escrow);
        note.distribute(1_000_000);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 paid = note.claim();

        assertEq(paid, 1_000_000);
        assertEq(usdc.balanceOf(alice) - before, 1_000_000);
        assertEq(note.claimable(alice), 0);
    }

    function test_claimFor_paysHolderNotCaller() public {
        _initialize();
        _mint(alice, 5e18);
        _fundDistributor(escrow, 1_000_000);
        vm.prank(escrow);
        note.distribute(1_000_000);

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);

        vm.prank(bob); // caller is bob, not the holder
        uint256 paid = note.claimFor(alice);

        assertEq(paid, 1_000_000);
        assertEq(usdc.balanceOf(alice) - aliceBefore, 1_000_000);
        assertEq(usdc.balanceOf(bob), bobBefore);
    }

    // 6. burn by non-creditLine => revert; burn reduces cap: supply 5e18 burn 1e18 => capUsdc()==4e6.
    function test_burn_onlyCreditLineReducesCap() public {
        _initialize();
        _mint(creditLine, 5e18); // unsold notes held by the credit line after settlement

        vm.prank(alice);
        vm.expectRevert(RevenueNote.NotDistributor.selector);
        note.burn(1e18);

        vm.prank(creditLine);
        note.burn(1e18);

        assertEq(note.capUsdc(), 4e6);
        assertEq(note.totalSupply(), 4e18);
    }
}
