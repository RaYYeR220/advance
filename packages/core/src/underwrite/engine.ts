import { randomBytes } from "node:crypto";
import type { Address, Hex } from "viem";
import { getAddress } from "viem";
import {
  chainAddresses,
  isSupportedChainId,
  type SupportedChainId,
} from "../chains.js";
import type { BankrClient } from "../sources/bankr.js";
import {
  createRecordingChainOps,
  isPoolEligibleForEscrow,
  ZERO_ADDRESS,
  type ChainFixture,
  type ChainOps,
} from "../sources/chain.js";
import { buildChainReader, type ChainReader } from "../sources/chainLogic.js";
import {
  createAirlockDiscoverySource,
  createBankrDiscoverySource,
  DiscoveryNotFoundError,
  type DiscoveryResult,
} from "../sources/discovery.js";
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
import { computeRevenue, type RevenueWindows } from "./revenue.js";
import { applyRules, termsDenyReasons, type DenyReason } from "./rules.js";
import {
  assertUsableEnv,
  computeTerms,
  type ComputedTerms,
  type TermsSummary,
  type UnderwritingEnv,
} from "./terms.js";

export type { SupportedChainId } from "../chains.js";

const DAY_SECONDS = 86_400n;
const SWAP_LOOKBACK_DAYS = 7n;
const SWAP_SAMPLE_CAP = 400;
const DEADLINE_WINDOW_SECONDS = 3600n;
/** `input.now`, if given, must be within this many seconds of the chain's own latest
 * block timestamp — otherwise the caller's clock (or the request itself) isn't trusted
 * enough to derive a signed deadline from. */
const MAX_NOW_SKEW_SECONDS = 300;

const ZERO_BYTES32: Hex = `0x${"0".repeat(64)}` as Hex;
const SIGNER_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export interface UnderwriteInput {
  token: Address;
  agentCard: Address;
  agentId: bigint;
  chainId: SupportedChainId;
  hub: Address;
  /** Unix seconds. Only used to derive `TermSheet.deadline` (as a sanity check against
   * chain time) — every chain read is anchored to the reader's own latest block, never to
   * this value. Must be within `MAX_NOW_SKEW_SECONDS` of chain time. */
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
  /**
   * Known-Advance-escrow lookup, forwarded to `applyRules`. The `AdvanceHub` contract
   * (`loanIdOf`) this will eventually call doesn't exist yet, so this is optional;
   * defaults to `applyRules`'s own always-false stub when omitted.
   */
  isEscrowed?: (poolId: Hex) => Promise<boolean>;
}

export type ScoreDeps = Pick<UnderwriteDeps, "bankr" | "chain" | "env">;

export type ScoreResult =
  | { kind: "deny"; token: Address; reasons: DenyReason[]; evidenceHash: Hex; evidence: EvidenceBundle }
  | { kind: "eligible"; token: Address; terms: ComputedTerms; evidenceHash: Hex; evidence: EvidenceBundle };

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

/** Config the caller got wrong — a bad address, an out-of-range value, a clock too far
 * from chain time, an env ceiling above policy. Thrown to the caller directly; never
 * turned into a deny (the request never got far enough to underwrite anything). */
export class InvalidUnderwriteInput extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUnderwriteInput";
  }
}

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

/** Redacts any `http(s)://` or `ws(s)://` URL from an error message before it can reach
 * evidence — an RPC URL must never be recorded, and this catches it regardless of which
 * dependency (chain client, HTTP client, websocket transport) embedded it in the message. */
