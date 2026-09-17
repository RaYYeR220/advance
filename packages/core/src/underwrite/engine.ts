import { randomBytes } from "node:crypto";
import type { Address, Hex } from "viem";
import {
  BASE_ETH_USD_CHAINLINK_FEED,
  BASE_V4_POOL_MANAGER,
  BASE_WETH,
} from "../chains.js";
import {
  BankrTokenNotFoundError,
  pickBankrToken,
  type BankrClient,
} from "../sources/bankr.js";
import {
  createRecordingChainOps,
  isPoolEligibleForEscrow,
  type ChainFixture,
  type ChainOps,
} from "../sources/chain.js";
import { buildChainReader } from "../sources/chainLogic.js";
import type { LlmClient } from "../llm.js";
import { signTermSheet, termSheetDigest, type TermSheet } from "../termsheet.js";
import { buildEvidence, evidenceHash, type EvidenceBundle } from "./evidence.js";
import {
  mergeMemo,
  requestMemoDetailed,
  type Memo,
  type MemoEvidenceSummary,
  type UntrustedTokenMetadata,
} from "./memo.js";
import { computeQuality, type Quality } from "./quality.js";
import { checkIsWethPool, computeRevenue, type RevenueWindows } from "./revenue.js";
import { applyRules, termsDenyReasons, type DenyReason } from "./rules.js";
import {
  computeTerms,
  type ComputedTerms,
  type TermsSummary,
  type UnderwritingEnv,
} from "./terms.js";

const DAY_SECONDS = 86_400n;
const SWAP_LOOKBACK_DAYS = 7n;
const SWAP_SAMPLE_CAP = 400;
const DEADLINE_WINDOW_SECONDS = 3600n;

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32: Hex = `0x${"0".repeat(64)}` as Hex;

export type SupportedChainId = 8453 | 84532;

export interface UnderwriteInput {
  token: Address;
  agentCard: Address;
  agentId: bigint;
  chainId: SupportedChainId;
  hub: Address;
  /** Unix seconds. Only used to derive `TermSheet.deadline` — every chain read is
   * anchored to the reader's own latest block, never to this value. */
  now: number;
}

export interface UnderwriteDeps {
  bankr: BankrClient;
  /** Raw chain ops (not a pre-built `ChainReader`) — the engine wraps it in a recording
   * layer so every call it makes is captured for the evidence bundle's `rawReads`. */
  chain: ChainOps;
  llm: LlmClient;
  /** Hex private key of the underwriter signer. Never logged. */
  signerKey: Hex;
  env: UnderwritingEnv;
}

export type ScoreResult =
  | { kind: "deny"; reasons: DenyReason[]; evidenceHash: Hex; evidence: EvidenceBundle }
  | { kind: "eligible"; terms: ComputedTerms; evidenceHash: Hex; evidence: EvidenceBundle };

export type Decision =
  | {
      kind: "deny";
      token: Address;
      reasons: DenyReason[];
      evidenceHash: Hex;
      evidence: EvidenceBundle;
    }
  | {
      kind: "approve";
      token: Address;
      termSheet: TermSheet;
      signature: Hex;
      digest: Hex;
      terms: TermsSummary;
      memo: Memo;
      evidenceHash: Hex;
      evidence: EvidenceBundle;
    };

const ZERO_REVENUE: RevenueWindows = {
  revenueWei: { d1: 0n, d7: 0n, d30: 0n },
  revenueMicroUsd: { d1: 0n, d7: 0n, d30: 0n },
  ageSeconds: 0n,
  creatorSharesWad: 0n,
  dailyRevenueWei: [0n, 0n, 0n, 0n, 0n, 0n, 0n],
};

const ZERO_QUALITY: Quality = {
  swapCount: 0,
  top5ConcentrationRatio: 0,
  washRatio: 0,
  cv: undefined,
  haircutBps: 0,
};

const ZERO_TERMS: ComputedTerms = {
  revenueWei: { d1: 0n, d7: 0n, d30: 0n },
  revenueMicroUsd: { d1: 0n, d7: 0n, d30: 0n },
  projected90dMicroUsd: 0n,
  haircutBps: 0,
  capMicroUsd: 0n,
  floorCents: 0,
  minPrincipal: 0n,
  drawLimit: 0n,
  drawPeriod: 0,
  gracePeriod: 0,
  noteSupply: 0n,
  auctionBlocks: 0n,
};

/** Redacts any `http(s)://` URL from an error message before it can reach evidence —
 * an RPC URL must never be recorded, and this catches it regardless of which dependency
 * (chain client, HTTP client) embedded it in the message. */
