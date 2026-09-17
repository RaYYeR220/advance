import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { computeTerms, type UnderwritingEnv } from "../src/underwrite/terms.js";
import { computeRevenue, type RevenueWindows } from "../src/underwrite/revenue.js";
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
import { applyRules, termsDenyReasons } from "../src/underwrite/rules.js";

const DAY = 86_400n;

function rev(overrides: Partial<RevenueWindows> = {}): RevenueWindows {
  return {
    revenueWei: { d1: 0n, d7: 0n, d30: 0n },
    revenueMicroUsd: { d1: 0n, d7: 0n, d30: 0n },
    ageSeconds: 20n * DAY,
    creatorSharesWad: 950_000_000_000_000_000n,
    dailyRevenueWei: [],
    ...overrides,
  };
}

function quality(haircutBps: number): Quality {
  return { swapCount: 0, top5ConcentrationRatio: 0, washRatio: 0, cv: undefined, haircutBps };
}

describe("computeTerms", () => {
  it("steady revenue ($1/day every window, no haircut) projects to $90 over 90d, cap clamps to the mainnet $25 hard ceiling", () => {
    const r = rev({
      revenueMicroUsd: { d1: 1_000_000n, d7: 7_000_000n, d30: 30_000_000n },
    });
    const terms = computeTerms(r, quality(10000), { network: "mainnet" });

    expect(terms.projected90dMicroUsd).toBe(90_000_000n); // $90
    expect(terms.haircutBps).toBe(10000);
    // rawCap = $90 * 0.5 * 1.0 = $45, clamped down to the mainnet $25 hard ceiling.
    expect(terms.capMicroUsd).toBe(25_000_000n); // $25
    expect(terms.noteSupply).toBe(25_000_000_000_000_000_000n); // capMicroUsd * 1e12
    expect(terms.floorCents).toBe(80); // no bump: haircut >= 7000, age >= 14d
    expect(terms.minPrincipal).toBe(10_000_000n); // $25 * 80% * 50%
    expect(terms.drawLimit).toBe(714_285n); // max(minPrincipal/14, 100_000), floored
    expect(terms.drawPeriod).toBe(86_400);
    expect(terms.gracePeriod).toBe(1_209_600);
    expect(terms.auctionBlocks).toBe(1000n);
    expect(termsDenyReasons(terms)).toEqual([]);

    // Every money/bps/count output is bigint or a plain integer — no floats leak out.
    for (const value of [
      terms.projected90dMicroUsd,
      terms.capMicroUsd,
      terms.noteSupply,
      terms.minPrincipal,
      terms.drawLimit,
      terms.auctionBlocks,
    ]) {
      expect(typeof value).toBe("bigint");
    }
    expect(Number.isInteger(terms.haircutBps)).toBe(true);
    expect(Number.isInteger(terms.floorCents)).toBe(true);
  });

  it("demo env defaults to the $10,000 hard ceiling and 250 auctionBlocks instead of mainnet's", () => {
    const r = rev({ revenueMicroUsd: { d1: 1_000_000n, d7: 7_000_000n, d30: 30_000_000n } });
    const terms = computeTerms(r, quality(10000), { network: "demo" });
    expect(terms.capMicroUsd).toBe(45_000_000n); // rawCap $45 stays under the $10,000 ceiling
    expect(terms.auctionBlocks).toBe(250n);
  });

  it("decaying Ratspeak-like profile (large d30, tiny d1) -> small base, decay floors at the amended 1000bps minimum", () => {
    const r = rev({ revenueMicroUsd: { d1: 1_000n, d7: 700_000n, d30: 90_000_000n } });
    const terms = computeTerms(r, quality(10000), { network: "mainnet" });

    // base = min(r7=100_000, r30=3_000_000, (r1+r7)/2=50_500) = 50_500
    // decayBps = clamp(10000*100_000/3_000_000, 1000, 10000) = clamp(333, 1000, 10000) = 1000
    // (amended floor: the old [5000,10000]/[0.97,1.0] pair let this project ~1.59M micro-USD;
    // the amended [1000,10000]/[0.90,1.0] pair decays it much harder, to ~530k.)
    expect(terms.projected90dMicroUsd).toBe(530_039n);
    expect(terms.capMicroUsd).toBe(260_000n); // ~$0.26 — small, decay-aware cap
    expect(terms.minPrincipal).toBe(104_000n);
    expect(terms.drawLimit).toBe(100_000n); // minPrincipal/14 (7_428) floored up to the 100_000 minimum
  });

  it("sanity: a collapsing token (r1 well under r7/7, large historical r30) never projects more than 90x its current daily revenue", () => {
    // Regression case for the amended clamps: under the old [5000,10000]/[0.97,1.0] pair
    // this same input projected 172_966 micro-USD (~173x r1=1000) — exactly the failure
    // mode the review flagged. The amended clamps bring it under the 90x bound.
    const r1 = 1_000n;
    const rInput = rev({ revenueMicroUsd: { d1: r1, d7: 70_000n, d30: 15_000_000n } });
    const terms = computeTerms(rInput, quality(10000), { network: "mainnet" });
    expect(terms.projected90dMicroUsd).toBeLessThan(90n * r1);
  });

  it("below-minimum: a small but nonzero cap produces minPrincipal under the $1 floor", () => {
    const r = rev({ revenueMicroUsd: { d1: 44_000n, d7: 308_000n, d30: 1_320_000n } });
    const terms = computeTerms(r, quality(10000), { network: "mainnet" });

    expect(terms.capMicroUsd).toBe(1_980_000n); // ~$1.98 — cap itself is nonzero
    expect(terms.minPrincipal).toBe(792_000n); // < 1_000_000n ($1)
    expect(terms.minPrincipal).toBeLessThan(1_000_000n);
    expect(termsDenyReasons(terms)).toEqual(["below_minimum"]);
  });

  it("young token (age < 14d) + haircut < 7000 stack both floor bumps (80 -> 90 cents)", () => {
    const r = rev({
      revenueMicroUsd: { d1: 1_000_000n, d7: 7_000_000n, d30: 30_000_000n },
      ageSeconds: 5n * DAY,
    });
    const terms = computeTerms(r, quality(6000), { network: "mainnet" });
    expect(terms.floorCents).toBe(90);
    expect(terms.minPrincipal).toBe(11_250_000n);
    expect(terms.drawLimit).toBe(803_571n);
  });

  it("an explicit env override wins over the network default (hard ceiling, auctionBlocks, draw/grace periods)", () => {
    const r = rev({ revenueMicroUsd: { d1: 1_000_000n, d7: 7_000_000n, d30: 30_000_000n } });
    const env: UnderwritingEnv = {
      network: "mainnet",
      hardCeilingMicroUsd: 1_000_000n, // $1 — well under the $45 raw cap, and under the $25 mainnet ceiling
      auctionBlocks: 500n,
      drawPeriodSeconds: 60,
      gracePeriodSeconds: 120,
    };
    const terms = computeTerms(r, quality(10000), env);
    expect(terms.capMicroUsd).toBe(1_000_000n);
    expect(terms.auctionBlocks).toBe(500n);
    expect(terms.drawPeriod).toBe(60);
    expect(terms.gracePeriod).toBe(120);
  });

  it("rejects an auctionBlocks override that doesn't divide 1e7", () => {
    const r = rev({ revenueMicroUsd: { d1: 1_000_000n, d7: 7_000_000n, d30: 30_000_000n } });
    expect(() =>
      computeTerms(r, quality(10000), { network: "mainnet", auctionBlocks: 3n }),
    ).toThrow(/divide 1e7/);
  });

  it("zero revenue -> zero projection, zero cap, zero draw terms (never negative, never NaN)", () => {
    const terms = computeTerms(rev(), quality(10000), { network: "mainnet" });
    expect(terms.projected90dMicroUsd).toBe(0n);
    expect(terms.capMicroUsd).toBe(0n);
    expect(terms.noteSupply).toBe(0n);
    expect(terms.minPrincipal).toBe(0n);
    expect(terms.drawLimit).toBe(100_000n); // floor minimum still applies
  });

  describe("input validation", () => {
    it("rejects negative revenueMicroUsd", () => {
      const r = rev({ revenueMicroUsd: { d1: -1n, d7: 0n, d30: 0n } });
      expect(() => computeTerms(r, quality(10000), { network: "mainnet" })).toThrow(/non-negative/);
    });

    it("rejects negative ageSeconds", () => {
      const r = rev({ ageSeconds: -1n });
      expect(() => computeTerms(r, quality(10000), { network: "mainnet" })).toThrow(/non-negative/);
    });

    it("rejects an out-of-range haircutBps", () => {
      const r = rev();
      expect(() => computeTerms(r, quality(10001), { network: "mainnet" })).toThrow(/haircutBps/);
      expect(() => computeTerms(r, quality(-1), { network: "mainnet" })).toThrow(/haircutBps/);
    });

    it("rejects a non-positive drawPeriodSeconds override", () => {
      const r = rev();
      expect(() =>
        computeTerms(r, quality(10000), { network: "mainnet", drawPeriodSeconds: 0 }),
      ).toThrow(/drawPeriodSeconds/);
    });

    it("rejects a non-integer gracePeriodSeconds override", () => {
      const r = rev();
      expect(() =>
        computeTerms(r, quality(10000), { network: "mainnet", gracePeriodSeconds: 1.5 }),
      ).toThrow(/gracePeriodSeconds/);
    });

    it("rejects a mainnet hardCeilingMicroUsd override above $25", () => {
      const r = rev({ revenueMicroUsd: { d1: 1_000_000n, d7: 7_000_000n, d30: 30_000_000n } });
      expect(() =>
        computeTerms(r, quality(10000), { network: "mainnet", hardCeilingMicroUsd: 25_000_001n }),
      ).toThrow(/hardCeilingMicroUsd/);
    });

    it("allows a demo-network hardCeilingMicroUsd above $25 (the $25 cap only binds mainnet)", () => {
      const r = rev({ revenueMicroUsd: { d1: 1_000_000n, d7: 7_000_000n, d30: 30_000_000n } });
      const terms = computeTerms(r, quality(10000), {
        network: "demo",
        hardCeilingMicroUsd: 1_000_000_000n,
      });
      expect(terms.capMicroUsd).toBe(45_000_000n); // rawCap, well under the raised demo ceiling
    });
  });
});

