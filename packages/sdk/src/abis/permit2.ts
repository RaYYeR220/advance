/**
 * Minimal Uniswap Permit2 `IAllowanceTransfer` surface, hand-written (not generated): Permit2 is
 * a canonical external deployment (same address on every chain this SDK targets, see
 * `PERMIT2_ADDRESS` in `../chains.js`) this SDK only ever calls against — there is no
 * `contracts/out` artifact for it (unlike Advance's own contracts, see `generated.ts`).
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
      { name: "user", type: "address" },
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
