// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IChainlink} from "../interfaces/IChainlink.sol";

/// @title OracleLib
/// @notice Bounds the minimum USDC out for a WETH->USDC swap using a Chainlink ETH/USD feed,
/// guarded by the Base L2 sequencer uptime feed and a staleness ceiling. Every failure mode
/// (down sequencer, grace period, stale or bad price) reverts rather than fabricating a bound.
library OracleLib {
    /// @dev Minimum time to wait after the sequencer comes back up before trusting price feeds,
    /// per Chainlink's recommended L2 sequencer uptime pattern.
    uint256 internal constant GRACE_PERIOD = 3600;

    uint256 internal constant BPS_DENOMINATOR = 10_000;

    /// @dev Expected decimals of the ETH/USD price feed's `answer`.
    uint8 internal constant PRICE_FEED_DECIMALS = 8;

    error SequencerDown();
    error SequencerGracePeriod();
    error StalePrice();
    error BadPrice();
    error InvalidTimestamp();
    error InvalidSlippage();
    error InvalidFeedDecimals();

    /// @notice Computes the minimum acceptable USDC output for swapping `wethIn` WETH (18 decimals),
    /// using the Chainlink ETH/USD feed (8 decimals) and a slippage tolerance in basis points.
    /// Every failure mode (down/uninitialized/future-dated sequencer, bad feed shape, stale, bad,
    /// or future-dated price, out-of-range slippage) reverts with a custom error; nothing is
    /// ever fabricated and no path can underflow into a raw Panic.
    /// @param wethIn Amount of WETH being swapped, 18 decimals.
    /// @param ethUsdFeed Chainlink ETH/USD price feed; must report 8 decimals.
    /// @param sequencerFeed Chainlink L2 sequencer uptime feed; `address(0)` skips the sequencer checks.
    /// @param maxStaleness Maximum allowed age, in seconds, of the ETH/USD price update.
    /// @param slippageBps Allowed slippage in basis points (e.g. 100 = 1%); must not exceed 10_000.
    /// @return The minimum acceptable USDC output, 6 decimals.
    function minUsdcOut(
        uint256 wethIn,
        address ethUsdFeed,
        address sequencerFeed,
        uint256 maxStaleness,
        uint256 slippageBps
    ) internal view returns (uint256) {
        if (slippageBps > BPS_DENOMINATOR) revert InvalidSlippage();

        if (sequencerFeed != address(0)) {
            (, int256 sequencerAnswer, uint256 startedAt,,) = IChainlink(sequencerFeed).latestRoundData();
            // Fail closed on any nonzero answer (not just the canonical `1`) and on an
            // uninitialized round (startedAt == 0), which would otherwise read as "up forever".
            if (sequencerAnswer != 0) revert SequencerDown();
            if (startedAt == 0) revert SequencerDown();
            // forge-lint: disable-next-line(block-timestamp) future-dated round guard intentionally uses block.timestamp
            if (startedAt > block.timestamp) revert InvalidTimestamp();
            // forge-lint: disable-next-line(block-timestamp) grace check intentionally uses block.timestamp
            if (block.timestamp - startedAt <= GRACE_PERIOD) revert SequencerGracePeriod();
        }

        if (IChainlink(ethUsdFeed).decimals() != PRICE_FEED_DECIMALS) revert InvalidFeedDecimals();

        (, int256 answer,, uint256 updatedAt,) = IChainlink(ethUsdFeed).latestRoundData();
        if (answer <= 0) revert BadPrice();
        // forge-lint: disable-next-line(block-timestamp) future-dated round guard intentionally uses block.timestamp
        if (updatedAt > block.timestamp) revert InvalidTimestamp();
        // forge-lint: disable-next-line(block-timestamp) staleness check intentionally uses block.timestamp
        if (block.timestamp - updatedAt > maxStaleness) revert StalePrice();

        // forge-lint: disable-next-line(unsafe-typecast) answer > 0 was just checked above, so the cast is safe
        uint256 price = uint256(answer);
        uint256 usdcOut = wethIn * price / 1e20;
        return usdcOut * (BPS_DENOMINATOR - slippageBps) / BPS_DENOMINATOR;
    }
}
