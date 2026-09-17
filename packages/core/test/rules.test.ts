import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { applyRules, type RulesContext } from "../src/underwrite/rules.js";
import type { RevenueWindows } from "../src/underwrite/revenue.js";
import { computeRevenue } from "../src/underwrite/revenue.js";
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

function rev(overrides: Partial<RevenueWindows> = {}): RevenueWindows {
  return {
    revenueWei: { d1: 0n, d7: 0n, d30: 0n },
    revenueMicroUsd: { d1: 1_000_000n, d7: 7_000_000n, d30: 30_000_000n },
    ageSeconds: 20n * DAY,
    creatorSharesWad: 950_000_000_000_000_000n,
    ...overrides,
  };
}

function quality(overrides: Partial<Quality> = {}): Quality {
  return {
    swapCount: 0,
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
      quality(),
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
      quality({ washRatio: 0.9, top5ConcentrationRatio: 0.95 }),
    );
    expect(reasons.sort()).toEqual(
      ["concentrated_flow", "no_recent_revenue", "too_young", "wash_trading"].sort(),
    );
  });
});

describe("applyRules (real fixtures)", () => {
  it("deployer (BNKR-paired) -> not_weth_pool", async () => {
    const bankr = loadFixture<BankrTokenFeesResponse>("deployer", "bankr");
    const entry = pickBankrToken(bankr, bankr.tokens[0]!.tokenAddress);
    expect(entry.numeraire.toLowerCase()).not.toBe(BASE_WETH.toLowerCase());

    const reasons = await applyRules(
      { poolId: entry.poolId, poolFound: true, isWethPool: false },
      undefined,
      undefined,
    );
    expect(reasons).toEqual(["not_weth_pool"]);
  });

  it("spider (locked ~1h before recording, zero swaps) -> too_young and no_recent_revenue", async () => {
    const bankr = loadFixture<BankrTokenFeesResponse>("spider", "bankr");
    const chain = loadFixture<ChainFixture>("spider", "chain");
    // The spider fixture was recorded with the lowercase token address (unlike
    // Ratspeak's checksummed one) — `getCode` fixture keys are case-sensitive strings,
    // so this must match exactly what `scripts/record-fixture.ts` was invoked with.
    const SPIDER_TOKEN = bankr.tokens[0]!.tokenAddress;
    const entry = pickBankrToken(bankr, SPIDER_TOKEN);
    const reader = createFixtureChainReader(chain);

    const rev = await computeRevenue(reader, {
      token: SPIDER_TOKEN,
      feesManager: entry.initializer,
      poolId: entry.poolId,
      creator: bankr.address as Address,
      weth: BASE_WETH,
      ethUsdFeed: BASE_ETH_USD_CHAINLINK_FEED,
    });
    expect(rev.ageSeconds).toBeLessThan(3n * DAY);
    expect(rev.revenueMicroUsd.d7).toBe(0n);

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
      ageSeconds: rev.ageSeconds,
      recentDailyRevenue: [],
    });

    const reasons = await applyRules(
      { poolId: entry.poolId, poolFound: true, isWethPool: true },
      rev,
      quality,
    );
    expect(reasons.sort()).toEqual(["no_recent_revenue", "too_young"]);
  });
});