function redactSecrets(message: string): string {
  return message.replace(/https?:\/\/\S+/gi, "[redacted]");
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactSecrets(raw);
}

function randomNonce128(): bigint {
  return BigInt(`0x${randomBytes(16).toString("hex")}`);
}

/** `ComputedTerms` minus the two fields that round it out beyond `TermsSummary`. */
function toTermsSummary(terms: ComputedTerms): TermsSummary {
  const { noteSupply: _noteSupply, auctionBlocks: _auctionBlocks, ...summary } = terms;
  return summary;
}

/** Mutable state accumulated while a single `score`/`underwrite` call runs, so a thrown
 * error at any point can still be turned into an evidence bundle reflecting whatever was
 * actually learned before the failure — never fabricated, never left blank when known. */
interface Progress {
  feesManager: Address;
  poolId: Hex;
  revenue: RevenueWindows;
  quality: Quality;
  computedTerms: ComputedTerms;
  swapSample: { fromBlock: bigint; toBlock: bigint; cap: number };
  dump: () => ChainFixture["calls"];
}

function freshProgress(dump: () => ChainFixture["calls"]): Progress {
  return {
    feesManager: ZERO_ADDRESS,
    poolId: ZERO_BYTES32,
    revenue: ZERO_REVENUE,
    quality: ZERO_QUALITY,
    computedTerms: ZERO_TERMS,
    swapSample: { fromBlock: 0n, toBlock: 0n, cap: 0 },
    dump,
  };
}

function buildDataUnavailableEvidence(
  input: UnderwriteInput,
  progress: Progress,
  err: unknown,
): { evidence: EvidenceBundle; evidenceHash: Hex } {
  const evidence = buildEvidence({
    chainId: input.chainId,
    token: input.token,
    feesManager: progress.feesManager,
    poolId: progress.poolId,
    rawReads: progress.dump(),
    swapSample: progress.swapSample,
    revenue: progress.revenue,
    quality: progress.quality,
    computedTerms: progress.computedTerms,
    rulesFired: ["data_unavailable"],
    finalTerms: progress.computedTerms,
    error: errorMessage(err),
  });
  return { evidence, evidenceHash: evidenceHash(evidence) };
}

interface Stage1Deny {
  kind: "deny";
  reasons: DenyReason[];
  evidence: EvidenceBundle;
  evidenceHash: Hex;
}

interface Stage1Eligible {
  kind: "eligible";
  feesManager: Address;
  poolId: Hex;
  creator: Address;
  tokenName: string;
  tokenSymbol: string;
  revenue: RevenueWindows;
  quality: Quality;
  computedTerms: ComputedTerms;
  swapSample: { fromBlock: bigint; toBlock: bigint; cap: number };
  evidence: EvidenceBundle;
  evidenceHash: Hex;
}

type Stage1Result = Stage1Deny | Stage1Eligible;

function denyStage1(
  input: UnderwriteInput,
  progress: Progress,
  reasons: DenyReason[],
): Stage1Deny {
  const evidence = buildEvidence({
    chainId: input.chainId,
    token: input.token,
    feesManager: progress.feesManager,
    poolId: progress.poolId,
    rawReads: progress.dump(),
    swapSample: progress.swapSample,
    revenue: progress.revenue,
    quality: progress.quality,
    computedTerms: progress.computedTerms,
    rulesFired: reasons,
    finalTerms: progress.computedTerms,
  });
  return { kind: "deny", reasons, evidence, evidenceHash: evidenceHash(evidence) };
}

/**
 * Discovery through terms + hard rules — shared by `score` and `underwrite`. Never
 * catches its own errors: a thrown error here propagates to the caller's top-level
 * try/catch, which turns it into a `data_unavailable` deny using whatever `progress` had
 * accumulated so far.
 */
