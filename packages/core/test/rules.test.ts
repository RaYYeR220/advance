import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { applyRules, termsDenyReasons, type RulesContext } from "../src/underwrite/rules.js";
import type { RevenueWindows } from "../src/underwrite/revenue.js";
import { checkIsWethPool, computeRevenue } from "../src/underwrite/revenue.js";
import { computeQuality, type Quality } from "../src/underwrite/quality.js";
import {
  createFixtureChainReader,
  type ChainFixture,
} from "../src/sources/chain.js";
import {
  pickBankrToken,
  type BankrTokenFeesResponse,
} from "../src/sources/bankr.js";
import { BASE_ETH_USD_CHAINLINK_FEED, BASE_V4_POOL_MANAGER, BASE_WETH } from "../src/chains.js";

const DAY = 86_400n;
const POOL_ID: Hex =
  "0x5e9782079683037fc8bb57625683359d9efaef80f2b829c4bb5b1896c6bb40b6";

function baseCtx(overrides: Partial<RulesContext> = {}): RulesContext {
  return { poolId: POOL_ID, poolFound: true, isWethPool: true, ...overrides };
}

const SEVEN_ZERO_BUCKETS: readonly bigint[] = [0n, 0n, 0n, 0n, 0n, 0n, 0n];

function rev(overrides: Partial<RevenueWindows> = {}): RevenueWindows {
  return {
    revenueWei: { d1: 0n, d7: 0n, d30: 0n },
    revenueMicroUsd: { d1: 1_000_000n, d7: 7_000_000n, d30: 30_000_000n },
    ageSeconds: 20n * DAY,
    creatorSharesWad: 950_000_000_000_000_000n,
    dailyRevenueWei: SEVEN_ZERO_BUCKETS,
    ...overrides,
  };
}

// swapCount defaults nonzero (a healthy pool has swaps) so the default fixture doesn't
// itself trip the "zero swaps despite nonzero d7" data_unavailable check below.
function quality(overrides: Partial<Quality> = {}): Quality {
  return {
    swapCount: 50,
    top5ConcentrationRatio: 0,
    washRatio: 0,
    cv: undefined,
    haircutBps: 10000,
    ...overrides,
  };
}

