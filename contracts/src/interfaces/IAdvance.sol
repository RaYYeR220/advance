// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Shared types for the Advance protocol.
/// @dev The loan record and hub configuration structs are defined in AdvanceHub; events and errors
/// are declared by the contract that emits or throws them.
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
