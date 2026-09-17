// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Minimal surface of USDC's FiatTokenV2_2 EIP-3009 implementation used by AgentCard.
/// Only the EIP-712 domain read, the bytes-signature overload of `transferWithAuthorization`
/// (selector `0xcf092995`, the only overload that routes a contract `from` through ERC-1271), and
/// `authorizationState` for replay inspection.
interface IFiatToken {
    /// @notice The EIP-712 domain separator this token signs `transferWithAuthorization` against.
    /// @dev Read live from the token rather than cached or hardcoded: the deployed token computes
    /// it itself, and its `name` differs between Base mainnet ("USD Coin") and Base Sepolia
    /// ("USDC").
    /// @return The current domain separator.
    function DOMAIN_SEPARATOR() external view returns (bytes32);

    /// @notice Executes a signed EIP-3009 transfer authorization. `from` is verified as an EOA via
    /// ECDSA, or, when `from` has code, via ERC-1271 `isValidSignature`.
    /// @param from Authorizer whose funds move.
    /// @param to Payee.
    /// @param value USDC-wei to transfer.
    /// @param validAfter Authorization valid from this unix timestamp (inclusive).
    /// @param validBefore Authorization valid until this unix timestamp (exclusive).
    /// @param nonce Unique authorization nonce.
    /// @param signature Signature bytes verified against `from`.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;

    /// @notice Whether `nonce` has already been used or canceled for `authorizer`.
    /// @param authorizer The authorizing address.
    /// @param nonce The authorization nonce to check.
    /// @return Whether the nonce is used or canceled.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}