function loadFixture<T>(slug: string, file: "bankr" | "chain"): T {
  const path = resolve(import.meta.dirname, `fixtures/${slug}/${file}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

describe("applyRules (synthetic)", () => {
  it("a healthy pool with no issues denies nothing", async () => {
    const reasons = await applyRules(baseCtx(), rev(), quality());
    expect(reasons).toEqual([]);
  });

  it("a data-source error short-circuits everything else -> data_unavailable only", async () => {
    const reasons = await applyRules(
      baseCtx({ dataError: true, isWethPool: false, poolFound: false }),
      undefined,
      undefined,
    );
    expect(reasons).toEqual(["data_unavailable"]);
  });

  it("no pool found in Bankr/Doppler -> not_bankr_doppler", async () => {
    const reasons = await applyRules(baseCtx({ poolFound: false }), undefined, undefined);
    expect(reasons).toEqual(["not_bankr_doppler"]);
  });

  it("WETH is not one of the pool currencies -> not_weth_pool", async () => {
    const reasons = await applyRules(baseCtx({ isWethPool: false }), undefined, undefined);
    expect(reasons).toEqual(["not_weth_pool"]);
  });

  it("rev unexpectedly missing despite a found WETH pool -> data_unavailable (fails closed)", async () => {
    const reasons = await applyRules(baseCtx(), undefined, undefined);
    expect(reasons).toEqual(["data_unavailable"]);
  });

  it("quality unexpectedly missing despite a found WETH pool and rev -> data_unavailable (fails closed)", async () => {
    const reasons = await applyRules(baseCtx(), rev(), undefined);
    expect(reasons).toEqual(["data_unavailable"]);
  });

  it("dailyRevenueWei with fewer than 7 buckets -> data_unavailable (fails closed instead of letting computeQuality's no-haircut default flow through)", async () => {
    const reasons = await applyRules(baseCtx(), rev({ dailyRevenueWei: [] }), quality());
    expect(reasons).toEqual(["data_unavailable"]);
  });

  it("dailyRevenueWei with more than 7 buckets -> data_unavailable", async () => {
    const reasons = await applyRules(
      baseCtx(),
      rev({ dailyRevenueWei: [...SEVEN_ZERO_BUCKETS, 0n] }),
      quality(),
    );
    expect(reasons).toEqual(["data_unavailable"]);
  });

  it("zero swaps despite nonzero d7 revenue -> data_unavailable (the swap sample looks broken, not that trading never happened)", async () => {
    const reasons = await applyRules(
      baseCtx(),
      rev(), // d7 = 7_000_000n (nonzero) by default
      quality({ swapCount: 0 }),
    );
    expect(reasons).toEqual(["data_unavailable"]);
  });

  it("zero swaps with zero d7 revenue is NOT data_unavailable (consistent: no revenue, no trades)", async () => {
    const reasons = await applyRules(
      baseCtx(),
      rev({ revenueMicroUsd: { d1: 0n, d7: 0n, d30: 0n } }),
      quality({ swapCount: 0 }),
    );
    expect(reasons).not.toContain("data_unavailable");
    expect(reasons).toContain("no_recent_revenue");
  });

  it("creator shares == 0 -> creator_has_no_shares", async () => {
    const reasons = await applyRules(baseCtx(), rev({ creatorSharesWad: 0n }), quality());
    expect(reasons).toContain("creator_has_no_shares");
  });

  it("already escrowed (injected stub resolves true) -> already_escrowed", async () => {
    const reasons = await applyRules(
      baseCtx({ isEscrowed: async () => true }),
      rev(),
      quality(),
    );
    expect(reasons).toContain("already_escrowed");
  });

  it("the isEscrowed stub defaults to false when not injected", async () => {
    const reasons = await applyRules(baseCtx(), rev(), quality());
    expect(reasons).not.toContain("already_escrowed");
  });

  it("age < 3d -> too_young", async () => {
    const reasons = await applyRules(baseCtx(), rev({ ageSeconds: 1n * DAY }), quality());
    expect(reasons).toContain("too_young");
  });

  it("age == 3d exactly is not too_young (strict less-than)", async () => {
    const reasons = await applyRules(baseCtx(), rev({ ageSeconds: 3n * DAY }), quality());
    expect(reasons).not.toContain("too_young");
  });

  it("d7 == 0 -> no_recent_revenue", async () => {
    const reasons = await applyRules(
      baseCtx(),
      rev({ revenueMicroUsd: { d1: 0n, d7: 0n, d30: 30_000_000n } }),
      quality({ swapCount: 0 }),
    );
    expect(reasons).toContain("no_recent_revenue");
  });

  it("wash ratio > 50% -> wash_trading", async () => {
    const reasons = await applyRules(baseCtx(), rev(), quality({ washRatio: 0.6 }));
    expect(reasons).toContain("wash_trading");
  });

  it("wash ratio == 50% exactly does not deny (strict greater-than)", async () => {
    const reasons = await applyRules(baseCtx(), rev(), quality({ washRatio: 0.5 }));
    expect(reasons).not.toContain("wash_trading");
  });

  it("top-5 concentration > 80% -> concentrated_flow", async () => {
    const reasons = await applyRules(baseCtx(), rev(), quality({ top5ConcentrationRatio: 0.9 }));
    expect(reasons).toContain("concentrated_flow");
  });

  it("top-5 concentration == 80% exactly does not deny (strict greater-than)", async () => {
    const reasons = await applyRules(baseCtx(), rev(), quality({ top5ConcentrationRatio: 0.8 }));
    expect(reasons).not.toContain("concentrated_flow");
  });

  it("multiple independent reasons accumulate rather than short-circuiting after the first", async () => {
    const reasons = await applyRules(
      baseCtx(),
      rev({ ageSeconds: 1n * DAY, revenueMicroUsd: { d1: 0n, d7: 0n, d30: 0n } }),
      quality({ washRatio: 0.9, top5ConcentrationRatio: 0.95, swapCount: 0 }),
    );
    expect(reasons.sort()).toEqual(
      ["concentrated_flow", "no_recent_revenue", "too_young", "wash_trading"].sort(),
    );
  });
});

describe("termsDenyReasons", () => {
  it("minPrincipal below $1 -> below_minimum", () => {
    expect(termsDenyReasons({ minPrincipal: 999_999n })).toEqual(["below_minimum"]);
  });

  it("minPrincipal of exactly $1 does not deny", () => {
    expect(termsDenyReasons({ minPrincipal: 1_000_000n })).toEqual([]);
  });

  it("minPrincipal of $0 -> below_minimum", () => {
    expect(termsDenyReasons({ minPrincipal: 0n })).toEqual(["below_minimum"]);
  });

  it("a comfortably large minPrincipal does not deny", () => {
    expect(termsDenyReasons({ minPrincipal: 10_000_000n })).toEqual([]);
  });
});

describe("applyRules (real fixtures)", () => {
  it("deployer (BNKR-paired) -> not_weth_pool, derived from on-chain getPoolKey, not Bankr's numeraire", async () => {
    const bankr = loadFixture<BankrTokenFeesResponse>("deployer", "bankr");
    const chain = loadFixture<ChainFixture>("deployer", "chain");
    const entry = pickBankrToken(bankr, bankr.tokens[0]!.tokenAddress);
    const reader = createFixtureChainReader(chain);

    const isWethPool = await checkIsWethPool(reader, entry.initializer, entry.poolId, BASE_WETH);
    expect(isWethPool).toBe(false);

    const reasons = await applyRules(
      { poolId: entry.poolId, poolFound: true, isWethPool },
      undefined,
      undefined,
    );
    expect(reasons).toEqual(["not_weth_pool"]);
  });

  it("spider (locked a few hours before recording, zero on-chain daily buckets, zero swaps) -> too_young and no_recent_revenue", async () => {
    const bankr = loadFixture<BankrTokenFeesResponse>("spider", "bankr");
    const chain = loadFixture<ChainFixture>("spider", "chain");
    // The spider fixture was recorded with the lowercase token address (unlike
    // Ratspeak's checksummed one) — `getCode` fixture keys are case-sensitive strings,
    // so this must match exactly what the recording run was invoked with.
    const SPIDER_TOKEN = bankr.tokens[0]!.tokenAddress;
    const entry = pickBankrToken(bankr, SPIDER_TOKEN);
    const reader = createFixtureChainReader(chain);

    const isWethPool = await checkIsWethPool(reader, entry.initializer, entry.poolId, BASE_WETH);
    expect(isWethPool).toBe(true);

    const revenue = await computeRevenue(reader, {
      token: SPIDER_TOKEN,
      feesManager: entry.initializer,
      poolId: entry.poolId,
      creator: bankr.address as Address,
      weth: BASE_WETH,
      ethUsdFeed: BASE_ETH_USD_CHAINLINK_FEED,
    });
    expect(revenue.ageSeconds).toBeLessThan(3n * DAY);
    expect(revenue.revenueMicroUsd.d7).toBe(0n);
    // Still exactly 7 on-chain buckets, all zero. Anchor 0 (now) is after the lock; its
    // bucket is 0 because there were no swaps yet, not because the pool didn't exist.
    // Anchors 1-7 do predate the lock (WrongPoolStatus pre-lock reads as zero accrual).
    // Either way computeRevenue doesn't throw for this legitimately-empty history.
    expect(revenue.dailyRevenueWei).toEqual([0n, 0n, 0n, 0n, 0n, 0n, 0n]);

    const latest = await reader.getLatestBlock();
    const fromBlock = await reader.blockAt(latest.timestamp - 7n * DAY);
    const swaps = await reader.getSwaps({
      poolManager: BASE_V4_POOL_MANAGER,
      poolId: entry.poolId,
      fromBlock,
      toBlock: latest.number,
    });
    const quality = computeQuality(swaps, {
      creator: bankr.address as Address,
      ageSeconds: revenue.ageSeconds,
      recentDailyRevenue: revenue.dailyRevenueWei,
    });

    const reasons = await applyRules(
      { poolId: entry.poolId, poolFound: true, isWethPool: true },
      revenue,
      quality,
    );
    // Zero swaps here is consistent with zero d7 revenue (not a data_unavailable
    // suspicious-empty-sample case) — a genuinely brand-new pool with no trading yet.
    expect(reasons.sort()).toEqual(["no_recent_revenue", "too_young"]);
  });
});
