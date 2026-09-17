// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Minimal AdvanceHub surface used by per-loan CreditLine (and, later, RevenueEscrow)
/// callbacks. Only the callbacks those contracts need; the full hub ABI is defined where
/// AdvanceHub itself is implemented.
interface IAdvanceHub {
    /// @notice Called by a loan's CreditLine once its funding auction has settled.
    /// @dev Called last inside `CreditLine.settleAuction`, which holds that credit line's
    /// transient reentrancy lock for the duration of the call. Implementations MUST NOT call
    /// back into that same CreditLine (e.g. `freeze`, `close`, another `settleAuction`) from
    /// this callback: the shared `ReentrancyGuardTransient` lock would revert the re-entrant
    /// call and brick settlement for the whole transaction. If `graduated` is true, the hub may
    /// activate the loan's escrow here, but the escrow must not distribute/harvest before this
    /// call returns and the credit line's `state` has actually become `Active` (reading
    /// `creditLine.state()` after this call, or trusting the `graduated` flag passed in, is
    /// safe; distributing against a still-`Pending` credit line is not).
    /// @param loanId The id of the loan whose auction settled.
    /// @param graduated Whether the auction raised at least its required currency.
    function onAuctionSettled(uint256 loanId, bool graduated) external;
}