function redactSecrets(message: string): string {
  return message.replace(/(https?|wss?):\/\/\S+/gi, "[redacted]");
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

/**
 * Validates everything about `input`/`deps` that can be checked without any I/O — address
 * formats (also normalizing every address to EIP-55 checksum form, so evidence and
 * fixture keys are casing-independent downstream), `agentId >= 0`, a sane `now`, the
 * signer key's shape, and the env's own ceilings (the exact same rule `computeTerms`
 * enforces, via the shared `assertUsableEnv`). Runs before any chain or LLM call.
 */
function validateInput(
  input: UnderwriteInput,
  deps: { env: UnderwritingEnv; signerKey?: Hex },
): UnderwriteInput {
  if (!isSupportedChainId(input.chainId)) {
    throw new InvalidUnderwriteInput(`unsupported chainId: ${input.chainId}`);
  }

  let token: Address;
  let agentCard: Address;
  let hub: Address;
  try {
    token = getAddress(input.token);
    agentCard = getAddress(input.agentCard);
    hub = getAddress(input.hub);
  } catch (err) {
    throw new InvalidUnderwriteInput(`invalid address in input: ${errorMessage(err)}`);
  }

  if (input.agentId < 0n) {
    throw new InvalidUnderwriteInput(`agentId must be >= 0, got ${input.agentId}`);
  }
  if (!Number.isInteger(input.now) || input.now <= 0) {
    throw new InvalidUnderwriteInput(
      `now must be a positive integer unix timestamp, got ${input.now}`,
    );
  }
  if (deps.signerKey !== undefined && !SIGNER_KEY_PATTERN.test(deps.signerKey)) {
    throw new InvalidUnderwriteInput("signerKey must be a 0x-prefixed 32-byte hex string");
  }

  try {
    assertUsableEnv(deps.env);
  } catch (err) {
    throw new InvalidUnderwriteInput(errorMessage(err));
  }

  return { ...input, token, agentCard, hub };
}

/** `input.now`, if it drifted more than `MAX_NOW_SKEW_SECONDS` from the chain's own
 * latest block timestamp, isn't trusted — reject up front rather than deriving a signed
 * deadline from a clock that might be wrong (or an attempt to backdate/postdate one). */
function validateChainTime(input: UnderwriteInput, latestTimestamp: bigint): void {
  const chainNow = Number(latestTimestamp);
  const skew = Math.abs(input.now - chainNow);
  if (skew > MAX_NOW_SKEW_SECONDS) {
    throw new InvalidUnderwriteInput(
      `input.now (${input.now}) is ${skew}s from chain time (${chainNow}), max ${MAX_NOW_SKEW_SECONDS}s`,
    );
  }
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
  discoveryViews: { bankr?: DiscoveryResult; airlock?: DiscoveryResult };
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
    discoveryViews: {},
    dump,
  };
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

/** Builds a deny (or `data_unavailable`) evidence bundle straight from whatever
 * `progress` has accumulated so far — the one place every early-exit and the top-level
 * catch construct their `EvidenceBundle`, so they can never drift out of sync. */
function buildDeny(
  input: UnderwriteInput,
  progress: Progress,
  reasons: DenyReason[],
  extra?: { error?: string; discovery?: Progress["discoveryViews"] },
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
    error: extra?.error,
    discovery:
      extra?.discovery && (extra.discovery.bankr || extra.discovery.airlock)
        ? extra.discovery
        : undefined,
  });
  return { kind: "deny", reasons, evidence, evidenceHash: evidenceHash(evidence) };
}

function buildDataUnavailableDeny(
  input: UnderwriteInput,
  progress: Progress,
  err: unknown,
): Stage1Deny {
  return buildDeny(input, progress, ["data_unavailable"], { error: errorMessage(err) });
}

type DiscoveryStep = { result: DiscoveryResult } | { deny: Stage1Deny };

/**
 * Resolves who the pool/feesManager/creator are for `input.token`. On Base mainnet, both
 * Bankr and the on-chain Airlock source are consulted concurrently and must agree on
 * `feesManager`/`poolId`/`numeraire` (a disagreement — including only one side finding a
 * pool at all — denies `data_unavailable` with both raw views in evidence). Off mainnet,
 * Airlock is the only source (Bankr has no non-mainnet data). Either way, a genuine "no
 * pool for this token" from every consulted source denies `not_bankr_doppler`; any other
 * failure (a real outage, malformed data) propagates so the caller fails closed.
 */
