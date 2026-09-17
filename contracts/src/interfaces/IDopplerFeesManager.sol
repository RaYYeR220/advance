// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Uniswap v4 pool key as returned by `IDopplerFeesManager.getPoolKey`.
/// @dev Struct fields are ABI-identical to the tuple the deployed FeesManager returns.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @notice Doppler `FeesManager`, as deployed by DopplerHookInitializer.
/// @dev Base mainnet (Bankr default launches): 0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544.
/// `poolId` is `bytes32` at the ABI level (Uniswap v4 PoolId = keccak256(abi.encode(PoolKey))).
interface IDopplerFeesManager {
    /// @notice Pulls LP fees from the pool into the manager, then releases the caller's pro-rata share.
    /// @dev Permissionless, but it only ever pays `msg.sender`; every other beneficiary's share stays
    /// in the manager until they collect it or `updateBeneficiary` touches them. The return values
    /// are NOT what the caller received: RevenueEscrow ignores them and reads balances and the
    /// manager's per-beneficiary accounting instead.
    /// @return fees0 Pool-wide currency0 fees pulled into the manager by this call (all beneficiaries).
    /// @return fees1 Pool-wide currency1 fees pulled into the manager by this call (all beneficiaries).
    function collectFees(bytes32 poolId) external returns (uint128 fees0, uint128 fees1);

    /// @notice Moves all of the caller's beneficiary shares to `newBeneficiary`.
    /// @dev Releases already-cumulated fees to both parties first.
    function updateBeneficiary(bytes32 poolId, address newBeneficiary) external;

    /// @notice The beneficiary's current share of the pool's fees.
    function getShares(bytes32 poolId, address beneficiary) external view returns (uint256);

    /// @notice Total currency0 fees ever cumulated for the pool.
    function getCumulatedFees0(bytes32 poolId) external view returns (uint256);

    /// @notice Total currency1 fees ever cumulated for the pool.
    function getCumulatedFees1(bytes32 poolId) external view returns (uint256);

    /// @notice Cumulated currency0 fees as of the beneficiary's last collection.
    function getLastCumulatedFees0(bytes32 poolId, address beneficiary) external view returns (uint256);

    /// @notice Cumulated currency1 fees as of the beneficiary's last collection.
    function getLastCumulatedFees1(bytes32 poolId, address beneficiary) external view returns (uint256);

    /// @notice The Uniswap v4 pool key backing `poolId`.
    function getPoolKey(bytes32 poolId) external view returns (PoolKey memory);
}