async function runStage1(
  input: UnderwriteInput,
  deps: UnderwriteDeps,
  reader: ReturnType<typeof buildChainReader>,
  progress: Progress,
): Promise<Stage1Result> {
  let bankrResponse: Awaited<ReturnType<UnderwriteDeps["bankr"]["getTokenFees"]>>;
  try {
    bankrResponse = await deps.bankr.getTokenFees(input.token);
  } catch (err) {
    if (err instanceof BankrTokenNotFoundError) {
      return denyStage1(input, progress, ["not_bankr_doppler"]);
    }
    throw err;
  }

  let entry: ReturnType<typeof pickBankrToken>;
  try {
    entry = pickBankrToken(bankrResponse, input.token);
  } catch (err) {
    if (err instanceof BankrTokenNotFoundError) {
      return denyStage1(input, progress, ["not_bankr_doppler"]);
    }
    throw err;
  }

  const feesManager = entry.initializer;
  const poolId = entry.poolId;
  progress.feesManager = feesManager;
  progress.poolId = poolId;
  const creator = bankrResponse.address;

  const isWethPool = await checkIsWethPool(reader, feesManager, poolId, BASE_WETH);
  if (!isWethPool) {
    return denyStage1(input, progress, ["not_weth_pool"]);
  }

  const poolStatus = await reader.getPoolStatus(feesManager, input.token);
  if (!isPoolEligibleForEscrow(poolStatus)) {
    return denyStage1(input, progress, ["pool_not_locked"]);
  }

  const revenue = await computeRevenue(reader, {
    token: input.token,
    feesManager,
    poolId,
    creator,
    weth: BASE_WETH,
    ethUsdFeed: BASE_ETH_USD_CHAINLINK_FEED,
  });
  progress.revenue = revenue;

  const latest = await reader.getLatestBlock();
  const swapFromBlock = await reader.blockAt(
    latest.timestamp - SWAP_LOOKBACK_DAYS * DAY_SECONDS,
  );
  const swapSample = {
    fromBlock: swapFromBlock,
    toBlock: latest.number,
    cap: SWAP_SAMPLE_CAP,
  };
  progress.swapSample = swapSample;

  const swaps = await reader.getSwaps({
    poolManager: BASE_V4_POOL_MANAGER,
    poolId,
    fromBlock: swapSample.fromBlock,
    toBlock: swapSample.toBlock,
    cap: swapSample.cap,
  });

  const quality = computeQuality(swaps, {
    creator,
    ageSeconds: revenue.ageSeconds,
    recentDailyRevenue: revenue.dailyRevenueWei,
  });
  progress.quality = quality;

  const rulesReasons = await applyRules(
    { poolId, poolFound: true, isWethPool: true, poolLocked: true },
    revenue,
    quality,
  );
  const computedTerms = computeTerms(revenue, quality, deps.env);
  progress.computedTerms = computedTerms;
  const termsReasons = termsDenyReasons(computedTerms);
  const allReasons = [...rulesReasons, ...termsReasons];

  const evidence = buildEvidence({
    chainId: input.chainId,
    token: input.token,
    feesManager,
    poolId,
    rawReads: progress.dump(),
    swapSample,
    revenue,
    quality,
    computedTerms,
    rulesFired: allReasons,
    finalTerms: computedTerms,
  });
  const hash = evidenceHash(evidence);

  if (allReasons.length > 0) {
    return { kind: "deny", reasons: allReasons, evidence, evidenceHash: hash };
  }

  return {
    kind: "eligible",
    feesManager,
    poolId,
    creator,
    tokenName: entry.name,
    tokenSymbol: entry.symbol,
    revenue,
    quality,
    computedTerms,
    swapSample,
    evidence,
    evidenceHash: hash,
  };
}

function engineContext(input: UnderwriteInput, deps: UnderwriteDeps) {
  const { ops, dump } = createRecordingChainOps(deps.chain, {
    token: input.token,
    chainId: input.chainId,
  });
  return { reader: buildChainReader(ops), dump: () => dump().calls };
}

/**
 * Runs the engine up to terms + hard rules only — no memo request, no signature. Useful
 * for a quick eligibility check without spending an LLM call or minting a term sheet.
 * The returned evidence never has an `llm` section (the memo step never ran).
 */
export async function score(
  input: UnderwriteInput,
  deps: UnderwriteDeps,
): Promise<ScoreResult> {
  const { reader, dump } = engineContext(input, deps);
  const progress = freshProgress(dump);
  try {
    const stage1 = await runStage1(input, deps, reader, progress);
    if (stage1.kind === "deny") {
      return { kind: "deny", reasons: stage1.reasons, evidence: stage1.evidence, evidenceHash: stage1.evidenceHash };
    }
    return {
      kind: "eligible",
      terms: stage1.computedTerms,
      evidence: stage1.evidence,
      evidenceHash: stage1.evidenceHash,
    };
  } catch (err) {
    const { evidence, evidenceHash: hash } = buildDataUnavailableEvidence(input, progress, err);
    return { kind: "deny", reasons: ["data_unavailable"], evidence, evidenceHash: hash };
  }
}

