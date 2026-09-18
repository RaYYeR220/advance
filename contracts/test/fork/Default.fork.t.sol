// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AdvanceHub} from "../../src/AdvanceHub.sol";
import {CreditLine} from "../../src/CreditLine.sol";
import {RevenueEscrow} from "../../src/RevenueEscrow.sol";
import {RevenueNote} from "../../src/RevenueNote.sol";
import {IAdvance} from "../../src/interfaces/IAdvance.sol";
import {ICCA} from "../../src/interfaces/ICCA.sol";
import {IReputationRegistry} from "../../src/interfaces/IERC8004.sol";
import {ForkBase} from "./ForkBase.sol";

/// @notice What happens to a live loan whose agent stops trading: the fee stream goes quiet, the
/// grace period runs out, and anyone can mark the loan defaulted. The card freezes and hands its
/// drawn USDC back, the credit line's remaining principal is pushed to noteholders, and -100 is
/// written to the live ERC-8004 registry. The loan is not dead, though: the escrow keeps the fee
/// stream, and real volume through the pool later finishes the repayment and clears the record.
contract DefaultForkTest is ForkBase {
    uint128 internal constant BID_USDC = 2e6;
    uint256 internal constant SWAP_WETH = 0.2 ether;

    function test_markDefault_beforeTheGracePeriod_reverts() public {
        uint256 loanId = _openAndActivate();
        RevenueEscrow escrow = _escrow(loanId);
        uint64 eligibleAt = escrow.lastRevenueAt() + GRACE_PERIOD;
        assertEq(escrow.lastRevenueAt(), uint64(vm.getBlockTimestamp()), "the timer starts at activation");

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(AdvanceHub.NotDelinquent.selector, eligibleAt));
        hub.markDefault(loanId);

        vm.warp(eligibleAt);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(AdvanceHub.NotDelinquent.selector, eligibleAt));
        hub.markDefault(loanId);
    }

    function test_markDefault_freezesTheCardAndPushesPrincipalToNoteholders() public {
        uint256 loanId = _openAndActivate();
        CreditLine creditLine = _creditLine(loanId);
        RevenueEscrow escrow = _escrow(loanId);
        RevenueNote note = _note(loanId);

        uint256 principal = creditLine.principal();
        vm.prank(agentOwner);
        card.drawCredit(address(creditLine), DRAW_LIMIT);
        assertEq(IERC20(USDC).balanceOf(address(card)), DRAW_LIMIT, "card drew real USDC");

        // No swaps: the pool stops paying fees and the escrow's timer never moves.
        vm.warp(uint256(escrow.lastRevenueAt()) + GRACE_PERIOD + 1);
        assertEq(note.totalRepaid(), 0, "nothing repaid before the default");

        vm.prank(keeper);
        uint256 before = gasleft();
        hub.markDefault(loanId);
        uint256 gasUsed = before - gasleft();
        console2.log("markDefault gas", gasUsed);
        assertLt(gasUsed, 2_400_000, "within a keeper's budget");

        _assertStatus(loanId, IAdvance.LoanStatus.Defaulted);
        assertEq(uint8(creditLine.state()), uint8(CreditLine.State.Frozen), "credit line frozen");
        assertTrue(card.frozen(), "card frozen");
        assertEq(IERC20(USDC).balanceOf(address(card)), 0, "card's USDC returned to the credit line");
        assertEq(IERC20(USDC).balanceOf(address(creditLine)), 0, "credit line emptied by the freeze");
        // Everything the loan still held -- undrawn principal plus what the card gave back -- is
        // now noteholders' money.
        _logUsdc("recovered to noteholders", note.totalRepaid());
        assertEq(note.totalRepaid(), principal, "the whole principal reached the note");
        assertGt(note.remainingCap(), 0, "still short of the cap, so the loan stays Defaulted");
        assertEq(uint8(escrow.phase()), uint8(RevenueEscrow.Phase.Active), "escrow keeps the fee stream");
        assertEq(_shares(address(escrow)), CREATOR_SHARES, "shares stay pledged while the loan is open");
        assertEq(hub.liveLoanOf(address(card)), loanId, "a defaulted loan keeps its card bound");

        (int128 value, string memory tag1, string memory tag2) = _readHubFeedback(1);
        assertEq(value, -100, "default feedback value");
        assertEq(tag1, "advance", "tag1");
        assertEq(tag2, "default", "tag2");
    }

    function test_defaultedLoan_stillRepaysFromLaterFees() public {
        uint256 loanId = _openAndActivate();
        CreditLine creditLine = _creditLine(loanId);
        RevenueEscrow escrow = _escrow(loanId);
        RevenueNote note = _note(loanId);

        vm.prank(agentOwner);
        card.drawCredit(address(creditLine), DRAW_LIMIT);
        vm.warp(uint256(escrow.lastRevenueAt()) + GRACE_PERIOD + 1);
        vm.prank(keeper);
        hub.markDefault(loanId);
        _assertStatus(loanId, IAdvance.LoanStatus.Defaulted);

        uint256 shortfall = note.remainingCap();
        _logUsdc("shortfall after the default", shortfall);
        assertGt(shortfall, 0, "the default left a shortfall");

        // The agent starts trading again: real volume, real fees, and the escrow keeps sweeping.
        uint256 harvests;
        while (hub.loan(loanId).status == IAdvance.LoanStatus.Defaulted && harvests < 6) {
            _buyWeth(SWAP_WETH);
            (uint256 repaid,) = _harvest(loanId);
            harvests++;
            _logUsdc("late harvest distributed", repaid);
        }

        _assertStatus(loanId, IAdvance.LoanStatus.Repaid);
        assertEq(note.remainingCap(), 0, "cap filled after the default");
        assertEq(note.totalRepaid(), note.capUsdc(), "noteholders made whole");
        assertEq(uint8(escrow.phase()), uint8(RevenueEscrow.Phase.Closed), "escrow closed");
        assertEq(_shares(POOL_CREATOR), CREATOR_SHARES, "beneficiary share returned to the agent");
        // The credit line stays Frozen: a late repayment never un-freezes it, it only ends the loan.
        assertEq(uint8(creditLine.state()), uint8(CreditLine.State.Frozen), "credit line stays frozen");
        assertFalse(card.frozen(), "card unfrozen once the note is whole");
        assertEq(hub.liveLoanOf(address(card)), 0, "card released");

        // Both outcomes are on the live registry, in order.
        assertEq(IReputationRegistry(REPUTATION_REGISTRY).getLastIndex(agentId, address(hub)), 2, "two entries");
        (int128 first,,) = _readHubFeedback(1);
        (int128 second,, string memory secondTag) = _readHubFeedback(2);
        assertEq(first, -100, "default recorded");
        assertEq(second, 100, "repayment recorded");
        assertEq(secondTag, "repaid", "tag2");
    }

    /// @dev Opens the fixture loan and runs its auction to a graduated settlement.
    function _openAndActivate() internal returns (uint256 loanId) {
        (loanId,) = _open(_termSheet());
        ICCA auction = _auction(loanId);
        // Clear the fee backlog while the escrow is still Pending, so the loan starts Active with
        // nothing owed to it and the default timer measures real silence.
        _harvest(loanId);
        _rollTo(vm.getBlockNumber() + 1);
        _bid(bidderA, address(auction), 90, BID_USDC);
        _bid(bidderB, address(auction), 85, BID_USDC);
        _endAuctionAndSettle(loanId);
        _assertStatus(loanId, IAdvance.LoanStatus.Active);
    }
}
