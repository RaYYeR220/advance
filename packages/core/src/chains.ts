import type { Chain } from "viem";
import { base, baseSepolia } from "viem/chains";

export const BASE_MAINNET_CHAIN_ID = base.id;
export const BASE_SEPOLIA_CHAIN_ID = baseSepolia.id;

/** Default archive RPC; override with `BASE_RPC_URL`. Never publicnode (rejects archive calls). */
export const BASE_RPC_URL_DEFAULT = "https://mainnet.base.org";

export const chainsById: Record<number, Chain> = {
  [base.id]: base,
  [baseSepolia.id]: baseSepolia,
};

export function chainById(chainId: number): Chain {
  const chain = chainsById[chainId];
  if (!chain) {
    throw new Error(`unsupported chain id: ${chainId}`);
  }
  return chain;
}
