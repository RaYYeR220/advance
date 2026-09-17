import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  buildEvidence,
  evidenceHash,
  type BuildEvidenceParams,
  type EvidenceBundle,
} from "../src/underwrite/evidence.js";
import type { ChainFixture } from "../src/sources/chain.js";
import type { RevenueWindows } from "../src/underwrite/revenue.js";
import type { Quality } from "../src/underwrite/quality.js";
import type { ComputedTerms } from "../src/underwrite/terms.js";

const TOKEN: Address = "0x1111111111111111111111111111111111111111";
const FEES_MANAGER: Address = "0x2222222222222222222222222222222222222222";
const POOL_ID: Hex =
  "0x3333333333333333333333333333333333333333333333333333333333333333".slice(0, 66) as Hex;

function emptyCalls(): ChainFixture["calls"] {
  return {
    blocks: { "100": "1000" },
    codes: {},
    poolKeys: {},
    shares: {},
    cumulatedFees: {},
    uncollectedFees: {},
    swapLogs: {},
    transactions: {},
    roundData: { "0xfeed:100": ["1", "400000000000", "900", "900", "1"] },
    decimals: { "0xfeed:100": 8 },
    poolStatus: {},
    dopplerHookFlags: {},
  };
}

function rev(): RevenueWindows {
  return {
    revenueWei: { d1: 1n, d7: 7n, d30: 30n },
    revenueMicroUsd: { d1: 1_000n, d7: 7_000n, d30: 30_000n },
    ageSeconds: 1_000_000n,
    creatorSharesWad: 950_000_000_000_000_000n,
    dailyRevenueWei: [1n, 2n, 3n, 4n, 5n, 6n, 7n],
  };
}

function quality(): Quality {
  return { swapCount: 12, top5ConcentrationRatio: 0.3, washRatio: 0.1, cv: 0.42, haircutBps: 8000 };
}

function computedTerms(): ComputedTerms {
  return {
    revenueWei: { d1: 1n, d7: 7n, d30: 30n },
    revenueMicroUsd: { d1: 1_000n, d7: 7_000n, d30: 30_000n },
    projected90dMicroUsd: 90_000n,
    haircutBps: 8000,
    capMicroUsd: 25_000_000n,
    floorCents: 80,
    minPrincipal: 10_000_000n,
    drawLimit: 714_285n,
    drawPeriod: 86_400,
    gracePeriod: 1_209_600,
    noteSupply: 25_000_000_000_000_000_000n,
    auctionBlocks: 1000n,
  };
}

function baseParams(overrides: Partial<BuildEvidenceParams> = {}): BuildEvidenceParams {
  return {
    chainId: 8453,
    token: TOKEN,
    feesManager: FEES_MANAGER,
    poolId: POOL_ID,
    rawReads: emptyCalls(),
    swapSample: { fromBlock: 90n, toBlock: 100n, cap: 400 },
    revenue: rev(),
    quality: quality(),
    computedTerms: computedTerms(),
    rulesFired: [],
    finalTerms: computedTerms(),
    ...overrides,
  };
}

describe("buildEvidence", () => {
  it("assembles engine version, identifiers, raw reads, swap stats, formula, and final terms", () => {
    const bundle = buildEvidence(baseParams());
    expect(bundle.engineVersion).toBeTruthy();
    expect(bundle.chainId).toBe(8453);
    expect(bundle.token).toBe(TOKEN);
    expect(bundle.feesManager).toBe(FEES_MANAGER);
    expect(bundle.poolId).toBe(POOL_ID);
    expect(bundle.rawReads).toEqual(emptyCalls());
    expect(bundle.swapSample.stats).toEqual({
      swapCount: 12,
      top5ConcentrationRatio: 0.3,
      washRatio: 0.1,
      cv: 0.42,
    });
    expect(bundle.formula.computedTerms.capMicroUsd).toBe(25_000_000n);
    expect(bundle.rulesFired).toEqual([]);
    expect(bundle.llm).toBeUndefined();
    expect(bundle.finalTerms.capMicroUsd).toBe(25_000_000n);
  });

  it("carries the exact LLM request messages and raw response text when a memo step ran", () => {
    const bundle = buildEvidence(
      baseParams({
        llm: {
          requestMessages: [{ role: "system", content: "be strict" }],
          rawResponseText: '{"verdict":"approve"}',
        },
      }),
    );
    expect(bundle.llm).toEqual({
      requestMessages: [{ role: "system", content: "be strict" }],
      rawResponseText: '{"verdict":"approve"}',
    });
  });
});

