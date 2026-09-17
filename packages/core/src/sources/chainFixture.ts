import type { Address, Hex } from "viem";
import type { ChainOps, RawSwapLog } from "./chainOps.js";

/** JSON-safe encoding of `RawSwapLog` (bigints as decimal strings). */
export interface RawSwapLogJson {
  sender: Address;
  amount0: string;
  amount1: string;
  sqrtPriceX96: string;
  liquidity: string;
  tick: number;
  fee: number;
  blockNumber: string;
  transactionHash: Hex;
  logIndex: number;
}

/**
 * Deterministic recording of every raw call `ChainOps` made while producing a fixture,
 * keyed so replay is exact. Committed under `test/fixtures/<slug>/chain.json`.
 */
export interface ChainFixture {
  token: Address;
  chainId: number;
  recordedAt: string;
  calls: {
    /** blockNumber (decimal string) -> timestamp (decimal string) */
    blocks: Record<string, string>;
    /** `${feesManager}:${poolId}` -> [currency0, currency1, fee, tickSpacing, hooks] */
    poolKeys: Record<string, [Address, Address, number, number, Address]>;
    /** `${feesManager}:${poolId}:${beneficiary}` -> shares (decimal string) */
    shares: Record<string, string>;
    /** `${feesManager}:${poolId}:${index}:${block}` -> cumulated fees (decimal string) */
    cumulatedFees: Record<string, string>;
    /** `${feesManager}:${poolId}:${block}` -> [fees0, fees1] (decimal strings) */
    uncollectedFees: Record<string, [string, string]>;
    /** `${poolManager}:${poolId}:${fromBlock}-${toBlock}` -> raw swap logs in that chunk */
    swapLogs: Record<string, RawSwapLogJson[]>;
    /** tx hash -> sender address */
    transactions: Record<string, Address>;
    /** `${feed}:${block}` -> [roundId, answer, startedAt, updatedAt, answeredInRound] (decimal strings) */
    roundData: Record<string, [string, string, string, string, string]>;
  };
}

/** Per-chunk trim applied when recording swap logs (see `createRecordingChainOps`). */
const RECORDING_SWAP_TRIM = 400;

export class FixtureMissError extends Error {
  constructor(kind: string, key: string) {
    super(
      `chain fixture: no recorded "${kind}" call for key "${key}" — ` +
        `re-run scripts/record-fixture.ts if this is a genuinely new call`,
    );
    this.name = "FixtureMissError";
  }
}

function emptyCalls(): ChainFixture["calls"] {
  return {
    blocks: {},
    poolKeys: {},
    shares: {},
    cumulatedFees: {},
    uncollectedFees: {},
    swapLogs: {},
    transactions: {},
    roundData: {},
  };
}

function swapLogKey(
  poolManager: Address,
  poolId: Hex,
  fromBlock: bigint,
  toBlock: bigint,
): string {
  return `${poolManager}:${poolId}:${fromBlock}-${toBlock}`;
}

function toRawSwapLog(json: RawSwapLogJson): RawSwapLog {
  return {
    sender: json.sender,
    amount0: BigInt(json.amount0),
    amount1: BigInt(json.amount1),
    sqrtPriceX96: BigInt(json.sqrtPriceX96),
    liquidity: BigInt(json.liquidity),
    tick: json.tick,
    fee: json.fee,
    blockNumber: BigInt(json.blockNumber),
    transactionHash: json.transactionHash,
    logIndex: json.logIndex,
  };
}

function toRawSwapLogJson(log: RawSwapLog): RawSwapLogJson {
  return {
    sender: log.sender,
    amount0: log.amount0.toString(),
    amount1: log.amount1.toString(),
    sqrtPriceX96: log.sqrtPriceX96.toString(),
    liquidity: log.liquidity.toString(),
    tick: log.tick,
    fee: log.fee,
    blockNumber: log.blockNumber.toString(),
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
  };
}

