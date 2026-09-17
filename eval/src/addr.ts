import type { Address, Hex } from "viem";
import { getAddress, keccak256, toBytes } from "viem";

/**
 * Deterministic, collision-free fake address from an arbitrary seed string — used to mint
 * synthetic tokens/creators/whales/tx senders for scenario generation. Not a real key,
 * never used for signing; just `keccak256(seed)`'s last 20 bytes, checksummed.
 */
export function addressFromSeed(seed: string): Address {
  const hash = keccak256(toBytes(seed));
  return getAddress(`0x${hash.slice(-40)}`);
}

/** Deterministic fake 32-byte tx hash from a seed string, for synthetic swap logs. */
export function hashFromSeed(seed: string): Hex {
  return keccak256(toBytes(seed));
}
