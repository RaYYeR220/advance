import canonicalizeJson from "canonicalize";
import type { Address, Hex } from "viem";
import { keccak256 } from "viem";
import type { LlmMessage } from "../llm.js";
import type { ChainFixture } from "../sources/chain.js";
import type { Quality } from "./quality.js";
import type { RevenueWindows } from "./revenue.js";
import type { DenyReason } from "./rules.js";
import type { ComputedTerms } from "./terms.js";

/** Bumped whenever the underwriting formula (`computeTerms`/`computeQuality`/`applyRules`)
 * changes in a way that would change a past decision's numbers if re-run — so a stale
 * evidence bundle is identifiable even without diffing code. */
export const ENGINE_VERSION = "advance-core-underwriting-1";

export interface SwapSampleStats {
  swapCount: number;
  /** Top-5 `tx.from` share of swap count, 0..1. */
  top5ConcentrationRatio: number;
  /** Share of swaps whose `tx.from` is the creator, 0..1. */
  washRatio: number;
  cv: number | undefined;
}

/**
 * Everything one underwriting decision was derived from, content-addressed by
 * `evidenceHash`. `rawReads` is the full set of chain calls made while producing this
 * decision (see `ChainFixture` / `createRecordingChainOps`) — anyone with an archive RPC
 * at `chainId` can replay them and recompute every number in `formula`/`finalTerms`
 * independently. `llm` is the exact request/response the memo step made, verbatim (absent
 * for a decision that never reached the memo step, e.g. a hard deny).
 */
export interface EvidenceBundle {
  engineVersion: string;
  chainId: number;
  token: Address;
  feesManager: Address;
  poolId: Hex;
  rawReads: ChainFixture["calls"];
  swapSample: {
    fromBlock: bigint;
    toBlock: bigint;
    cap: number;
    stats: SwapSampleStats;
  };
  formula: {
    revenue: RevenueWindows;
    quality: Quality;
    computedTerms: ComputedTerms;
  };
  rulesFired: DenyReason[];
  llm?: {
    requestMessages: LlmMessage[];
    rawResponseText: string | undefined;
  };
  finalTerms: ComputedTerms;
  /** Present only for a `data_unavailable` decision: the thrown error's message, with any
   * `http(s)://` URL redacted (an RPC URL must never end up here) — never the raw error
   * object, and never an API key. */
  error?: string;
}

export interface BuildEvidenceParams {
  chainId: number;
  token: Address;
  feesManager: Address;
  poolId: Hex;
  rawReads: ChainFixture["calls"];
  swapSample: { fromBlock: bigint; toBlock: bigint; cap: number };
  revenue: RevenueWindows;
  quality: Quality;
  computedTerms: ComputedTerms;
  rulesFired: DenyReason[];
  llm?: { requestMessages: LlmMessage[]; rawResponseText: string | undefined };
  finalTerms: ComputedTerms;
  error?: string;
}

/** Assembles an `EvidenceBundle` from already-computed pieces. Pure — makes no chain or
 * LLM calls itself, so it's trivially testable and can't itself introduce nondeterminism. */
export function buildEvidence(params: BuildEvidenceParams): EvidenceBundle {
  return {
    engineVersion: ENGINE_VERSION,
    chainId: params.chainId,
    token: params.token,
    feesManager: params.feesManager,
    poolId: params.poolId,
    rawReads: params.rawReads,
    swapSample: {
      fromBlock: params.swapSample.fromBlock,
      toBlock: params.swapSample.toBlock,
      cap: params.swapSample.cap,
      stats: {
        swapCount: params.quality.swapCount,
        top5ConcentrationRatio: params.quality.top5ConcentrationRatio,
        washRatio: params.quality.washRatio,
        cv: params.quality.cv,
      },
    },
    formula: {
      revenue: params.revenue,
      quality: params.quality,
      computedTerms: params.computedTerms,
    },
    rulesFired: params.rulesFired,
    llm: params.llm,
    finalTerms: params.finalTerms,
    error: params.error,
  };
}

/** Recursively replaces every `bigint` with its decimal-string form and drops `undefined`
 * values, so the result is safe for both `canonicalize` (RFC 8785 has no bigint literal)
 * and JSON in general. Key order is left untouched — `canonicalize` does the sorting. */
function toCanonicalSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toCanonicalSafe);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[key] = toCanonicalSafe(v);
    }
    return out;
  }
  return value;
}

/**
 * `keccak256(utf8(canonical JSON))` of the bundle: RFC 8785 canonical form (sorted object
 * keys, no insignificant whitespace, produced by the `canonicalize` package) over a tree
 * with every bigint pre-converted to a decimal string. Stable across the bundle's own
 * property insertion order; changes if any field — down to a single raw read — changes.
 */
export function evidenceHash(bundle: EvidenceBundle): Hex {
  const canonical = canonicalizeJson(toCanonicalSafe(bundle));
  if (canonical === undefined) {
    throw new Error("evidenceHash: bundle serialized to no JSON representation");
  }
  return keccak256(new TextEncoder().encode(canonical));
}
