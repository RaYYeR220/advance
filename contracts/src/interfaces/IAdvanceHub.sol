// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Minimal AdvanceHub surface used by per-loan CreditLine and RevenueEscrow callbacks.
/// Only the callbacks those contracts need; the full hub ABI is defined where AdvanceHub itself
/// is implemented.
interface IAdvanceHub {
    /// @notice Called by a loan's RevenueEscrow once the loan's note has been repaid up to its
    /// cap and the escrow has handed the fee-beneficiary role back to the agent treasury.
    /// @dev Called exactly once per escrow, last inside `RevenueEscrow.harvest` or
    /// `RevenueEscrow.closeIfRepaid`, while that escrow holds its transient reentrancy lock and
    /// after its phase is already `Closed`. Implementations MUST NOT call back into that escrow's
    /// `harvest`, `closeIfRepaid` or `release` (the shared lock reverts the re-entrant call), and
    /// MUST NOT revert: a revert here unwinds the whole call, including the final distribution
    /// that filled the cap, and every later harvest that reaches the cap reverts the same way, so
    /// the loan could never close and the note's last repayment would never land.
    /// @param loanId The id of the loan that has been repaid.
    function onRepaid(uint256 loanId) external;

    /// @notice Called by a loan's CreditLine once its funding auction has settled.
    /// @dev Called last inside `CreditLine.settleAuction`, which holds that credit line's
    /// transient reentrancy lock for the duration of the call. Implementations MUST NOT call
    /// back into that same CreditLine (e.g. `freeze`, `close`, another `settleAuction`) from
    /// this callback: the shared `ReentrancyGuardTransient` lock would revert the re-entrant
    /// call and brick settlement for the whole transaction. If `graduated` is true, the hub may
    /// activate the loan's escrow here, but the escrow must not distribute/harvest before this
    /// call returns and the credit line's `state` has actually become `Active` (reading
    /// `creditLine.state()` after this call, or trusting the `graduated` flag passed in, is
    /// safe; distributing against a still-`Pending` credit line is not). Concretely: `RevenueNote`
    /// lets both the escrow and the credit line call `distribute`, so nothing stops the escrow
    /// from pushing USDC into the note before the auction has ever settled. If it does,
    /// `totalRepaid` on the note can already exceed the cap that `settleAuction` would shrink it
    /// to once it burns the unsold notes it sweeps in; `RevenueNote.burn` then reverts
    /// `CapBelowRepaid` inside `settleAuction` itself. Since `settleAuction` is only ever
    /// callable from `Pending` and that call reverts, `state` never advances past `Pending` and
    /// every future call hits the same revert -- permanently bricking settlement and stranding
    /// the auction's raised currency (only this CreditLine, as the auction's `fundsRecipient`,
    /// can ever sweep it).
    /// @param loanId The id of the loan whose auction settled.
    /// @param graduated Whether the auction raised at least its required currency.
    function onAuctionSettled(uint256 loanId, bool graduated) external;
}
