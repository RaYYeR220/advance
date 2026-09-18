/**
 * Minimal ABI for a deployed Uniswap Continuous Clearing Auction (CCA) v2.1.0, matching
 * `contracts/src/interfaces/ICCA.sol` (the subset AdvanceHub/CreditLine call) plus the read/write
 * surface lenders need to bid: `submitBid`, `checkpoint`, `isGraduated`, `endBlock`, `bidId`
 * lookups. Address is per-auction (CREATE2'd by the CCA factory at
 * `0x000000001F26a0044BaA66024e7b6599c61963F8` on Base), never constant.
 */
export const ccaAbi = [
  {
    type: "function",
    name: "submitBid",
    stateMutability: "payable",
    inputs: [
      { name: "maxPriceQ96", type: "uint256" },
      { name: "amount", type: "uint128" },
      { name: "owner", type: "address" },
      { name: "prevTickPriceQ96", type: "uint256" },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [{ name: "bidId", type: "uint256" }],
  },
  {
    type: "function",
    name: "checkpoint",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "clearingPrice", type: "uint256" },
          { name: "currencyRaisedAtClearingPriceQ96X7", type: "uint256" },
          { name: "cumulativeMpsPerPrice", type: "uint256" },
          { name: "cumulativeMps", type: "uint24" },
          { name: "prev", type: "uint64" },
          { name: "next", type: "uint64" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "sweepCurrency",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "sweepUnsoldTokens",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "exitBid",
    stateMutability: "nonpayable",
    inputs: [{ name: "bidId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "claimTokens",
    stateMutability: "nonpayable",
    inputs: [{ name: "bidId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "endBlock",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "isGraduated",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "currency",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "token",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "fundsRecipient",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "tokensRecipient",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;
