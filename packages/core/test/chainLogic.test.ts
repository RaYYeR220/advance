import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { ChainOps, RawSwapLog } from "../src/sources/chainOps.js";
import {
  buildChainReader,
  isPoolEligibleForEscrow,
  BlockAtBeforeGenesisError,
} from "../src/sources/chainLogic.js";

const POOL_MANAGER: Address = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
const POOL_ID: Hex =
  "0x5e9782079683037fc8bb57625683359d9efaef80f2b829c4bb5b1896c6bb40b6";
const SENDER: Address = "0x1111111111111111111111111111111111111111";

function notImplemented(name: string) {
  return (...args: unknown[]) => {
    throw new Error(
      `fake ChainOps: "${name}" not implemented for this test (args=${JSON.stringify(
        args,
        (_key, v) => (typeof v === "bigint" ? v.toString() : v),
      )})`,
    );
  };
}

function fakeOps(overrides: Partial<ChainOps>): ChainOps {
  return {
    getBlockNumber: (overrides.getBlockNumber ??
      notImplemented("getBlockNumber")) as ChainOps["getBlockNumber"],
    getBlockTimestamp: (overrides.getBlockTimestamp ??
      notImplemented("getBlockTimestamp")) as ChainOps["getBlockTimestamp"],
    getCode: (overrides.getCode ??
      notImplemented("getCode")) as ChainOps["getCode"],
    getPoolKeyRaw: (overrides.getPoolKeyRaw ??
      notImplemented("getPoolKeyRaw")) as ChainOps["getPoolKeyRaw"],
    getShares: (overrides.getShares ??
      notImplemented("getShares")) as ChainOps["getShares"],
    getCumulatedFees: (overrides.getCumulatedFees ??
      notImplemented("getCumulatedFees")) as ChainOps["getCumulatedFees"],
    getUncollectedFees: (overrides.getUncollectedFees ??
      notImplemented("getUncollectedFees")) as ChainOps["getUncollectedFees"],
    getSwapLogs: (overrides.getSwapLogs ??
      notImplemented("getSwapLogs")) as ChainOps["getSwapLogs"],
    getTransactionSender: (overrides.getTransactionSender ??
      notImplemented(
        "getTransactionSender",
      )) as ChainOps["getTransactionSender"],
    getLatestRoundData: (overrides.getLatestRoundData ??
      notImplemented("getLatestRoundData")) as ChainOps["getLatestRoundData"],
    getFeedDecimals: (overrides.getFeedDecimals ??
      notImplemented("getFeedDecimals")) as ChainOps["getFeedDecimals"],
    getPoolStatusRaw: (overrides.getPoolStatusRaw ??
      notImplemented("getPoolStatusRaw")) as ChainOps["getPoolStatusRaw"],
    getDopplerHookFlags: (overrides.getDopplerHookFlags ??
      notImplemented("getDopplerHookFlags")) as ChainOps["getDopplerHookFlags"],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("getSwaps: batched tx.from resolution", () => {
  it("issues getTransactionSender calls concurrently, bounded, not one at a time", async () => {
    const SWAP_COUNT = 30;
    const swaps: RawSwapLog[] = Array.from({ length: SWAP_COUNT }, (_, i) => ({
      sender: SENDER,
      amount0: 1n,
      amount1: -1n,
      sqrtPriceX96: 1n,
      liquidity: 1n,
      tick: 0,
      fee: 0,
      blockNumber: 100n,
      transactionHash: `0x${i.toString(16).padStart(64, "0")}` as Hex,
      logIndex: i,
    }));

    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;

    const ops = fakeOps({
      async getSwapLogs() {
        return swaps;
      },
      async getTransactionSender(hash) {
        calls++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(5);
        inFlight--;
        return `0x${hash.slice(2, 42)}` as Address;
      },
    });

    const reader = buildChainReader(ops);
    const start = performance.now();
    const result = await reader.getSwaps({
      poolManager: POOL_MANAGER,
      poolId: POOL_ID,
      fromBlock: 100n,
      toBlock: 100n,
      cap: 400,
    });
    const elapsedMs = performance.now() - start;

    expect(result).toHaveLength(SWAP_COUNT);
    expect(calls).toBe(SWAP_COUNT); // one lookup per unique tx hash, no duplicates
    // Sequential would take >= 30*5=150ms; batched (2 rounds of <=20) takes ~10-20ms.
    expect(elapsedMs).toBeLessThan(100);
    // Concurrency must actually overlap (not sequential: maxInFlight would be 1) and be
    // bounded (not unbounded: capped at the batch size).
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(20);
    expect(maxInFlight).toBe(20); // first of two rounds (30 hashes, batch size 20) saturates it
  });
});

describe("getEthUsdPrice: decimals read from the feed", () => {
  const FEED: Address = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";

  it("reports the feed's real decimals(), not a hardcoded 8", async () => {
    const ops = fakeOps({
      async getLatestRoundData() {
        return [1n, 400_000_000_000n, 1_000n, 1_000n, 1n];
      },
      async getFeedDecimals() {
        return 6; // deliberately not 8, to prove this isn't a hardcoded constant
      },
    });
    const reader = buildChainReader(ops);
    const price = await reader.getEthUsdPrice(FEED, 100n);
    expect(price.decimals).toBe(6);
  });

  it("still reports 8 for a feed that genuinely answers 8 (the real, common case)", async () => {
    const ops = fakeOps({
      async getLatestRoundData() {
        return [1n, 400_000_000_000n, 1_000n, 1_000n, 1n];
      },
      async getFeedDecimals() {
        return 8;
      },
    });
    const reader = buildChainReader(ops);
    const price = await reader.getEthUsdPrice(FEED, 100n);
    expect(price.decimals).toBe(8);
  });
});

describe("blockAt: genesis boundary", () => {
  // Deterministic synthetic chain: block N has timestamp 1000 + 2*N, latest is block 100.
  function timestampOf(block: bigint): bigint {
    return 1000n + 2n * block;
  }

  function makeOps() {
    return fakeOps({
      async getBlockNumber() {
        return 100n;
      },
      async getBlockTimestamp(block) {
        return timestampOf(block);
      },
    });
  }

  it("throws BlockAtBeforeGenesisError for a timestamp before block 1's own timestamp", async () => {
    const reader = buildChainReader(makeOps());
    const genesisTs = timestampOf(1n); // 1002
    await expect(reader.blockAt(genesisTs - 1n)).rejects.toThrow(
      BlockAtBeforeGenesisError,
    );
  });

  it("does not throw and returns block 1 for a timestamp exactly at genesis", async () => {
    const reader = buildChainReader(makeOps());
    const genesisTs = timestampOf(1n);
    await expect(reader.blockAt(genesisTs)).resolves.toBe(1n);
  });

  it("resolves normally for a timestamp well after genesis", async () => {
    const reader = buildChainReader(makeOps());
    await expect(reader.blockAt(timestampOf(50n))).resolves.toBe(50n);
  });
});

describe("getPoolStatus / isPoolEligibleForEscrow", () => {
  const FEES_MANAGER: Address = "0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544";
  const ASSET: Address = "0x1111111111111111111111111111111111111111";
  const HOOK: Address = "0x2222222222222222222222222222222222222222";
  const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

  it("Locked status, no hook -> eligible", async () => {
    const ops = fakeOps({
      async getPoolStatusRaw() {
        return [2, ZERO_ADDRESS];
      },
      getDopplerHookFlags: notImplemented(
        "getDopplerHookFlags",
      ) as ChainOps["getDopplerHookFlags"], // never called: no hook set
    });
    const reader = buildChainReader(ops);
    const info = await reader.getPoolStatus(FEES_MANAGER, ASSET);
    expect(info.status).toBe(2);
    expect(info.hookAllowsGraduation).toBe(false);
    expect(isPoolEligibleForEscrow(info)).toBe(true);
  });

  it("Locked status, hook set but ON_GRADUATION_FLAG not set -> eligible", async () => {
    const ops = fakeOps({
      async getPoolStatusRaw() {
        return [2, HOOK];
      },
      async getDopplerHookFlags() {
        return 3n; // ON_INITIALIZATION_FLAG | ON_SWAP_FLAG, no graduation bit
      },
    });
    const reader = buildChainReader(ops);
    const info = await reader.getPoolStatus(FEES_MANAGER, ASSET);
    expect(info.hookAllowsGraduation).toBe(false);
    expect(isPoolEligibleForEscrow(info)).toBe(true);
  });

  it("Locked status, hook with ON_GRADUATION_FLAG set -> not eligible (pool_not_locked)", async () => {
    const ops = fakeOps({
      async getPoolStatusRaw() {
        return [2, HOOK];
      },
      async getDopplerHookFlags() {
        return 7n; // includes ON_GRADUATION_FLAG (1<<2)
      },
    });
    const reader = buildChainReader(ops);
    const info = await reader.getPoolStatus(FEES_MANAGER, ASSET);
    expect(info.hookAllowsGraduation).toBe(true);
    expect(isPoolEligibleForEscrow(info)).toBe(false);
  });

  it("non-Locked status (e.g. Graduated) -> not eligible even with no hook", async () => {
    const ops = fakeOps({
      async getPoolStatusRaw() {
        return [3, ZERO_ADDRESS]; // Graduated
      },
      getDopplerHookFlags: notImplemented(
        "getDopplerHookFlags",
      ) as ChainOps["getDopplerHookFlags"],
    });
    const reader = buildChainReader(ops);
    const info = await reader.getPoolStatus(FEES_MANAGER, ASSET);
    expect(isPoolEligibleForEscrow(info)).toBe(false);
  });
});

describe("tokenCreatedAt", () => {
  const TOKEN: Address = "0x2222222222222222222222222222222222222222";
  const CREATION_BLOCK = 37n;
  const LATEST_BLOCK = 100n;

  function makeOps() {
    let getCodeCalls = 0;
    const ops = fakeOps({
      async getBlockNumber() {
        return LATEST_BLOCK;
      },
      async getBlockTimestamp(block) {
        return 1_000_000n + block;
      },
      async getCode(_address, block) {
        getCodeCalls++;
        return block >= CREATION_BLOCK ? "0xabcdef" : "0x";
      },
    });
    return { ops, getCallCount: () => getCodeCalls };
  }

  it("binary-searches to the first block with non-empty code", async () => {
    const { ops } = makeOps();
    const reader = buildChainReader(ops);
    const created = await reader.tokenCreatedAt(TOKEN);
    expect(created.block).toBe(CREATION_BLOCK);
    expect(created.timestamp).toBe(Number(1_000_000n + CREATION_BLOCK));
  });

  it("uses O(log latest) getCode calls, not a linear scan", async () => {
    const { ops, getCallCount } = makeOps();
    const reader = buildChainReader(ops);
    await reader.tokenCreatedAt(TOKEN);
    // latest block is a param; log2(100) ~= 7, plus the initial "has code at latest" probe.
    expect(getCallCount()).toBeLessThan(15);
  });

  it("caches: a second call for the same token makes no further getCode calls", async () => {
    const { ops, getCallCount } = makeOps();
    const reader = buildChainReader(ops);
    await reader.tokenCreatedAt(TOKEN);
    const callsAfterFirst = getCallCount();
    await reader.tokenCreatedAt(TOKEN);
    expect(getCallCount()).toBe(callsAfterFirst);
  });

  it("throws if the token has no code even at the latest block", async () => {
    const ops = fakeOps({
      async getBlockNumber() {
        return LATEST_BLOCK;
      },
      async getBlockTimestamp(block) {
        return 1_000_000n + block;
      },
      async getCode() {
        return "0x";
      },
    });
    const reader = buildChainReader(ops);
    await expect(reader.tokenCreatedAt(TOKEN)).rejects.toThrow(/no code/);
  });
});
