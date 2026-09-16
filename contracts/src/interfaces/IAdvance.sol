// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Shared types for the Advance protocol.
/// @dev `Loan`/`HubConfig` structs and the shared events/errors are added by the tasks that
/// define AdvanceHub, RevenueEscrow, RevenueNote and CreditLine, once their fields are settled.
interface IAdvance {
    /// @notice Lifecycle of a single loan.
    /// @dev None -> Auction (openLoan) -> Active (settleAuction graduated) | Failed (settleAuction
    /// not graduated); Active -> Repaid (cap reached) | Defaulted (markDefault); Defaulted ->
    /// Repaid (late cap reach); never-opened TermSheet -> Aborted (abort after deadline).
    enum LoanStatus {
        None,
        Auction,
        Active,
        Repaid,
        Defaulted,
        Failed,
        Aborted
    }
}
