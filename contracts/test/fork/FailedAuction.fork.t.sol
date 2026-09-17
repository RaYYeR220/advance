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
import {TermSheet} from "../../src/lib/TermSheetLib.sol";
import {ForkBase, ICCAView} from "./ForkBase.sol";

/// @notice An auction that does not raise its `minPrincipal`. The real CCA refuses to graduate,
/// the credit line settles Failed without ever holding USDC, the note supply is burned to nothing
/// and the agent's Doppler beneficiary share goes straight back. Lenders are made whole by the
/// auction itself: every USDC-wei they committed is refundable and no notes are ever delivered.
contract FailedAuctionForkTest is ForkBase {
    /// @notice A single bid worth $1.00, half of the $2.00 the term sheet requires to graduate.
    uint128 internal constant SHORT_BID_USDC = 1e6;

    function test_failedAuction_refundsLendersAndReturnsTheFeeShare() public {
        TermSheet memory ts = _termSheet();
        (uint256 loanId,) = _open(ts);
        ICCA auction = _auction(loanId);
        RevenueEscrow escrow = _escrow(loanId);
        RevenueNote note = _note(loanId);
        CreditLine creditLine = _creditLine(loanId);
        assertEq(_shares(address(escrow)), CREATOR_SHARES, "the escrow took the fee share to run the auction");

        _rollTo(vm.getBlockNumber() + 1);
        uint256 bidId = _bid(bidderA, address(auction), 90, SHORT_BID_USDC);
        assertEq(IERC20(USDC).balanceOf(bidderA), 0, "the bid moved the lender's USDC into the auction");

        _rollTo(auction.endBlock());
        auction.checkpoint();
        uint256 raised = ICCAView(address(auction)).currencyRaised();
        _logUsdc("raised", raised);
        assertLt(raised, MIN_PRINCIPAL, "short of the graduation threshold");
        assertFalse(auction.isGraduated(), "the live CCA refuses to graduate");

        vm.prank(keeper);
        creditLine.settleAuction();

        _assertStatus(loanId, IAdvance.LoanStatus.Failed);
        assertEq(uint8(creditLine.state()), uint8(CreditLine.State.Failed), "credit line failed");
        assertEq(creditLine.principal(), 0, "no principal");
        assertEq(IERC20(USDC).balanceOf(address(creditLine)), 0, "the credit line never received a cent");
        assertEq(note.totalSupply(), 0, "the whole note supply came back and was burned");
        assertEq(note.capUsdc(), 0, "no repayment cap survives");
        assertEq(uint8(escrow.phase()), uint8(RevenueEscrow.Phase.Closed), "escrow released");
        assertEq(_shares(address(escrow)), 0, "escrow gave up the fee share");
        assertEq(_shares(POOL_CREATOR), CREATOR_SHARES, "share returned to the agent treasury");
        assertEq(hub.liveLoanOf(address(card)), 0, "card released for another attempt");
        assertEq(
            IReputationRegistry(REPUTATION_REGISTRY).getLastIndex(agentId, address(hub)),
            0,
            "a failed raise is not a credit event"
        );

        // The lender's money was never at risk: the auction refunds the full commitment, and there
        // are no notes to claim because nothing cleared.
        auction.exitBid(bidId);
        assertEq(IERC20(USDC).balanceOf(bidderA), SHORT_BID_USDC, "lender refunded in full");
        vm.expectRevert(bytes4(keccak256("NotGraduated()")));
        auction.claimTokens(bidId);
        assertEq(note.balanceOf(bidderA), 0, "no notes delivered");
    }

    function test_failedLoan_cannotBeDrawnOrDefaulted() public {
        TermSheet memory ts = _termSheet();
        (uint256 loanId,) = _open(ts);
        ICCA auction = _auction(loanId);
        _rollTo(vm.getBlockNumber() + 1);
        _bid(bidderA, address(auction), 90, SHORT_BID_USDC);
        _rollTo(auction.endBlock());
        CreditLine creditLine = _creditLine(loanId);
        vm.prank(keeper);
        creditLine.settleAuction();

        vm.prank(agentOwner);
        vm.expectRevert(CreditLine.NotActive.selector);
        card.drawCredit(address(creditLine), 1);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(AdvanceHub.WrongStatus.selector, IAdvance.LoanStatus.Failed));
        hub.markDefault(loanId);

        // A keeper that keeps harvesting a released escrow is harmless: it no longer holds shares,
        // so the live fees manager pays it nothing and there is nothing to distribute.
        _buyWeth(0.05 ether);
        (uint256 repaid, uint256 gasUsed) = _harvest(loanId);
        console2.log("post-failure harvest gas", gasUsed);
        assertEq(repaid, 0, "nothing is owed to noteholders");
        assertEq(IERC20(WETH).balanceOf(address(_escrow(loanId))), 0, "the released escrow collects nothing");
    }
}