/**
 * The full engine: discovery through terms + rules, then the credit memo, merged terms,
 * and (only on approval) a signed `TermSheet`. Every branch — hard-rule deny, memo deny,
 * approval, or an unexpected thrown error — returns evidence and its hash.
 */
export async function underwrite(
  input: UnderwriteInput,
  deps: UnderwriteDeps,
): Promise<Decision> {
  const { reader, dump } = engineContext(input, deps);
  const progress = freshProgress(dump);
  try {
    const stage1 = await runStage1(input, deps, reader, progress);
    if (stage1.kind === "deny") {
      return {
        kind: "deny",
        token: input.token,
        reasons: stage1.reasons,
        evidence: stage1.evidence,
        evidenceHash: stage1.evidenceHash,
      };
    }

    const untrustedTokenMetadata: UntrustedTokenMetadata = {
      name: stage1.tokenName,
      symbol: stage1.tokenSymbol,
      // Bankr's token-fees response carries no description field — leave it empty
      // rather than fabricating one.
      description: "",
    };

    const summary: MemoEvidenceSummary = {
      chainId: input.chainId,
      token: input.token,
      revenueMicroUsd: stage1.revenue.revenueMicroUsd,
      projected90dMicroUsd: stage1.computedTerms.projected90dMicroUsd,
      haircutBps: stage1.computedTerms.haircutBps,
      proposedCapMicroUsd: stage1.computedTerms.capMicroUsd,
      proposedFloorCents: stage1.computedTerms.floorCents,
      ageSeconds: stage1.revenue.ageSeconds,
      swapCount: stage1.quality.swapCount,
      top5ConcentrationRatio: stage1.quality.top5ConcentrationRatio,
      washRatio: stage1.quality.washRatio,
      cv: stage1.quality.cv,
      rulesFired: [],
      untrustedTokenMetadata,
    };

    const memoResult = await requestMemoDetailed(deps.llm, summary);
    const merged = mergeMemo(stage1.computedTerms, memoResult.memo);
    const finalRulesFired: DenyReason[] = merged.denied ? [merged.reason!] : [];

    const finalEvidence = buildEvidence({
      chainId: input.chainId,
      token: input.token,
      feesManager: stage1.feesManager,
      poolId: stage1.poolId,
      rawReads: progress.dump(),
      swapSample: stage1.swapSample,
      revenue: stage1.revenue,
      quality: stage1.quality,
      computedTerms: stage1.computedTerms,
      rulesFired: finalRulesFired,
      llm: {
        requestMessages: memoResult.requestMessages,
        rawResponseText: memoResult.rawResponseText,
      },
      finalTerms: merged.terms,
    });
    const finalHash = evidenceHash(finalEvidence);

    if (merged.denied) {
      return {
        kind: "deny",
        token: input.token,
        reasons: [merged.reason!],
        evidence: finalEvidence,
        evidenceHash: finalHash,
      };
    }

    // mergeMemo only returns denied:false when the memo resolved to a usable Memo.
    const memo = memoResult.memo as Memo;

    const termSheet: TermSheet = {
      agentTreasury: stage1.creator,
      agentCard: input.agentCard,
      agentId: input.agentId,
      feesManager: stage1.feesManager,
      poolId: stage1.poolId,
      expectedShares: stage1.revenue.creatorSharesWad,
      noteSupply: merged.terms.noteSupply,
      floorCents: merged.terms.floorCents,
      minPrincipal: merged.terms.minPrincipal,
      auctionBlocks: merged.terms.auctionBlocks,
      drawLimit: merged.terms.drawLimit,
      drawPeriod: BigInt(merged.terms.drawPeriod),
      gracePeriod: BigInt(merged.terms.gracePeriod),
      deadline: BigInt(input.now) + DEADLINE_WINDOW_SECONDS,
      nonce: randomNonce128(),
      memoHash: finalHash,
    };

    const digest = termSheetDigest(termSheet, input.chainId, input.hub);
    const signature = await signTermSheet(termSheet, input.chainId, input.hub, deps.signerKey);

    return {
      kind: "approve",
      token: input.token,
      termSheet,
      signature,
      digest,
      terms: toTermsSummary(merged.terms),
      memo,
      evidenceHash: finalHash,
      evidence: finalEvidence,
    };
  } catch (err) {
    const { evidence, evidenceHash: hash } = buildDataUnavailableEvidence(input, progress, err);
    return {
      kind: "deny",
      token: input.token,
      reasons: ["data_unavailable"],
      evidence,
      evidenceHash: hash,
    };
  }
}
