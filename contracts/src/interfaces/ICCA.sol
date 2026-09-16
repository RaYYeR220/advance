// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Constructor-time parameters for a Uniswap Continuous Clearing Auction (CCA) v2.1.0.
/// @dev Field names and order match `AuctionParameters` in
/// github.com/Uniswap/continuous-clearing-auction @ v2.1.0 (src/interfaces/IContinuousClearingAuction.sol).
struct AuctionParameters {
    address currency; // token to raise funds in; address(0) = ETH
    address tokensRecipient; // receives leftover (unsold) tokens
    address fundsRecipient; // receives all raised currency; only this address may call sweepCurrency()
    uint64 startBlock;
    uint64 endBlock;
    uint64 claimBlock;
    uint256 tickSpacing; // Q96 price granularity
    address validationHook;
    uint256 floorPrice; // Q96, must be a multiple of tickSpacing
    uint128 requiredCurrencyRaised; // graduation threshold, in currency wei
    bytes auctionStepsData; // packed token issuance schedule
}

/// @notice Auction checkpoint snapshot.
/// @dev Matches `Checkpoint` in CCA v2.1.0 (src/libraries/CheckpointLib.sol); the real
/// `currencyRaisedAtClearingPriceQ96X7` field is a `ValueX7` user-defined value type, which is
/// ABI-identical to `uint256`.
struct Checkpoint {
    uint256 clearingPrice;
    uint256 currencyRaisedAtClearingPriceQ96X7;
    uint256 cumulativeMpsPerPrice;
    uint24 cumulativeMps;
    uint64 prev;
    uint64 next;
}

/// @notice Factory for deploying per-token CCA auction contracts.
interface ICCAFactory {
    /// @notice Deploys (or returns the existing) auction contract for `token`.
    /// @param token The token being sold in the auction.
    /// @param amount The amount of `token` to sell.
    /// @param configData ABI-encoded `AuctionParameters` for the auction.
    /// @param salt CREATE2 salt.
    /// @return auction The address of the deployed auction contract.
    function create(address token, uint256 amount, bytes calldata configData, bytes32 salt)
        external
        returns (address auction);

    /// @notice Predicts the CREATE2 address of an auction before deployment.
    function getAddress(address token, uint256 amount, bytes calldata configData, bytes32 salt, address sender)
        external
        view
        returns (address auction);
}

/// @notice Minimal surface of a deployed CCA auction used by Advance.
/// @dev Function set is the subset Advance calls; not the full CCA v2.1.0 ABI.
interface ICCA {
    /// @notice Callback invoked once the auction's full token supply has been transferred in.
    function onTokensReceived() external;

    /// @notice Submits a bid.
    /// @param maxPriceQ96 The maximum Q96 price the bidder is willing to pay.
    /// @param amount The amount of the bid.
    /// @param owner The owner of the bid.
    /// @param prevTickPriceQ96 The Q96 price of the previous tick (bid insertion hint).
    /// @param hookData Data forwarded to the validation hook, if any.
    /// @return bidId The id of the submitted bid.
    function submitBid(
        uint256 maxPriceQ96,
        uint128 amount,
        address owner,
        uint256 prevTickPriceQ96,
        bytes calldata hookData
    ) external payable returns (uint256 bidId);

    /// @notice Advances accounting to the current block, returning the resulting checkpoint.
    function checkpoint() external returns (Checkpoint memory);

    /// @notice Withdraws all raised currency to `fundsRecipient`. Callable after the auction ends.
    function sweepCurrency() external;

    /// @notice Sends any unsold tokens to `tokensRecipient`. Callable after the auction ends.
    function sweepUnsoldTokens() external;

    /// @notice The block at which the auction ends.
    function endBlock() external view returns (uint64);

    /// @notice Claims the tokens filled by an exited bid, transferring them to the bid owner.
    function claimTokens(uint256 bidId) external;

    /// @notice Exits a bid that was fully filled above the final clearing price.
    function exitBid(uint256 bidId) external;

    /// @notice Whether the auction has raised at least `requiredCurrencyRaised`.
    /// @dev Confirmed exact name against CCA v2.1.0 source
    /// (src/interfaces/IContinuousClearingAuction.sol#isGraduated, tag v2.1.0).
    function isGraduated() external view returns (bool);
}
