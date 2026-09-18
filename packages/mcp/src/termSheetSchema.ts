import { z } from "zod";
import { getAddress, isAddress } from "viem";
import { ZERO_ADDRESS } from "@advance/core";
import { HASH_PATTERN } from "./json.js";

const UINT16_MAX = 65_535n;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT128_MAX = (1n << 128n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;

/** A 20-byte address that's both well-formed *and* correctly checksummed when it isn't plain
 * lowercase (`isAddress(v, { strict: true })` — catches a mistyped mixed-case address rather than
 * silently accepting it), and never the zero address — every address field on a `TermSheet` names
 * a real party (treasury, card, fees manager) that a zero address can never legitimately be.
 * Normalizes to EIP-55 checksum casing on the way out, matching how the underwriter itself
 * produces a term sheet (`validateInput`'s own `getAddress` normalization). */
function addressField(label: string) {
  return z
    .string()
    .refine((v) => isAddress(v, { strict: true }), `${label} must be a valid, correctly checksummed address`)
    .refine((v) => v.toLowerCase() !== ZERO_ADDRESS, `${label} must not be the zero address`)
    .transform((v) => getAddress(v));
}

/** A `bytes32` field (`poolId`, `memoHash`) — exactly 32 bytes, hex. */
function hashField(label: string) {
  return z.string().regex(HASH_PATTERN, `${label} must be a 0x-prefixed 32-byte hash`);
}

/** A Solidity `uintN` field: a non-negative integer (accepted as a `bigint`, a decimal string, or
 * a JS number — whatever shape survived `reviveBigints`) within `[0, max]`. Rejecting out-of-range
 * values here, before any of these numbers reach `encodeFunctionData`/EIP-712 encoding, is the
 * actual point — viem itself would eventually throw on an out-of-range value, but only after
 * this tool had already committed to a chain call. */
function uintField(max: bigint, solidityType: string) {
  return z
    .union([z.bigint(), z.number().int().nonnegative(), z.string().regex(/^\d+$/, `must be a decimal integer`)])
    .transform((v) => (typeof v === "bigint" ? v : BigInt(v)))
    .refine((v) => v >= 0n && v <= max, `must fit in ${solidityType} (0 to ${max})`);
}

/**
 * Validates a revived (bigint-restored) `decision.termSheet` field-for-field against the Solidity
 * types `contracts/src/lib/TermSheetLib.sol`'s `TermSheet` struct declares (mirrors
 * `@advance/core`'s `termSheetTypes`) — every address checksummed and non-zero, every id/amount
 * within its type's range, every hash a real 32 bytes. `advance_apply` is the only tool that
 * accepts an arbitrary caller-supplied structured value instead of scalar fields with their own
 * zod types, so this is where that value actually gets checked before any of it reaches the chain
 * layer (`predictEscrow`, `prepareApplication`, `openLoan`).
 */
export const TermSheetSchema = z.object({
  agentTreasury: addressField("agentTreasury"),
  agentCard: addressField("agentCard"),
  agentId: uintField(UINT256_MAX, "uint256"),
  feesManager: addressField("feesManager"),
  poolId: hashField("poolId"),
  expectedShares: uintField(UINT256_MAX, "uint256"),
  noteSupply: uintField(UINT256_MAX, "uint256"),
  floorCents: uintField(UINT16_MAX, "uint16").transform((v) => Number(v)),
  minPrincipal: uintField(UINT128_MAX, "uint128"),
  auctionBlocks: uintField(UINT64_MAX, "uint64"),
  drawLimit: uintField(UINT128_MAX, "uint128"),
  drawPeriod: uintField(UINT64_MAX, "uint64"),
  gracePeriod: uintField(UINT64_MAX, "uint64"),
  deadline: uintField(UINT64_MAX, "uint64"),
  nonce: uintField(UINT256_MAX, "uint256"),
  memoHash: hashField("memoHash"),
});

/** The slice of a `decision` object `advance_apply` actually uses — `kind`, `termSheet`, and
 * `signature` are the only fields that reach `predictEscrow`/`prepareApplication`/`openLoan`
 * (see `contracts.ts`'s `encodeOpenLoanTx`/`encodeMoveBeneficiaryTx`); every other envelope field
 * (`token`, `terms`, `memo`, `evidenceHash`, `evidence`, `digest`) is informational and passes
 * through unvalidated — this schema only guards what can actually reach the chain layer. */
export const ApproveDecisionInputSchema = z.object({
  kind: z.literal("approve"),
  termSheet: TermSheetSchema,
  signature: z.string().regex(SIGNATURE_PATTERN, "signature must be a 65-byte (130 hex char) ECDSA signature"),
});

export type ValidatedApproveDecision = z.infer<typeof ApproveDecisionInputSchema>;

/** Flattens zod issues into one readable line per problem, e.g.
 * `termSheet.agentTreasury: agentTreasury must not be the zero address`. */
export function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}
