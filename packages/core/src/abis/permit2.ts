/**
 * Minimal ABI for Uniswap `Permit2`'s `AllowanceTransfer` surface.
 * Same address on every EVM chain (deterministic CREATE2 deploy): `0x000000000022D473030F116dDEE9F6B43aC78BA3`.
 * A CCA bid spends through it: `USDC.approve(PERMIT2, amount)`, then
 * `Permit2.approve(USDC, auction, amount, expiration)`, then `auction.submitBid(...)`.
 */
export const permit2Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
] as const;
