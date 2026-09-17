import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import type {
  ChainReader,
  CreatorRevenueWindow,
  EthUsdPrice,
  FeeAccrual,
  PoolKeyInfo,
} from "../src/sources/chain.js";
import { checkIsWethPool, computeRevenue } from "../src/underwrite/revenue.js";

const WETH: Address = "0x4200000000000000000000000000000000000006";
const OTHER: Address = "0x1111111111111111111111111111111111111111";
const FEES_MANAGER: Address = "0x2222222222222222222222222222222222222222";
const POOL_ID: Hex =
  "0x3333333333333333333333333333333333333333333333333333333333333333".slice(0, 66) as Hex;
const CREATOR: Address = "0x4444444444444444444444444444444444444444";
const TOKEN: Address = "0x5555555555555555555555555555555555555555";
const ETH_USD_FEED: Address = "0x6666666666666666666666666666666666666666";
const DAY = 86_400n;

const LATEST_TIMESTAMP = 900_000_000n;
const LATEST_BLOCK = LATEST_TIMESTAMP; // synthetic 1:1 timestamp<->block mapping

/** total0 (WETH, since currency0=WETH) at each of the 8 daily anchors, most-recent (now)
 * first: [now, -1d, -2d, -3d, -4d, -5d, -6d, -7d]. Monotonically non-decreasing further
 * back in time, as real fee accrual must be. */
const ANCHOR_TOTALS = [1_000_000n, 900_000n, 850_000n, 700_000n, 650_000n, 500_000n, 300_000n, 100_000n];
const SHARES_WAD = 500_000_000_000_000_000n; // 0.5e18

function notImplemented(name: string) {
  return () => {
    throw new Error(`fake ChainReader: "${name}" not implemented for this test`);
  };
}

interface FakeReaderOverrides {
  ethUsdPrice?: EthUsdPrice;
  anchorTotals?: bigint[];
  blockAtOverride?: (timestamp: bigint) => bigint;
  getFeeAccrualOverride?: (block: bigint) => Promise<FeeAccrual>;
}

function fakeReader(overrides: FakeReaderOverrides = {}): ChainReader {
  const anchorTotals = overrides.anchorTotals ?? ANCHOR_TOTALS;
  const poolKey: PoolKeyInfo = { currency0: WETH, currency1: OTHER, fee: 0, tickSpacing: 0, hooks: OTHER };

  const window: CreatorRevenueWindow = {
    wethIndex: 0,
    fromBlock: 1n,
    toBlock: LATEST_BLOCK,
    fromTimestamp: 0n,
    toTimestamp: LATEST_TIMESTAMP,
    accruedFromWeth: 0n,
    accruedToWeth: 1_000_000n,
    poolDeltaWeth: 1_000_000n,
    creatorSharesWad: SHARES_WAD,
    creatorRevenueWeth: 500_000n,
  };

  const ethUsdPrice: EthUsdPrice =
    overrides.ethUsdPrice ??
    {
      roundId: 1n,
      answer: 400_000_000_000n, // $4000, 8 decimals
      decimals: 8,
      startedAt: LATEST_TIMESTAMP - 100n,
      updatedAt: LATEST_TIMESTAMP - 100n,
      answeredInRound: 1n,
      block: LATEST_BLOCK,
    };

  return {
    getPoolKey: async () => poolKey,
    getShares: async () => SHARES_WAD,
    getWethIndex: (key, weth) => {
      const target = weth.toLowerCase();
      if (key.currency0.toLowerCase() === target) return 0;
      if (key.currency1.toLowerCase() === target) return 1;
      throw new Error(`pool does not contain WETH (${weth})`);
    },
    getFeeAccrual:
      overrides.getFeeAccrualOverride !== undefined
        ? (_fm, _pid, block) => overrides.getFeeAccrualOverride!(block)
        : async (_fm, _pid, block) => {
            const idx = Number(LATEST_BLOCK - block) / Number(DAY);
            const total0 = anchorTotals[idx];
            if (total0 === undefined) {
              throw new Error(`fake ChainReader: no fee accrual stubbed for block ${block}`);
            }
            return { block, cumulated0: total0, cumulated1: 0n, uncollected0: 0n, uncollected1: 0n, total0, total1: 0n };
          },
    getLatestBlock: async () => ({ number: LATEST_BLOCK, timestamp: LATEST_TIMESTAMP }),
    getBlockTimestamp: async (block) => block, // synthetic 1:1 mapping
    blockAt: overrides.blockAtOverride
      ? async (ts) => overrides.blockAtOverride!(ts)
      : async (ts) => ts, // synthetic 1:1 mapping
    tokenCreatedAt: async () => ({ block: 1n, timestamp: 0 }),
    getCreatorRevenueWindow: async () => window,
    getSwaps: notImplemented("getSwaps"),
    getEthUsdPrice: async () => ethUsdPrice,
    getAssetState: notImplemented("getAssetState"),
    getChainId: notImplemented("getChainId"),
    getLockBeneficiaries: notImplemented("getLockBeneficiaries"),
    getAirlockAssetData: notImplemented("getAirlockAssetData"),
  };
}