function loadFixture<T>(slug: string, file: "bankr" | "chain"): T {
  const path = resolve(import.meta.dirname, `fixtures/${slug}/${file}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

describe("computeTerms (real fixture: Ratspeak)", () => {
  const RATSPEAK_TOKEN: Address = "0xf1e9Baa65d418A9025e1851DD2D37f1AD208bba3";

  it("decay compresses the 90d projection well below a naive 3x-of-30d extrapolation, and the full pipeline approves at the mainnet $25 ceiling", async () => {
    const bankr = loadFixture<BankrTokenFeesResponse>("ratspeak", "bankr");
    const chain = loadFixture<ChainFixture>("ratspeak", "chain");
    const entry = pickBankrToken(bankr, RATSPEAK_TOKEN);
    const reader = createFixtureChainReader(chain);

    const revenue = await computeRevenue(reader, {
      token: RATSPEAK_TOKEN,
      feesManager: entry.initializer,
      poolId: entry.poolId,
      creator: bankr.address as Address,
      weth: BASE_WETH,
      ethUsdFeed: BASE_ETH_USD_CHAINLINK_FEED,
    });

    // Fully deterministic given the committed fixture.
    expect(revenue.revenueWei).toEqual({
      d1: 11_931_936_589_348_719n,
      d7: 583_849_023_052_822_456n,
      d30: 14_468_115_337_626_052_181n,
    });
    expect(revenue.revenueMicroUsd).toEqual({
      d1: 28_893_841n,
      d7: 1_413_822_537n,
      d30: 35_035_337_432n,
    });
    expect(revenue.ageSeconds).toBe(10_477_732n); // ~121 days old, well past every age haircut/deny
    expect(revenue.creatorSharesWad).toBe(950_000_000_000_000_000n);
    // The 7 on-chain daily buckets (8 daily block anchors + fee accrual, oldest..newest) —
    // never Bankr's off-chain `dailyEarnings`, which is stale/all-zero for this same window.
    expect(revenue.dailyRevenueWei).toEqual([
      126_795_503_541_175_762n,
      104_193_366_991_476_437n,
      73_693_730_016_186_280n,
      101_199_905_953_614_294n,
      67_115_734_350_120_192n,
      98_918_845_610_900_768n,
      11_931_936_589_348_719n,
    ]);

    const latest = await reader.getLatestBlock();
    const fromBlock = await reader.blockAt(latest.timestamp - 7n * DAY);
    const swaps = await reader.getSwaps({
      poolManager: BASE_V4_POOL_MANAGER,
      poolId: entry.poolId,
      fromBlock,
      toBlock: latest.number,
      cap: 400,
    });

    const quality = computeQuality(swaps, {
      creator: bankr.address as Address,
      ageSeconds: revenue.ageSeconds,
      recentDailyRevenue: revenue.dailyRevenueWei,
    });
    expect(quality.swapCount).toBe(400);
    expect(quality.top5ConcentrationRatio).toBeCloseTo(0.195);
    expect(quality.washRatio).toBe(0);
    // The real on-chain daily buckets show moderate (not extreme) day-to-day variability.
    expect(quality.cv).toBeCloseTo(0.4138459601541224, 10);
    expect(quality.haircutBps).toBe(10000); // no haircut triggers for this real sample

    const terms = computeTerms(revenue, quality, { network: "mainnet" });

    // Decay-aware: the 90d projection is far smaller than naively extrapolating the 30d
    // window flat across 90 days (3x) — decay is doing real work even though the pool is
    // healthy and un-haircut.
    expect(terms.projected90dMicroUsd).toBe(1_569_592_749n);
    expect(terms.projected90dMicroUsd).toBeLessThan(3n * revenue.revenueMicroUsd.d30);

    // Ratspeak's real revenue is high enough that the mainnet $25 pilot ceiling — not the
    // decay-shrunk projection — ends up the binding constraint, same as the steady-revenue
    // worked example above.
    expect(terms.capMicroUsd).toBe(25_000_000n);
    expect(terms.noteSupply).toBe(25_000_000_000_000_000_000n);
    expect(terms.floorCents).toBe(80);
    expect(terms.minPrincipal).toBe(10_000_000n);
    expect(terms.drawLimit).toBe(714_285n);
    expect(terms.auctionBlocks).toBe(1000n);
    expect(termsDenyReasons(terms)).toEqual([]);

    const reasons = await applyRules(
      { poolId: entry.poolId, poolFound: true, isWethPool: true },
      revenue,
      quality,
    );
    expect(reasons).toEqual([]); // approved
  });
});
