import type { Address, Chain } from "viem";
import { base, baseSepolia } from "viem/chains";

export const BASE_MAINNET_CHAIN_ID = base.id;
export const BASE_SEPOLIA_CHAIN_ID = baseSepolia.id;

/** Default archive RPC; override with `BASE_RPC_URL`. Never publicnode (rejects archive calls). */
export const BASE_RPC_URL_DEFAULT = "https://mainnet.base.org";

/** Canonical WETH on Base. */
export const BASE_WETH: Address = "0x4200000000000000000000000000000000000006";

/** Uniswap v4 `PoolManager` on Base. */
export const BASE_V4_POOL_MANAGER: Address =
  "0x498581fF718922c3f8e6A244956aF099B2652b2b";

/** Chainlink ETH/USD price feed on Base (8 decimals). */
export const BASE_ETH_USD_CHAINLINK_FEED: Address =
  "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";

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
