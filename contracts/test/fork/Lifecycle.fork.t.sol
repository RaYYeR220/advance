// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AdvanceHub} from "../../src/AdvanceHub.sol";
import {CreditLine} from "../../src/CreditLine.sol";
import {RevenueEscrow} from "../../src/RevenueEscrow.sol";
import {RevenueNote} from "../../src/RevenueNote.sol";
import {IAdvance} from "../../src/interfaces/IAdvance.sol";
import {ICCA} from "../../src/interfaces/ICCA.sol";
import {IIdentityRegistry, IReputationRegistry} from "../../src/interfaces/IERC8004.sol";
import {TermSheet} from "../../src/lib/TermSheetLib.sol";
import {ForkBase, ICCAView} from "./ForkBase.sol";

/// @notice The happy path end to end against live Base: a real Doppler fee stream is pledged to a
/// predicted escrow, the note is sold through the real Uniswap CCA for real USDC, the agent draws
/// against the raised principal through its card, real swap volume through the pool's v4 hook
/// repays the note to its cap, the beneficiary shares go home and the outcome is written to the
/// live ERC-8004 reputation registry.
contract LifecycleForkTest is ForkBase {
    /// @notice USDC each bidder commits: 2.5 notes at the $0.80 floor.
    uint128 internal constant BID_USDC = 2e6;
    /// @notice WETH pushed through the pool per keeper round; its LP fee is worth ~$3 to the escrow,
    /// so the $5 cap takes more than one harvest to fill.
    uint256 internal constant SWAP_WETH = 0.2 ether;
    /// @notice Headroom over the ~9.55M `openLoan` costs here, nearly all of it contract creation.
    uint256 internal constant OPEN_LOAN_GAS_CEILING = 10_000_000;

    function test_openLoan_wiresTheLoanToLiveBaseContracts() public {
        TermSheet memory ts = _termSheet();
        address predicted = hub.predictEscrow(ts);
        assertEq(predicted.code.length, 0, "escrow predicted before deployment");
        assertEq(IIdentityRegistry(IDENTITY_REGISTRY).ownerOf(agentId), agentOwner, "agent owned by its EOA");
        assertTrue(agentOwner != address(hub), "hub is not the agent, so its feedback is not self-feedback");

        (uint256 loanId, uint256 gasUsed) = _open(ts);
        console2.log("openLoan gas", gasUsed);
        AdvanceHub.Loan memory loan = hub.loan(loanId);

        assertEq(loan.escrow, predicted, "escrow deployed at its predicted address");
        assertEq(_shares(loan.escrow), CREATOR_SHARES, "escrow holds the creator beneficiary share");
        assertEq(_shares(POOL_CREATOR), 0, "the treasury's share moved to the escrow");
        assertEq(uint8(loan.status), uint8(IAdvance.LoanStatus.Auction), "status");
        assertEq(hub.loanIdOf(_hash(ts)), loanId, "term sheet indexed by struct hash");
        assertEq(hub.liveLoanOf(address(card)), loanId, "card bound to the loan");

        ICCA auction = ICCA(loan.auction);
        assertEq(auction.currency(), USDC, "auction raises live USDC");
        assertEq(auction.token(), loan.note, "auction sells the loan's note");
        assertEq(auction.fundsRecipient(), loan.creditLine, "principal goes to the credit line");
        assertEq(auction.tokensRecipient(), loan.creditLine, "unsold notes go to the credit line");
        assertEq(IERC20(loan.note).balanceOf(loan.auction), NOTE_SUPPLY, "whole supply held by the auction");
        assertEq(_note(loanId).capUsdc(), CAP_USDC, "repayment cap");

        CreditLine creditLine = _creditLine(loanId);
        assertTrue(creditLine.initialized(), "credit line initialized");
        assertEq(address(creditLine.auction()), loan.auction, "credit line knows its auction");
        assertEq(_escrow(loanId).loanId(), loanId, "escrow bound");
        // Almost all of it is contract creation: ~3.8M for the auction the CCA factory deploys and
        // ~4.8M for the escrow, credit line and note. Measured at 9,552,584 against this fork.
        assertLt(gasUsed, OPEN_LOAN_GAS_CEILING, "openLoan stays within its gas budget");
    }

    function test_harvestBeforeActivation_forwardsTheFeeBacklogToTheTreasury() public {
        (uint256 loanId,) = _open(_termSheet());
        RevenueEscrow escrow = _escrow(loanId);
        assertEq(uint8(escrow.phase()), uint8(RevenueEscrow.Phase.Pending), "pending until the auction graduates");

        uint256 treasuryWeth = IERC20(WETH).balanceOf(POOL_CREATOR);
        uint256 treasuryToken = IERC20(AGENT_TOKEN).balanceOf(POOL_CREATOR);
        (uint256 repaid, uint256 gasUsed) = _harvest(loanId);

        uint256 wethOut = IERC20(WETH).balanceOf(POOL_CREATOR) - treasuryWeth;
        console2.log("pending harvest gas", gasUsed);
        console2.log("backlog WETH forwarded", wethOut);
        console2.log("agent token forwarded", IERC20(AGENT_TOKEN).balanceOf(POOL_CREATOR) - treasuryToken);

        assertEq(repaid, 0, "nothing is owed to noteholders before activation");
        assertGt(wethOut, 0, "the pool's accrued WETH fees reached the treasury");
        assertGt(IERC20(AGENT_TOKEN).balanceOf(POOL_CREATOR), treasuryToken, "agent leg forwarded");
        assertEq(IERC20(WETH).balanceOf(address(escrow)), 0, "escrow keeps nothing while pending");
        assertEq(escrow.lastRevenueAt(), 0, "the default timer only starts at activation");
    }

    function test_auction_clearsAtTheFloorAndFundsTheCreditLine() public {
        (uint256 loanId,) = _open(_termSheet());
        ICCA auction = _auction(loanId);
        _rollTo(vm.getBlockNumber() + 1);
        _bid(bidderA, address(auction), 90, BID_USDC);
        _bid(bidderB, address(auction), 85, BID_USDC);

        _rollTo(auction.endBlock());
        auction.checkpoint();
        uint256 clearing = ICCAView(address(auction)).clearingPrice();
        console2.log("clearing price, USDC-wei per note", clearing * 1e18 / (1 << 96));
        console2.log("currency raised", ICCAView(address(auction)).currencyRaised());
        // Demand exactly absorbs the supply at the floor, so the auction never ticks up and both
        // bids end strictly above the clearing price, which is what lets them leave through
        // `exitBid` instead of the CCA's partial-fill path.
        assertEq(clearing * 1e18 / (1 << 96), uint256(FLOOR_CENTS) * 1e4, "clears at the $0.80 floor");
        assertLt(clearing, TICK_Q96 * 85, "the lower bid is strictly above the clearing price");
        assertTrue(auction.isGraduated(), "raised at least minPrincipal");
        assertApproxEqAbs(ICCAView(address(auction)).totalCleared(), NOTE_SUPPLY, 1e3, "the whole supply cleared");
        assertLt(ICCAView(address(auction)).remainingSupply(), 1e3, "only note-wei dust left unsold");

        CreditLine creditLine = _creditLine(loanId);
        vm.prank(keeper);
        creditLine.settleAuction();

        uint256 principal = creditLine.principal();
        _logUsdc("principal", principal);
        assertEq(principal, IERC20(USDC).balanceOf(address(creditLine)), "principal is real USDC held here");
        // 5 notes cleared at the $0.80 floor, to the note-wei the auction could not split.
        assertApproxEqAbs(principal, CAP_USDC * FLOOR_CENTS / 100, 2, "principal is clearing x supply");
        assertGe(principal, MIN_PRINCIPAL, "graduation threshold");
        assertEq(uint8(creditLine.state()), uint8(CreditLine.State.Active), "credit line active");
        _assertStatus(loanId, IAdvance.LoanStatus.Active);
        assertEq(uint8(_escrow(loanId).phase()), uint8(RevenueEscrow.Phase.Active), "escrow now repays the note");
        assertApproxEqAbs(_note(loanId).capUsdc(), CAP_USDC, 2, "unsold dust burned off the cap");
    }

    function test_drawLimit_boundsTheCardWithinOnePeriod() public {
        uint256 loanId = _openAndActivate();
        CreditLine creditLine = _creditLine(loanId);
        assertEq(creditLine.availableThisPeriod(), DRAW_LIMIT, "a fresh period offers the whole limit");

        vm.startStateDiffRecording();
        vm.prank(agentOwner);
        card.drawCredit(address(creditLine), DRAW_LIMIT);
        VmSafe.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();
        _logCalls("draw transaction", accesses);

        assertEq(IERC20(USDC).balanceOf(address(card)), DRAW_LIMIT, "card holds real USDC");
        assertEq(creditLine.totalDrawn(), DRAW_LIMIT, "drawn");
        assertEq(creditLine.availableThisPeriod(), 0, "period exhausted");

        vm.prank(agentOwner);
        vm.expectRevert(abi.encodeWithSelector(CreditLine.DrawLimitExceeded.selector, uint256(DRAW_LIMIT) + 1, 0));
        card.drawCredit(address(creditLine), uint256(DRAW_LIMIT) + 1);

        // The allowance is per period, not per loan: the next period opens a fresh limit.
        vm.warp(vm.getBlockTimestamp() + DRAW_PERIOD);
        assertEq(creditLine.currentPeriod(), 1, "next draw period");
        assertEq(creditLine.availableThisPeriod(), DRAW_LIMIT, "limit refreshed");
        vm.prank(agentOwner);
        card.drawCredit(address(creditLine), DRAW_LIMIT);
        assertEq(IERC20(USDC).balanceOf(address(card)), uint256(DRAW_LIMIT) * 2, "two periods drawn");
    }

    function test_lifecycle_repaysTheCapFromRealPoolFees() public {
        TermSheet memory ts = _termSheet();
        (uint256 loanId,) = _open(ts);
        ICCA auction = _auction(loanId);
        RevenueEscrow escrow = _escrow(loanId);
        RevenueNote note = _note(loanId);
        CreditLine creditLine = _creditLine(loanId);

        // A keeper clears the fee backlog while the auction is still running; it belongs to the
        // agent, not to the noteholders, so it goes straight to the treasury.
        _harvest(loanId);

        _rollTo(vm.getBlockNumber() + 1);
        uint256 bidA = _bid(bidderA, address(auction), 90, BID_USDC);
        uint256 bidB = _bid(bidderB, address(auction), 85, BID_USDC);
        console2.log("settleAuction gas", _endAuctionAndSettle(loanId));
        _assertStatus(loanId, IAdvance.LoanStatus.Active);

        uint256 principal = creditLine.principal();
        _logUsdc("principal", principal);
        vm.prank(agentOwner);
        card.drawCredit(address(creditLine), DRAW_LIMIT);

        // Real swap volume through the pool's Uniswap v4 hook, harvested until the cap is filled.
        uint256 treasuryUsdc = IERC20(USDC).balanceOf(POOL_CREATOR);
        uint256 treasuryToken = IERC20(AGENT_TOKEN).balanceOf(POOL_CREATOR);
        uint256 harvests;
        uint256 swept;
        while (hub.loan(loanId).status == IAdvance.LoanStatus.Active && harvests < 6) {
            _buyWeth(SWAP_WETH);
            // Round-trip the volume so the pool also accrues fees on the agent-token leg, which the
            // escrow forwards to the treasury and never counts as repayment.
            _sellAgentToken(IERC20(AGENT_TOKEN).balanceOf(trader) / 2);
            (uint256 repaid, uint256 gasUsed) = _harvest(loanId);
            harvests++;
            swept += repaid;
            console2.log("harvest", harvests, "gas", gasUsed);
            _logUsdc("  distributed to noteholders", repaid);
            assertLt(gasUsed, 2_000_000, "harvest fits a keeper's budget");
        }

        uint256 cap = note.capUsdc();
        _logUsdc("cap", cap);
        _logUsdc("total repaid", note.totalRepaid());
        assertGe(harvests, 2, "the cap took more than one harvest of real fees");
        assertEq(swept, cap, "harvests distributed exactly the cap");
        assertEq(note.remainingCap(), 0, "note fully repaid");
        assertGt(IERC20(AGENT_TOKEN).balanceOf(POOL_CREATOR), treasuryToken, "agent-token leg went to the treasury");

        // Repayment closes the loan: shares home, credit line swept to the treasury, card unfrozen.
        _assertStatus(loanId, IAdvance.LoanStatus.Repaid);
        assertEq(uint8(escrow.phase()), uint8(RevenueEscrow.Phase.Closed), "escrow closed");
        assertEq(_shares(POOL_CREATOR), CREATOR_SHARES, "beneficiary share returned to the agent");
        assertEq(_shares(address(escrow)), 0, "escrow holds no shares");
        assertEq(uint8(creditLine.state()), uint8(CreditLine.State.Closed), "credit line closed");
        assertEq(IERC20(USDC).balanceOf(address(creditLine)), 0, "undrawn principal swept out");
        assertFalse(card.frozen(), "card never frozen on the happy path");
        assertEq(hub.liveLoanOf(address(card)), 0, "card free for the next loan");
        uint256 treasuryGain = IERC20(USDC).balanceOf(POOL_CREATOR) - treasuryUsdc;
        _logUsdc("treasury USDC from overflow and the closed credit line", treasuryGain);
        // Everything the agent did not draw comes back, plus the fee USDC the last harvest swapped
        // above the cap.
        assertGt(treasuryGain, principal - DRAW_LIMIT, "treasury got the undrawn principal and the overflow");
        assertEq(IERC20(USDC).balanceOf(address(escrow)), 0, "escrow holds no USDC after closing");

        // Lenders take their notes out of the auction and claim; unclaimed repayment travelled with
        // the notes, so claiming after the loan closed still pays in full.
        auction.exitBid(bidA);
        auction.exitBid(bidB);
        auction.claimTokens(bidA);
        auction.claimTokens(bidB);
        console2.log("bidder A notes", note.balanceOf(bidderA));
        console2.log("bidder B notes", note.balanceOf(bidderB));

        uint256 claimedA = note.claimFor(bidderA);
        uint256 claimedB = note.claimFor(bidderB);
        _logUsdc("bidder A claimed", claimedA);
        _logUsdc("bidder B claimed", claimedB);
        assertEq(IERC20(USDC).balanceOf(bidderA), claimedA, "paid in real USDC");
        assertEq(IERC20(USDC).balanceOf(bidderB), claimedB, "paid in real USDC");
        // Both lenders paid $2.00 for 2.5 notes and get back their share of the $5 cap.
        assertApproxEqAbs(claimedA + claimedB, CAP_USDC, 10, "lenders received the cap, less dust");
        assertGt(claimedA, BID_USDC, "lender A made money");
        assertGt(claimedB, BID_USDC, "lender B made money");

        // The outcome is on the live ERC-8004 reputation registry, posted by the hub as a client.
        assertEq(IReputationRegistry(REPUTATION_REGISTRY).getLastIndex(agentId, address(hub)), 1, "one entry");
        (int128 value, string memory tag1, string memory tag2) = _readHubFeedback(1);
        assertEq(value, 100, "repaid feedback value");
        assertEq(tag1, "advance", "tag1");
        assertEq(tag2, "repaid", "tag2");
    }

    /// @dev Opens the fixture loan and runs its auction to a graduated settlement.
    function _openAndActivate() internal returns (uint256 loanId) {
        (loanId,) = _open(_termSheet());
        ICCA auction = _auction(loanId);
        _rollTo(vm.getBlockNumber() + 1);
        _bid(bidderA, address(auction), 90, BID_USDC);
        _bid(bidderB, address(auction), 85, BID_USDC);
        _endAuctionAndSettle(loanId);
    }
}