/** Fixture-backed `ChainOps`: never touches the network, throws loudly on any unrecorded call. */
export function createFixtureChainOps(fixture: ChainFixture): ChainOps {
  const { calls } = fixture;
  let latestBlockNumber: bigint | undefined;
  for (const key of Object.keys(calls.blocks)) {
    const n = BigInt(key);
    if (latestBlockNumber === undefined || n > latestBlockNumber) {
      latestBlockNumber = n;
    }
  }

  return {
    async getBlockNumber() {
      if (latestBlockNumber === undefined) {
        throw new FixtureMissError("getBlockNumber", "(no recorded blocks)");
      }
      return latestBlockNumber;
    },

    async getBlockTimestamp(block) {
      const key = block.toString();
      const ts = calls.blocks[key];
      if (ts === undefined) throw new FixtureMissError("getBlockTimestamp", key);
      return BigInt(ts);
    },

    async getPoolKeyRaw(feesManager, poolId) {
      const key = `${feesManager}:${poolId}`;
      const entry = calls.poolKeys[key];
      if (!entry) throw new FixtureMissError("getPoolKeyRaw", key);
      return entry;
    },

    async getShares(feesManager, poolId, beneficiary) {
      const key = `${feesManager}:${poolId}:${beneficiary}`;
      const entry = calls.shares[key];
      if (entry === undefined) throw new FixtureMissError("getShares", key);
      return BigInt(entry);
    },

    async getCumulatedFees(feesManager, poolId, index, block) {
      const key = `${feesManager}:${poolId}:${index}:${block}`;
      const entry = calls.cumulatedFees[key];
      if (entry === undefined) throw new FixtureMissError("getCumulatedFees", key);
      return BigInt(entry);
    },

    async getUncollectedFees(feesManager, poolId, block) {
      const key = `${feesManager}:${poolId}:${block}`;
      const entry = calls.uncollectedFees[key];
      if (!entry) throw new FixtureMissError("getUncollectedFees", key);
      return [BigInt(entry[0]), BigInt(entry[1])];
    },

    async getSwapLogs(poolManager, poolId, fromBlock, toBlock) {
      const key = swapLogKey(poolManager, poolId, fromBlock, toBlock);
      const entry = calls.swapLogs[key];
      if (!entry) throw new FixtureMissError("getSwapLogs", key);
      return entry.map(toRawSwapLog);
    },

    async getTransactionSender(hash) {
      const entry = calls.transactions[hash];
      if (!entry) throw new FixtureMissError("getTransactionSender", hash);
      return entry;
    },

    async getLatestRoundData(feed, block) {
      const key = `${feed}:${block}`;
      const entry = calls.roundData[key];
      if (!entry) throw new FixtureMissError("getLatestRoundData", key);
      return [
        BigInt(entry[0]),
        BigInt(entry[1]),
        BigInt(entry[2]),
        BigInt(entry[3]),
        BigInt(entry[4]),
      ];
    },
  };
}

/** Wraps a live `ChainOps`, recording every call so it can be dumped into a `ChainFixture`. */
export function createRecordingChainOps(
  live: ChainOps,
  meta: { token: Address; chainId: number },
): { ops: ChainOps; dump(): ChainFixture } {
  const calls = emptyCalls();

  const ops: ChainOps = {
    async getBlockNumber() {
      const n = await live.getBlockNumber();
      // Ensure the latest block's timestamp is also recorded, so fixture replay knows it.
      const ts = await live.getBlockTimestamp(n);
      calls.blocks[n.toString()] = ts.toString();
      return n;
    },

    async getBlockTimestamp(block) {
      const ts = await live.getBlockTimestamp(block);
      calls.blocks[block.toString()] = ts.toString();
      return ts;
    },

    async getPoolKeyRaw(feesManager, poolId) {
      const result = await live.getPoolKeyRaw(feesManager, poolId);
      calls.poolKeys[`${feesManager}:${poolId}`] = result;
      return result;
    },

    async getShares(feesManager, poolId, beneficiary) {
      const result = await live.getShares(feesManager, poolId, beneficiary);
      calls.shares[`${feesManager}:${poolId}:${beneficiary}`] =
        result.toString();
      return result;
    },

    async getCumulatedFees(feesManager, poolId, index, block) {
      const result = await live.getCumulatedFees(
        feesManager,
        poolId,
        index,
        block,
      );
      calls.cumulatedFees[`${feesManager}:${poolId}:${index}:${block}`] =
        result.toString();
      return result;
    },

    async getUncollectedFees(feesManager, poolId, block) {
      const result = await live.getUncollectedFees(feesManager, poolId, block);
      calls.uncollectedFees[`${feesManager}:${poolId}:${block}`] = [
        result[0].toString(),
        result[1].toString(),
      ];
      return result;
    },

    async getSwapLogs(poolManager, poolId, fromBlock, toBlock) {
      const result = await live.getSwapLogs(
        poolManager,
        poolId,
        fromBlock,
        toBlock,
      );
      // The business logic only ever keeps the most-recent `cap` (default 400) swaps
      // across the whole query range. Recording every raw log in every 10k-block chunk
      // can blow fixtures up to hundreds of KB for busy pools; trimming each chunk to its
      // own most-recent `RECORDING_SWAP_TRIM` entries before persisting is safe because an
      // entry that doesn't even make the top of its own chunk can never make the global
      // top-`cap` once merged with other (typically more recent) chunks.
      const trimmed = [...result]
        .sort((a, b) => {
          if (a.blockNumber !== b.blockNumber) {
            return a.blockNumber < b.blockNumber ? 1 : -1;
          }
          return b.logIndex - a.logIndex;
        })
        .slice(0, RECORDING_SWAP_TRIM);
      calls.swapLogs[swapLogKey(poolManager, poolId, fromBlock, toBlock)] =
        trimmed.map(toRawSwapLogJson);
      return result;
    },

    async getTransactionSender(hash) {
      const result = await live.getTransactionSender(hash);
      calls.transactions[hash] = result;
      return result;
    },

    async getLatestRoundData(feed, block) {
      const result = await live.getLatestRoundData(feed, block);
      calls.roundData[`${feed}:${block}`] = [
        result[0].toString(),
        result[1].toString(),
        result[2].toString(),
        result[3].toString(),
        result[4].toString(),
      ];
      return result;
    },
  };

  return {
    ops,
    dump(): ChainFixture {
      return {
        token: meta.token,
        chainId: meta.chainId,
        recordedAt: new Date().toISOString(),
        calls,
      };
    },
  };
}
