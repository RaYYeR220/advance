import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { ChainOps, RawSwapLog } from "../src/sources/chainOps.js";
import {
  createFixtureChainOps,
  createRecordingChainOps,
  FixtureMissError,
} from "../src/sources/chainFixture.js";

const POOL_MANAGER: Address = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
const POOL_ID: Hex =
  "0x5e9782079683037fc8bb57625683359d9efaef80f2b829c4bb5b1896c6bb40b6";
const TOKEN: Address = "0xf1e9Baa65d418A9025e1851DD2D37f1AD208bba3";

function notImplemented(name: string) {
  return (...args: unknown[]) => {
    throw new Error(`fake live ChainOps: "${name}" not implemented (args=${JSON.stringify(args)})`);
  };
}

/** A tiny fake "live" ChainOps whose getSwapLogs always returns the same 3 raw logs. */
function makeFakeLiveOps(): ChainOps {
  const logs: RawSwapLog[] = [0, 1, 2].map((i) => ({
    sender: "0x1111111111111111111111111111111111111111",
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
  return {
    getBlockNumber: notImplemented("getBlockNumber") as ChainOps["getBlockNumber"],
    getBlockTimestamp: notImplemented(
      "getBlockTimestamp",
    ) as ChainOps["getBlockTimestamp"],
    getCode: notImplemented("getCode") as ChainOps["getCode"],
    getPoolKeyRaw: notImplemented("getPoolKeyRaw") as ChainOps["getPoolKeyRaw"],
    getShares: notImplemented("getShares") as ChainOps["getShares"],
    getCumulatedFees: notImplemented(
      "getCumulatedFees",
    ) as ChainOps["getCumulatedFees"],
    getUncollectedFees: notImplemented(
      "getUncollectedFees",
    ) as ChainOps["getUncollectedFees"],
    async getSwapLogs() {
      return logs;
    },
    getTransactionSender: notImplemented(
      "getTransactionSender",
    ) as ChainOps["getTransactionSender"],
    getLatestRoundData: notImplemented(
      "getLatestRoundData",
    ) as ChainOps["getLatestRoundData"],
  };
}

describe("fixture swap-log recording/replay: cap is part of the key", () => {
  it("recording with cap=A then replaying with the same cap=A returns the recorded logs", async () => {
    const { ops: recordingOps, dump } = createRecordingChainOps(
      makeFakeLiveOps(),
      { token: TOKEN, chainId: 8453 },
    );
    await recordingOps.getSwapLogs(POOL_MANAGER, POOL_ID, 100n, 100n, 3);
    const fixture = dump();

    const replayOps = createFixtureChainOps(fixture);
    const replayed = await replayOps.getSwapLogs(
      POOL_MANAGER,
      POOL_ID,
      100n,
      100n,
      3,
    );
    expect(replayed).toHaveLength(3);
  });

  it("replaying the same block range with a different, unrecorded cap throws FixtureMissError instead of silently returning the cap=A recording", async () => {
    const { ops: recordingOps, dump } = createRecordingChainOps(
      makeFakeLiveOps(),
      { token: TOKEN, chainId: 8453 },
    );
    // Only cap=3 was ever recorded for this range.
    await recordingOps.getSwapLogs(POOL_MANAGER, POOL_ID, 100n, 100n, 3);
    const fixture = dump();

    const replayOps = createFixtureChainOps(fixture);
    await expect(
      replayOps.getSwapLogs(POOL_MANAGER, POOL_ID, 100n, 100n, 1000),
    ).rejects.toThrow(FixtureMissError);
  });
});