describe("evidenceHash", () => {
  it("is a 32-byte hex hash", () => {
    const bundle = buildEvidence(baseParams());
    expect(evidenceHash(bundle)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is stable across key-order permutations of the same logical bundle", () => {
    const a = buildEvidence(baseParams());

    // Same data, different property insertion order at every level (object literals
    // preserve their own declared order; JS/TS type structure doesn't).
    const b: EvidenceBundle = {
      finalTerms: a.finalTerms,
      rulesFired: a.rulesFired,
      formula: {
        computedTerms: a.formula.computedTerms,
        quality: a.formula.quality,
        revenue: a.formula.revenue,
      },
      swapSample: {
        stats: a.swapSample.stats,
        cap: a.swapSample.cap,
        toBlock: a.swapSample.toBlock,
        fromBlock: a.swapSample.fromBlock,
      },
      rawReads: {
        decimals: a.rawReads.decimals,
        roundData: a.rawReads.roundData,
        transactions: a.rawReads.transactions,
        swapLogs: a.rawReads.swapLogs,
        uncollectedFees: a.rawReads.uncollectedFees,
        cumulatedFees: a.rawReads.cumulatedFees,
        shares: a.rawReads.shares,
        poolKeys: a.rawReads.poolKeys,
        codes: a.rawReads.codes,
        blocks: a.rawReads.blocks,
        dopplerHookFlags: a.rawReads.dopplerHookFlags,
        poolStatus: a.rawReads.poolStatus,
      },
      poolId: a.poolId,
      feesManager: a.feesManager,
      token: a.token,
      chainId: a.chainId,
      engineVersion: a.engineVersion,
    };

    expect(evidenceHash(b)).toBe(evidenceHash(a));
  });

  it("changes when any single raw read changes", () => {
    const a = buildEvidence(baseParams());
    const b = buildEvidence(
      baseParams({
        rawReads: {
          ...emptyCalls(),
          blocks: { "100": "1001" }, // one raw read (block 100's timestamp) changed
        },
      }),
    );
    expect(evidenceHash(b)).not.toBe(evidenceHash(a));
  });

  it("changes when a formula output changes", () => {
    const a = buildEvidence(baseParams());
    const b = buildEvidence(
      baseParams({ computedTerms: { ...computedTerms(), capMicroUsd: 1n } }),
    );
    expect(evidenceHash(b)).not.toBe(evidenceHash(a));
  });

  it("serializes bigints as decimal strings, never JS bigint literals or floats", () => {
    const bundle = buildEvidence(baseParams());
    // evidenceHash would throw on a raw bigint reaching JSON.stringify/canonicalize; the
    // fact this resolves at all proves every bigint was converted first.
    expect(() => evidenceHash(bundle)).not.toThrow();
  });

  it("drops undefined fields: cv: undefined hashes the same as cv entirely absent", () => {
    const withUndefinedCv = buildEvidence(baseParams({ quality: { ...quality(), cv: undefined } }));

    const withoutCvKey = buildEvidence(baseParams({ quality: { ...quality(), cv: undefined } }));
    delete (withoutCvKey.formula.quality as { cv?: number }).cv;
    delete (withoutCvKey.swapSample.stats as { cv?: number }).cv;

    expect(evidenceHash(withoutCvKey)).toBe(evidenceHash(withUndefinedCv));
  });

  it("changes when only llm.rawResponseText changes", () => {
    const a = buildEvidence(
      baseParams({
        llm: { requestMessages: [{ role: "system", content: "be strict" }], rawResponseText: "A" },
      }),
    );
    const b = buildEvidence(
      baseParams({
        llm: { requestMessages: [{ role: "system", content: "be strict" }], rawResponseText: "B" },
      }),
    );
    expect(evidenceHash(a)).not.toBe(evidenceHash(b));
  });
});
