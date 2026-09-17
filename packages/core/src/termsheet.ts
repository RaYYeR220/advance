import type { Address, Hex, TypedDataDomain } from "viem";
import {
  getAddress,
  hashStruct,
  hashTypedData,
  recoverTypedDataAddress,
} from "viem";
import { signTypedData } from "viem/accounts";

/**
 * Binding term sheet struct, field-for-field and in the same order as
 * `contracts/src/lib/TermSheetLib.sol`'s `TermSheet` struct.
 */
export interface TermSheet {
  /** current Doppler beneficiary; borrower of record; receives overflow + returned beneficiary */
  agentTreasury: Address;
  /** only address allowed to CreditLine.draw() */
  agentCard: Address;
  /** ERC-8004 agent id (0 = none, reputation skipped) */
  agentId: bigint;
  /** Doppler fees manager for this pool (per-pool, from Bankr API initializer) */
  feesManager: Address;
  poolId: Hex;
  /** shares escrow must hold after onboarding (creator share, e.g. 0.95e18) */
  expectedShares: bigint;
  /** 18-dec; cap in USDC = noteSupply / 1e12 */
  noteSupply: bigint;
  /** CCA floor, cents per note (e.g. 80) */
  floorCents: number;
  /** USDC-wei; CCA requiredCurrencyRaised */
  minPrincipal: bigint;
  /** must divide 1e7 */
  auctionBlocks: bigint;
  /** USDC-wei per drawPeriod */
  drawLimit: bigint;
  /** seconds (86400 on mainnet; compressed on Sepolia/fork demos) */
  drawPeriod: bigint;
  /** seconds without swept revenue before markDefault is allowed */
  gracePeriod: bigint;
  /** unix; openLoan must happen before */
  deadline: bigint;
  /** unique per underwriter */
  nonce: bigint;
  /** keccak256 of the canonical evidence bundle JSON */
  memoHash: Hex;
}

export const termSheetTypes = {
  TermSheet: [
    { name: "agentTreasury", type: "address" },
    { name: "agentCard", type: "address" },
    { name: "agentId", type: "uint256" },
    { name: "feesManager", type: "address" },
    { name: "poolId", type: "bytes32" },
    { name: "expectedShares", type: "uint256" },
    { name: "noteSupply", type: "uint256" },
    { name: "floorCents", type: "uint16" },
    { name: "minPrincipal", type: "uint128" },
    { name: "auctionBlocks", type: "uint64" },
    { name: "drawLimit", type: "uint128" },
    { name: "drawPeriod", type: "uint64" },
    { name: "gracePeriod", type: "uint64" },
    { name: "deadline", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "memoHash", type: "bytes32" },
  ],
} as const;

/** EIP-712 type string, derived from `termSheetTypes` so it can never drift from it. */
export const termSheetTypeString = `TermSheet(${termSheetTypes.TermSheet.map(
  (field) => `${field.type} ${field.name}`,
).join(",")})`;

export function termSheetDomain(
  chainId: number,
  hub: Address,
): TypedDataDomain {
  return {
    name: "Advance",
    version: "1",
    chainId,
    verifyingContract: getAddress(hub),
  };
}

/**
 * EIP-55 checksumming is a string-level validity check, not part of the hash
 * preimage (addresses are packed as raw 20 bytes either way) — normalize so
 * any valid-byte casing hashes identically.
 */
function normalizeTermSheet(termSheet: TermSheet): TermSheet {
  return {
    ...termSheet,
    agentTreasury: getAddress(termSheet.agentTreasury),
    agentCard: getAddress(termSheet.agentCard),
    feesManager: getAddress(termSheet.feesManager),
  };
}

export function termSheetStructHash(termSheet: TermSheet): Hex {
  return hashStruct({
    data: normalizeTermSheet(termSheet),
    primaryType: "TermSheet",
    types: termSheetTypes,
  });
}

export function termSheetDigest(
  termSheet: TermSheet,
  chainId: number,
  hub: Address,
): Hex {
  return hashTypedData({
    domain: termSheetDomain(chainId, hub),
    types: termSheetTypes,
    primaryType: "TermSheet",
    message: normalizeTermSheet(termSheet),
  });
}

export async function signTermSheet(
  termSheet: TermSheet,
  chainId: number,
  hub: Address,
  privateKey: Hex,
): Promise<Hex> {
  return signTypedData({
    privateKey,
    domain: termSheetDomain(chainId, hub),
    types: termSheetTypes,
    primaryType: "TermSheet",
    message: normalizeTermSheet(termSheet),
  });
}

export async function verifyTermSheet(
  termSheet: TermSheet,
  chainId: number,
  hub: Address,
  signature: Hex,
  expectedSigner: Address,
): Promise<boolean> {
  const recovered = await recoverTypedDataAddress({
    domain: termSheetDomain(chainId, hub),
    types: termSheetTypes,
    primaryType: "TermSheet",
    message: normalizeTermSheet(termSheet),
    signature,
  });
  return recovered.toLowerCase() === expectedSigner.toLowerCase();
}
