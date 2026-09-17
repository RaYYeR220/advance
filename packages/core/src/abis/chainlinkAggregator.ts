/** Minimal Chainlink `AggregatorV3Interface` ABI (ETH/USD on Base: `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70`, 8 decimals). */
export const chainlinkAggregatorAbi = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;