async function resolveDiscovery(
  input: UnderwriteInput,
  deps: Pick<UnderwriteDeps, "bankr" | "chain" | "env">,
  reader: ChainReader,
  progress: Progress,
): Promise<DiscoveryStep> {
  const addresses = chainAddresses(input.chainId);
  const airlockSource = createAirlockDiscoverySource(reader, addresses.dopplerAirlock);

  if (input.chainId !== 8453) {
    try {
      const airlockResult = await airlockSource.discover(input.token);
      progress.discoveryViews = { airlock: airlockResult };
      return { result: airlockResult };
    } catch (err) {
      if (err instanceof DiscoveryNotFoundError) {
        return { deny: buildDeny(input, progress, ["not_bankr_doppler"]) };
      }
      throw err;
    }
  }

  const bankrSource = createBankrDiscoverySource(deps.bankr);
  const [bankrOutcome, airlockOutcome] = await Promise.allSettled([
    bankrSource.discover(input.token),
    airlockSource.discover(input.token),
  ]);

  const bankrResult = bankrOutcome.status === "fulfilled" ? bankrOutcome.value : undefined;
  const airlockResult =
    airlockOutcome.status === "fulfilled" ? airlockOutcome.value : undefined;
  progress.discoveryViews = { bankr: bankrResult, airlock: airlockResult };

  // A real failure (not "no pool found") must fail closed, not be silently treated as a
  // clean miss from that one source.
  if (bankrOutcome.status === "rejected" && !(bankrOutcome.reason instanceof DiscoveryNotFoundError)) {
    throw bankrOutcome.reason;
  }
  if (
    airlockOutcome.status === "rejected" &&
    !(airlockOutcome.reason instanceof DiscoveryNotFoundError)
  ) {
    throw airlockOutcome.reason;
  }

  if (!bankrResult && !airlockResult) {
    return { deny: buildDeny(input, progress, ["not_bankr_doppler"]) };
  }
  if (!bankrResult || !airlockResult) {
    return {
      deny: buildDeny(input, progress, ["data_unavailable"], {
        discovery: progress.discoveryViews,
      }),
    };
  }

  const agree =
    bankrResult.feesManager.toLowerCase() === airlockResult.feesManager.toLowerCase() &&
    bankrResult.poolId.toLowerCase() === airlockResult.poolId.toLowerCase() &&
    bankrResult.numeraire.toLowerCase() === airlockResult.numeraire.toLowerCase();
  if (!agree) {
    return {
      deny: buildDeny(input, progress, ["data_unavailable"], {
        discovery: progress.discoveryViews,
      }),
    };
  }

  return { result: bankrResult };
}

/**
 * Discovery through terms + hard rules — shared by `score` and `underwrite`. Never
 * catches its own errors: a thrown error here propagates to the caller's top-level
 * try/catch, which turns it into a `data_unavailable` deny using whatever `progress` had
 * accumulated so far.
 */
async function runStage1(
  input: UnderwriteInput,
  deps: UnderwriteDeps | ScoreDeps,
  reader: ChainReader,
  progress: Progress,
): Promise<Stage1Result> {
  const addresses = chainAddresses(input.chainId);

  const discoveryStep = await resolveDiscovery(input, deps, reader, progress);
  if ("deny" in discoveryStep) return discoveryStep.deny;
  const discovery = discoveryStep.result;

  progress.feesManager = discovery.feesManager;
  progress.poolId = discovery.poolId;

  // Bind the pool to the token: the claimed feesManager must be the chain's known Doppler
  // deployment, and the claimed poolId must equal the on-chain poolKey's own hash — a
  // wrong layout or an unknown initializer is a definitive on-chain fact, not a
  // source-disagreement ambiguity, so it denies `not_bankr_doppler` even when only one
  // source was ever consulted (Sepolia).
  if (discovery.feesManager.toLowerCase() !== addresses.dopplerFeesManager.toLowerCase()) {
    return buildDeny(input, progress, ["not_bankr_doppler"], {
      discovery: progress.discoveryViews,
    });
  }
  const assetState = await reader.getAssetState(discovery.feesManager, input.token);
  if (assetState.poolId.toLowerCase() !== discovery.poolId.toLowerCase()) {
    return buildDeny(input, progress, ["not_bankr_doppler"], {
      discovery: progress.discoveryViews,
    });
  }

  const isWethPool =
    assetState.poolKey.currency0.toLowerCase() === addresses.weth.toLowerCase() ||
    assetState.poolKey.currency1.toLowerCase() === addresses.weth.toLowerCase();
  if (!isWethPool) {
    return buildDeny(input, progress, ["not_weth_pool"]);
  }

  if (!isPoolEligibleForEscrow(assetState)) {
    return buildDeny(input, progress, ["pool_not_locked"]);
  }

  const revenue = await computeRevenue(reader, {
    token: input.token,
    feesManager: discovery.feesManager,
    poolId: discovery.poolId,
    creator: discovery.creator,
    weth: addresses.weth,
    ethUsdFeed: addresses.ethUsdFeed,
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
    poolManager: addresses.poolManager,
    poolId: discovery.poolId,
    fromBlock: swapSample.fromBlock,
    toBlock: swapSample.toBlock,
    cap: swapSample.cap,
  });

  const quality = computeQuality(swaps, {
    creator: discovery.creator,
    ageSeconds: revenue.ageSeconds,
    recentDailyRevenue: revenue.dailyRevenueWei,
  });
  progress.quality = quality;

  // `isEscrowed` only exists on the richer `UnderwriteDeps` (score()'s deps never have
  // it) — a plain property read on an object that lacks it is `undefined`, not an error.
  const isEscrowed = (deps as Partial<UnderwriteDeps>).isEscrowed;
  const rulesReasons = await applyRules(
    {
      poolId: discovery.poolId,
      poolFound: true,
      isWethPool: true,
      poolLocked: true,
      isEscrowed,
    },
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
    feesManager: discovery.feesManager,
    poolId: discovery.poolId,
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
    feesManager: discovery.feesManager,
    poolId: discovery.poolId,
    creator: discovery.creator,
    tokenName: discovery.tokenName,
    tokenSymbol: discovery.tokenSymbol,
    revenue,
    quality,
    computedTerms,
    swapSample,
    evidence,
    evidenceHash: hash,
  };
}

