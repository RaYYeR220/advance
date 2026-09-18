/**
 * Minimal ABI for the ERC-8004 `IdentityRegistry` reference deployment.
 * Base: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`. `register(string)` mints an ERC-721 whose
 * tokenId is the agent id (`_safeMint`, so a contract registrant needs `onERC721Received`; an
 * EOA-style key never does).
 */
export const identityRegistryAbi = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;
