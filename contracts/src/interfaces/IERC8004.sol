// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice ERC-8004 identity registry: agent id ownership.
interface IIdentityRegistry {
    /// @notice Registers the caller as a new agent.
    /// @return agentId The newly minted agent id.
    function register() external returns (uint256 agentId);

    /// @notice The owner (controller) of an agent id.
    function ownerOf(uint256 agentId) external view returns (address);
}

/// @notice ERC-8004 reputation registry: feedback about an agent's task performance.
interface IReputationRegistry {
    /// @notice Records feedback for an agent.
    /// @param agentId The agent being reviewed.
    /// @param value The feedback score.
    /// @param valueDecimals Decimals of `value`.
    /// @param tag1 Primary category tag.
    /// @param tag2 Secondary category tag.
    /// @param endpoint The endpoint or context the feedback relates to.
    /// @param feedbackURI Off-chain evidence URI.
    /// @param feedbackHash keccak256 of the off-chain evidence.
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;

    /// @notice Reads a single feedback entry left by `client` for `agentId`.
    function readFeedback(uint256 agentId, address client, uint64 idx)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked);

    /// @notice The index of the last feedback entry `client` left for `agentId`.
    function getLastIndex(uint256 agentId, address client) external view returns (uint64);
}
