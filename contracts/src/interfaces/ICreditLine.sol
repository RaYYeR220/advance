// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Minimal CreditLine surface used by AgentCard, so the card depends on an interface
/// rather than the concrete contract.
interface ICreditLine {
    /// @notice Pays `amount` USDC to the card, charged against the current draw period's limit.
    /// @param amount USDC to draw.
    function draw(uint256 amount) external;
}
