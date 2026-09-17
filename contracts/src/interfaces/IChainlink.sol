// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Chainlink `AggregatorV3Interface`, used both for the ETH/USD price feed and the
/// L2 sequencer uptime feed (same ABI shape; `answer` on the uptime feed is 0 = up, 1 = down).
interface IChainlink {
    /// @notice Number of decimals in the feed's `answer`.
    function decimals() external view returns (uint8);

    /// @notice The latest round's price (or sequencer status) data.
    /// @return roundId The round id.
    /// @return answer The feed's answer for the round.
    /// @return startedAt Timestamp the round started.
    /// @return updatedAt Timestamp the round was last updated.
    /// @return answeredInRound The round in which the answer was computed.
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
