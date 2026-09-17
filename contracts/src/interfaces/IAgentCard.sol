// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice External surface of AgentCard beyond ERC-1271: crediting from a CreditLine, the hub's
/// freeze/unfreeze/returnFunds controls, and the fixed payee allowlist.
interface IAgentCard {
    /// @notice Emitted on every successful `drawCredit`.
    /// @param creditLine The credit line drawn from.
    /// @param amount USDC actually received, measured as this card's USDC balance delta across
    /// the draw (not the requested amount).
    event CreditDrawn(address indexed creditLine, uint256 amount);
    /// @notice Emitted when the hub freezes this card.
    event Frozen();
    /// @notice Emitted when the hub unfreezes this card.
    event Unfrozen();
    /// @notice Emitted when the hub sweeps this card's whole USDC balance back to a credit line.
    /// @param creditLine The credit line funds were returned to.
    /// @param amount USDC returned.
    event FundsReturned(address indexed creditLine, uint256 amount);

    /// @notice Thrown when a caller other than `owner` calls an owner-only function.
    error NotOwner();
    /// @notice Thrown when a caller other than `hub` calls a hub-only function.
    error NotHub();
    /// @notice Thrown when the constructor is given an empty payee list.
    error NoPayees();
    /// @notice Thrown when a required constructor address argument is zero.
    error ZeroAddress();
    /// @notice Thrown when the constructor is given a zero `perCallCap`.
    error ZeroPerCallCap();
    /// @notice Thrown when the constructor is given a zero `maxAuthWindow`.
    error ZeroMaxAuthWindow();
    /// @notice Thrown when the constructor's payee list contains a zero address.
    error ZeroPayee();
    /// @notice Thrown when the constructor's payee list repeats an address.
    /// @param payee The address that appeared more than once.
    error DuplicatePayee(address payee);

    /// @notice The agent's signing key; the only address allowed to `drawCredit`.
    /// @return The owner address.
    function owner() external view returns (address);

    /// @notice AdvanceHub address; the only caller allowed to `freeze`, `unfreeze` and
    /// `returnFunds`.
    /// @return The hub address.
    function hub() external view returns (address);

    /// @notice USDC token this card holds and pays out.
    /// @return The USDC token.
    function usdc() external view returns (IERC20);

    /// @notice Maximum USDC value a single authorized payment may move.
    /// @return The per-call cap, in USDC-wei.
    function perCallCap() external view returns (uint256);

    /// @notice Maximum seconds beyond `block.timestamp` an authorization's `validBefore` may be
    /// set to at verification time.
    /// @return The max authorization window, in seconds.
    function maxAuthWindow() external view returns (uint64);

    /// @notice Whether this card is currently frozen (all `isValidSignature` calls return invalid).
    /// @return Whether the card is frozen.
    function frozen() external view returns (bool);

    /// @notice Whether `payee` is allowed to receive authorized payments from this card.
    /// @param payee The address to check.
    /// @return Whether `payee` is allowlisted.
    function isAllowedPayee(address payee) external view returns (bool);

    /// @notice The fixed set of payees this card may pay, in constructor order.
    /// @return The allowlisted payees.
    function payees() external view returns (address[] memory);

    /// @notice Draws `amount` USDC from `creditLine` into this card. Only callable by `owner`.
    /// @param creditLine The credit line to draw from.
    /// @param amount USDC to draw.
    function drawCredit(address creditLine, uint256 amount) external;

    /// @notice Freezes this card: `isValidSignature` returns invalid for every request until
    /// `unfreeze`. Only callable by `hub`.
    function freeze() external;

    /// @notice Unfreezes this card, restoring normal `isValidSignature` checks. Only callable by
    /// `hub`.
    function unfreeze() external;

    /// @notice Sweeps this card's entire USDC balance to `creditLine`. Only callable by `hub`.
    /// @param creditLine The credit line to return funds to.
    function returnFunds(address creditLine) external;
}
