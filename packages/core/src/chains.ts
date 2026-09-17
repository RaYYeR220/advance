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

export type SupportedChainId = 8453 | 84532;

export interface ChainAddresses {
  weth: Address;
  usdc: Address;
  ethUsdFeed: Address;
  /** Uniswap v4 `PoolManager`. */
  poolManager: Address;
  /** Doppler `FeesManager` / `DopplerHookInitializer` — the only pool initializer this
   * engine trusts; a discovered pool whose initializer isn't this address is denied
   * `not_bankr_doppler`. */
  dopplerFeesManager: Address;
  /** Doppler `Airlock` — the on-chain discovery source (`getAssetData`). */
  dopplerAirlock: Address;
}

/**
 * Per-chain addresses, every one verified live on-chain before being recorded here (see
 * exact `cast` calls used, kept alongside the commit that added them): WETH/USDC/Chainlink feed by
 * `symbol()`/`decimals()`/`description()`; `poolManager` read directly off
 * `dopplerFeesManager`'s own `poolManager()` immutable getter (not copied from docs);
 * `dopplerAirlock` verified via `getModuleState(dopplerFeesManager) == PoolInitializer (3)`
 * and a real `getAssetData` lookup against a known token on that chain.
 */
export const CHAIN_ADDRESSES: Record<SupportedChainId, ChainAddresses> = {
  8453: {
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    ethUsdFeed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
    poolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
    dopplerFeesManager: "0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544",
    dopplerAirlock: "0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12",
  },
  84532: {
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    ethUsdFeed: "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1",
    poolManager: "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408",
    dopplerFeesManager: "0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544",
    dopplerAirlock: "0x3411306Ce66c9469BFF1535BA955503c4Bde1C6e",
  },
};

export function isSupportedChainId(chainId: number): chainId is SupportedChainId {
  return chainId === 8453 || chainId === 84532;
}

export function chainAddresses(chainId: SupportedChainId): ChainAddresses {
  const addresses = CHAIN_ADDRESSES[chainId];
  if (!addresses) {
    throw new Error(`unsupported chain id: ${chainId}`);
  }
  return addresses;
}