const baseCtx = {
  token: TOKEN,
  feesManager: FEES_MANAGER,
  poolId: POOL_ID,
  creator: CREATOR,
  weth: WETH,
  ethUsdFeed: ETH_USD_FEED,
  atBlock: LATEST_BLOCK,
};

describe("computeRevenue: on-chain daily buckets", () => {
  it("derives 7 buckets from 8 daily anchors, oldest-first/most-recent-last, scaled by creator shares", async () => {
    const reader = fakeReader();
    const rev = await computeRevenue(reader, baseCtx);
    // pool-wide deltas newest-first: [100k,50k,150k,50k,150k,200k,200k] * 0.5 shares,
    // then reversed to oldest-first/most-recent-last.
    expect(rev.dailyRevenueWei).toEqual([
      100_000n, 100_000n, 75_000n, 25_000n, 75_000n, 25_000n, 50_000n,
    ]);
  });

  it("throws if a bucket's accrual delta is negative (fee accrual must be non-decreasing)", async () => {
    const reader = fakeReader({ anchorTotals: [900_000n, 1_000_000n, 850_000n, 700_000n, 650_000n, 500_000n, 300_000n, 100_000n] });
    await expect(computeRevenue(reader, baseCtx)).rejects.toThrow(/negative accrual delta/);
  });

  it("propagates a reader failure while resolving a bucket anchor (never returns a partial bucket set)", async () => {
    const reader = fakeReader({
      getFeeAccrualOverride: async () => {
        throw new Error("simulated RPC failure");
      },
    });
    await expect(computeRevenue(reader, baseCtx)).rejects.toThrow(/simulated RPC failure/);
  });
});

describe("computeRevenue: ETH/USD price validation", () => {
  it("throws if the answer is non-positive", async () => {
    const reader = fakeReader({
      ethUsdPrice: {
        roundId: 1n,
        answer: 0n,
        decimals: 8,
        startedAt: LATEST_TIMESTAMP,
        updatedAt: LATEST_TIMESTAMP,
        answeredInRound: 1n,
        block: LATEST_BLOCK,
      },
    });
    await expect(computeRevenue(reader, baseCtx)).rejects.toThrow(/non-positive/);
  });

  it("throws if decimals isn't 8", async () => {
    const reader = fakeReader({
      ethUsdPrice: {
        roundId: 1n,
        answer: 400_000n,
        decimals: 6,
        startedAt: LATEST_TIMESTAMP,
        updatedAt: LATEST_TIMESTAMP,
        answeredInRound: 1n,
        block: LATEST_BLOCK,
      },
    });
    await expect(computeRevenue(reader, baseCtx)).rejects.toThrow(/decimals/);
  });

  it("throws if the price is more than 3600s stale relative to the read block", async () => {
    const reader = fakeReader({
      ethUsdPrice: {
        roundId: 1n,
        answer: 400_000_000_000n,
        decimals: 8,
        startedAt: LATEST_TIMESTAMP - 3601n,
        updatedAt: LATEST_TIMESTAMP - 3601n,
        answeredInRound: 1n,
        block: LATEST_BLOCK,
      },
    });
    await expect(computeRevenue(reader, baseCtx)).rejects.toThrow(/stale/);
  });

  it("does not throw at exactly 3600s (the boundary is inclusive)", async () => {
    const reader = fakeReader({
      ethUsdPrice: {
        roundId: 1n,
        answer: 400_000_000_000n,
        decimals: 8,
        startedAt: LATEST_TIMESTAMP - 3600n,
        updatedAt: LATEST_TIMESTAMP - 3600n,
        answeredInRound: 1n,
        block: LATEST_BLOCK,
      },
    });
    await expect(computeRevenue(reader, baseCtx)).resolves.toBeDefined();
  });

  it("does not throw for a fresh, valid price", async () => {
    const reader = fakeReader();
    await expect(computeRevenue(reader, baseCtx)).resolves.toBeDefined();
  });
});

describe("checkIsWethPool", () => {
  it("true when WETH is currency0", async () => {
    const reader = fakeReader();
    await expect(checkIsWethPool(reader, FEES_MANAGER, POOL_ID, WETH)).resolves.toBe(true);
  });

  it("false when WETH is neither currency (never throws, unlike getWethIndex)", async () => {
    const reader: ChainReader = {
      ...fakeReader(),
      getPoolKey: async () => ({ currency0: OTHER, currency1: OTHER, fee: 0, tickSpacing: 0, hooks: OTHER }),
    };
    await expect(checkIsWethPool(reader, FEES_MANAGER, POOL_ID, WETH)).resolves.toBe(false);
  });
});
