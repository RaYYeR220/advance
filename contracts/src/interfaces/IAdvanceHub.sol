// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Minimal AdvanceHub surface used by per-loan CreditLine (and, later, RevenueEscrow)
/// callbacks. Only the callbacks those contracts need; the full hub ABI is defined where
/// AdvanceHub itself is implemented.
interface IAdvanceHub {
    /// @notice Called by a loan's CreditLine once its funding auction has settled.
    /// @param loanId The id of the loan whose auction settled.
    /// @param graduated Whether the auction raised at least its required currency.
    function onAuctionSettled(uint256 loanId, bool graduated) external;
}
