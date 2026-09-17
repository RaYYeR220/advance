import type { Hex } from "viem";
import type { SupportedChainId } from "@advance/core";

const EXPLORER_BASE_URL: Record<SupportedChainId, string> = {
  8453: "https://basescan.org",
  84532: "https://sepolia.basescan.org",
};

/** The block explorer's transaction-detail URL for `hash` on `chainId`. */
export function explorerTxUrl(chainId: SupportedChainId, hash: Hex): string {
  return `${EXPLORER_BASE_URL[chainId]}/tx/${hash}`;
}

/** The block explorer's address-detail URL for `address` on `chainId`. */
export function explorerAddressUrl(chainId: SupportedChainId, address: string): string {
  return `${EXPLORER_BASE_URL[chainId]}/address/${address}`;
}
