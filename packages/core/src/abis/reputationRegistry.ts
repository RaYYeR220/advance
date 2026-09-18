/**
 * Minimal ABI for the ERC-8004 `ReputationRegistry` reference deployment — just the two view
 * functions the web app reads to show a loan's posted feedback.
 * Base: `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`. Base Sepolia:
 * `0x8004B663056A597Dffe9eCcC1965A193B7388713` (both live in `AdvanceHub.config().reputationRegistry`,
 * so callers read the address off the hub rather than hardcoding a chain-id branch here).
 * Verified against both deployments directly: `getLastIndex(agentId, client)` returns `0` when
 * that pair has no feedback yet; `readFeedback`'s `idx` is 1-based (`idx = 0` reverts
 * `"index must be > 0"`).
 */
export const reputationRegistryAbi = [
  {
    type: "function",
    name: "getLastIndex",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "client", type: "address" },
    ],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "readFeedback",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "client", type: "address" },
      { name: "idx", type: "uint64" },
    ],
    outputs: [
      { name: "value", type: "int128" },
      { name: "valueDecimals", type: "uint8" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
      { name: "isRevoked", type: "bool" },
    ],
  },
] as const;
