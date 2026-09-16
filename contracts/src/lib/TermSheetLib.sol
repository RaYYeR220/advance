// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Underwriter-signed loan terms for a single Advance loan.
/// @dev Field-for-field identical to the TypeScript encoding in packages/core/src/termsheet.ts;
/// both MUST stay in sync (same fields, same order) so the EIP-712 digest matches cross-language.
struct TermSheet {
    /// @dev Current Doppler beneficiary; borrower of record; receives overflow + returned beneficiary.
    address agentTreasury;
    /// @dev Only address allowed to call CreditLine.draw().
    address agentCard;
    /// @dev ERC-8004 agent id (0 = none, reputation skipped).
    uint256 agentId;
    /// @dev Doppler fees manager for this pool (per-pool, from Bankr API initializer).
    address feesManager;
    bytes32 poolId;
    /// @dev Shares escrow must hold after onboarding (creator share, e.g. 0.95e18).
    uint256 expectedShares;
    /// @dev 18-decimal note supply; cap in USDC = noteSupply / 1e12.
    uint256 noteSupply;
    /// @dev CCA floor, cents per note (e.g. 80).
    uint16 floorCents;
    /// @dev USDC-wei; CCA requiredCurrencyRaised.
    uint128 minPrincipal;
    /// @dev Must divide 1e7.
    uint64 auctionBlocks;
    /// @dev USDC-wei per drawPeriod.
    uint128 drawLimit;
    /// @dev Seconds (86400 on mainnet; compressed on Sepolia/fork demos).
    uint64 drawPeriod;
    /// @dev Seconds without swept revenue before markDefault is allowed.
    uint64 gracePeriod;
    /// @dev Unix timestamp; openLoan must happen before this.
    uint64 deadline;
    /// @dev Unique per underwriter.
    uint256 nonce;
    /// @dev keccak256 of the canonical evidence bundle JSON.
    bytes32 memoHash;
}

/// @title TermSheetLib
/// @notice EIP-712 typehash and struct-hash encoding for TermSheet.
library TermSheetLib {
    bytes32 internal constant TYPEHASH = keccak256(
        "TermSheet(address agentTreasury,address agentCard,uint256 agentId,address feesManager,bytes32 poolId,uint256 expectedShares,uint256 noteSupply,uint16 floorCents,uint128 minPrincipal,uint64 auctionBlocks,uint128 drawLimit,uint64 drawPeriod,uint64 gracePeriod,uint64 deadline,uint256 nonce,bytes32 memoHash)"
    );

    /// @notice Computes the EIP-712 struct hash for a TermSheet.
    /// @param sheet The term sheet to hash.
    /// @return The keccak256 struct hash, to be combined with a domain separator per EIP-712.
    function structHash(TermSheet memory sheet) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                TYPEHASH,
                sheet.agentTreasury,
                sheet.agentCard,
                sheet.agentId,
                sheet.feesManager,
                sheet.poolId,
                sheet.expectedShares,
                sheet.noteSupply,
                sheet.floorCents,
                sheet.minPrincipal,
                sheet.auctionBlocks,
                sheet.drawLimit,
                sheet.drawPeriod,
                sheet.gracePeriod,
                sheet.deadline,
                sheet.nonce,
                sheet.memoHash
            )
        );
    }
}