function engineContext(input: UnderwriteInput, deps: Pick<UnderwriteDeps, "chain">) {
  const { ops, dump } = createRecordingChainOps(deps.chain, {
    token: input.token,
    chainId: input.chainId,
  });
  return { reader: buildChainReader(ops), dump: () => dump().calls };
}

/** Chain-id guard: the injected `ChainReader` must actually be talking to `input.chainId`
 * — every address in `chainAddresses(input.chainId)` is meaningless otherwise. A mismatch
 * throws (caught by the caller's top-level catch as `data_unavailable`), checked before
 * any discovery, signing, or LLM call. */
async function assertChainIdMatches(
  input: UnderwriteInput,
  reader: ChainReader,
): Promise<bigint> {
  const [reportedChainId, latest] = await Promise.all([
    reader.getChainId(),
    reader.getLatestBlock(),
  ]);
  if (reportedChainId !== input.chainId) {
    throw new Error(
      `chain reader reports chainId ${reportedChainId}, input.chainId is ${input.chainId}`,
    );
  }
  return latest.timestamp;
}

/**
 * Runs the engine up to terms + hard rules only — no memo request, no signature. Useful
 * for a quick eligibility check without spending an LLM call or minting a term sheet.
 * The returned evidence never has an `llm` section (the memo step never ran).
 */
export async function score(
  rawInput: UnderwriteInput,
  deps: ScoreDeps,
): Promise<ScoreResult> {
  const input = validateInput(rawInput, deps);
  const { reader, dump } = engineContext(input, deps);
  const progress = freshProgress(dump);
  try {
    const latestTimestamp = await assertChainIdMatches(input, reader);
    validateChainTime(input, latestTimestamp);

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
    return {
      kind: "eligible",
      token: input.token,
      terms: stage1.computedTerms,
      evidence: stage1.evidence,
      evidenceHash: stage1.evidenceHash,
    };
  } catch (err) {
    if (err instanceof InvalidUnderwriteInput) throw err;
    const deny = buildDataUnavailableDeny(input, progress, err);
    return { kind: "deny", token: input.token, reasons: deny.reasons, evidence: deny.evidence, evidenceHash: deny.evidenceHash };
  }
}

/**
 * The full engine: discovery through terms + rules, then the credit memo, merged terms,
 * and (only on approval) a signed `TermSheet`. Every branch — hard-rule deny, memo deny,
 * approval, or an unexpected thrown error — returns evidence and its hash.
 */
export async function underwrite(
  rawInput: UnderwriteInput,
  deps: UnderwriteDeps,
): Promise<Decision> {
  const input = validateInput(rawInput, deps);
  const { reader, dump } = engineContext(input, deps);
  const progress = freshProgress(dump);
  try {
    const latestTimestamp = await assertChainIdMatches(input, reader);
    validateChainTime(input, latestTimestamp);

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
      // Neither Bankr's token-fees response nor Airlock's AssetData carries a
      // description field — leave it empty rather than fabricating one.
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
      deadline: latestTimestamp + DEADLINE_WINDOW_SECONDS,
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
    if (err instanceof InvalidUnderwriteInput) throw err;
    const deny = buildDataUnavailableDeny(input, progress, err);
    return {
      kind: "deny",
      token: input.token,
      reasons: deny.reasons,
      evidence: deny.evidence,
      evidenceHash: deny.evidenceHash,
    };
  }
}
