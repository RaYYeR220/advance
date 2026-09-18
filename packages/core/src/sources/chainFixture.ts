import type { Address, Hex } from "viem";
import type {
  AirlockAssetData,
  AssetStateRaw,
  ChainOps,
  LockBeneficiary,
  RawSwapLog,
} from "./chainOps.js";

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

/** JSON-safe `AssetStateRaw` (numbers/addresses only — nothing to convert, kept as its own
 * type so a fixture-shape change here is caught even if `AssetStateRaw` doesn't move). */
export type AssetStateJson = AssetStateRaw;

/** JSON-safe `LockBeneficiary` (shares as a decimal string). */
export interface LockBeneficiaryJson {
  beneficiary: Address;
  shares: string;
}

/** JSON-safe `AirlockAssetData` (bigints as decimal strings). */
export interface AirlockAssetDataJson {
  numeraire: Address;
  timelock: Address;
  governance: Address;
  liquidityMigrator: Address;
  poolInitializer: Address;
  pool: Address;
  migrationPool: Address;
  numTokensToSell: string;
  totalSupply: string;
  integrator: Address;
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
    /** `${address}:${block}` -> `eth_getCode` result (`"0x"` = no contract yet) */
    codes: Record<string, string>;
    /** `${feesManager}:${poolId}` -> [currency0, currency1, fee, tickSpacing, hooks] */
    poolKeys: Record<string, [Address, Address, number, number, Address]>;
    /** `${feesManager}:${poolId}:${beneficiary}` -> shares (decimal string) */
    shares: Record<string, string>;
    /** `${feesManager}:${poolId}:${index}:${block}` -> cumulated fees (decimal string) */
    cumulatedFees: Record<string, string>;
    /** `${feesManager}:${poolId}:${block}` -> [fees0, fees1] (decimal strings) */
    uncollectedFees: Record<string, [string, string]>;
    /**
     * `${poolManager}:${poolId}:${fromBlock}-${toBlock}:cap=${cap}` -> raw swap logs in
     * that chunk, recorded (and trimmed) for that exact `cap`. `cap` is part of the key
     * so replaying the same block range with a different, unrecorded cap throws
     * `FixtureMissError` instead of silently reusing a possibly-truncated recording.
     */
    swapLogs: Record<string, RawSwapLogJson[]>;
    /** tx hash -> sender address */
    transactions: Record<string, Address>;
    /** `${feed}:${block}` -> [roundId, answer, startedAt, updatedAt, answeredInRound] (decimal strings) */
    roundData: Record<string, [string, string, string, string, string]>;
    /** `${feed}:${block}` -> the feed's `decimals()` (small uint8, plain number). */
    decimals: Record<string, number>;
    /** `${feesManager}:${asset}` -> status/dopplerHook/poolKey from `getState(asset)`. */
    assetState: Record<string, AssetStateJson>;
    /** `${feesManager}:${dopplerHook}` -> `isDopplerHookEnabled` flags (decimal string). */
    dopplerHookFlags: Record<string, string>;
    /** `${feesManager}:${asset}:${fromBlock}:${toBlock}` -> the `Lock` event's beneficiary
     * list in that chunk (usually just one chunk starting at the token's creation block —
     * see `LOCK_LOG_CHUNK_BLOCKS`). */
    lockBeneficiaries: Record<string, LockBeneficiaryJson[]>;
    /** `${airlock}:${asset}` -> `Airlock.getAssetData(asset)`. */
    airlockAssetData: Record<string, AirlockAssetDataJson>;
    /** `eth_chainId` — at most one recorded value per fixture. */
    chainId?: number;
  };
}

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
    codes: {},
    poolKeys: {},
    shares: {},
    cumulatedFees: {},
    uncollectedFees: {},
    swapLogs: {},
    transactions: {},
    roundData: {},
    decimals: {},
    assetState: {},
    dopplerHookFlags: {},
    lockBeneficiaries: {},
    airlockAssetData: {},
  };
}

/** Joins key parts and lowercases the whole thing, so every fixture lookup is
 * casing-independent regardless of how an address argument (or a past recording) was
 * cased — addresses aren't case-sensitive on-chain and fixture keys shouldn't be either. */
function key(...parts: Array<string | number | bigint>): string {
  return parts.map(String).join(":").toLowerCase();
}

function swapLogKey(
  poolManager: Address,
  poolId: Hex,
  fromBlock: bigint,
  toBlock: bigint,
  cap: number,
): string {
  return `${poolManager}:${poolId}:${fromBlock}-${toBlock}:cap=${cap}`.toLowerCase();
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

function toAirlockAssetDataJson(data: AirlockAssetData): AirlockAssetDataJson {
  return {
    numeraire: data.numeraire,
    timelock: data.timelock,
    governance: data.governance,
    liquidityMigrator: data.liquidityMigrator,
    poolInitializer: data.poolInitializer,
    pool: data.pool,
    migrationPool: data.migrationPool,
    numTokensToSell: data.numTokensToSell.toString(),
    totalSupply: data.totalSupply.toString(),
    integrator: data.integrator,
  };
}

function toAirlockAssetData(json: AirlockAssetDataJson): AirlockAssetData {
  return {
    numeraire: json.numeraire,
    timelock: json.timelock,
    governance: json.governance,
    liquidityMigrator: json.liquidityMigrator,
    poolInitializer: json.poolInitializer,
    pool: json.pool,
    migrationPool: json.migrationPool,
    numTokensToSell: BigInt(json.numTokensToSell),
    totalSupply: BigInt(json.totalSupply),
    integrator: json.integrator,
  };
}

/** Fixture-backed `ChainOps`: never touches the network, throws loudly on any unrecorded call. */
export function createFixtureChainOps(fixture: ChainFixture): ChainOps {
  const { calls } = fixture;
  let latestBlockNumber: bigint | undefined;
  for (const blockKey of Object.keys(calls.blocks)) {
    const n = BigInt(blockKey);
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
      const k = block.toString();
      const ts = calls.blocks[k];
      if (ts === undefined) throw new FixtureMissError("getBlockTimestamp", k);
      return BigInt(ts);
    },

    async getCode(address, block) {
      const k = key(address, block);
      const code = calls.codes[k];
      if (code === undefined) throw new FixtureMissError("getCode", k);
      return code as Hex;
    },

    async getPoolKeyRaw(feesManager, poolId) {
      const k = key(feesManager, poolId);
      const entry = calls.poolKeys[k];
      if (!entry) throw new FixtureMissError("getPoolKeyRaw", k);
      return entry;
    },

    async getShares(feesManager, poolId, beneficiary) {
      const k = key(feesManager, poolId, beneficiary);
      const entry = calls.shares[k];
      if (entry === undefined) throw new FixtureMissError("getShares", k);
      return BigInt(entry);
    },

    async getCumulatedFees(feesManager, poolId, index, block) {
      const k = key(feesManager, poolId, index, block);
      const entry = calls.cumulatedFees[k];
      if (entry === undefined) throw new FixtureMissError("getCumulatedFees", k);
      return BigInt(entry);
    },

    async getUncollectedFees(feesManager, poolId, block) {
      const k = key(feesManager, poolId, block);
      const entry = calls.uncollectedFees[k];
      if (!entry) throw new FixtureMissError("getUncollectedFees", k);
      return [BigInt(entry[0]), BigInt(entry[1])];
    },

    async getSwapLogs(poolManager, poolId, fromBlock, toBlock, cap) {
      const k = swapLogKey(poolManager, poolId, fromBlock, toBlock, cap);
      const entry = calls.swapLogs[k];
      if (!entry) throw new FixtureMissError("getSwapLogs", k);
      return entry.map(toRawSwapLog);
    },

    async getTransactionSender(hash) {
      const k = hash.toLowerCase();
      const entry = calls.transactions[k];
      if (!entry) throw new FixtureMissError("getTransactionSender", k);
      return entry;
    },

    async getLatestRoundData(feed, block) {
      const k = key(feed, block);
      const entry = calls.roundData[k];
      if (!entry) throw new FixtureMissError("getLatestRoundData", k);
      return [
        BigInt(entry[0]),
        BigInt(entry[1]),
        BigInt(entry[2]),
        BigInt(entry[3]),
        BigInt(entry[4]),
      ];
    },

    async getFeedDecimals(feed, block) {
      const k = key(feed, block);
      const entry = calls.decimals[k];
      if (entry === undefined) throw new FixtureMissError("getFeedDecimals", k);
      return entry;
    },

    async getAssetStateRaw(feesManager, asset) {
      const k = key(feesManager, asset);
      const entry = calls.assetState[k];
      if (!entry) throw new FixtureMissError("getAssetStateRaw", k);
      return entry;
    },

    async getDopplerHookFlags(feesManager, dopplerHook) {
      const k = key(feesManager, dopplerHook);
      const entry = calls.dopplerHookFlags[k];
      if (entry === undefined) throw new FixtureMissError("getDopplerHookFlags", k);
      return BigInt(entry);
    },

    async getChainId() {
      if (calls.chainId === undefined) {
        throw new FixtureMissError("getChainId", "(not recorded)");
      }
      return calls.chainId;
    },

    async getLockBeneficiaries(feesManager, asset, fromBlock, toBlock) {
      const k = key(feesManager, asset, fromBlock, toBlock);
      const entry = calls.lockBeneficiaries[k];
      if (!entry) throw new FixtureMissError("getLockBeneficiaries", k);
      return entry.map((b) => ({ beneficiary: b.beneficiary, shares: BigInt(b.shares) }));
    },

    async getAirlockAssetData(airlock, asset) {
      const k = key(airlock, asset);
      const entry = calls.airlockAssetData[k];
      if (!entry) throw new FixtureMissError("getAirlockAssetData", k);
      return toAirlockAssetData(entry);
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

    async getCode(address, block) {
      const code = await live.getCode(address, block);
      // Every consumer of a *recorded* code fixture only ever asks "is this empty?"
      // (see `hasCodeAt` in chainLogic.ts) — the real bytecode can be tens of KB per
      // call and there's nothing to gain from persisting it verbatim. Store a 1-byte
      // non-"0x" placeholder for "has code" and the real "0x" for "no code yet".
      calls.codes[key(address, block)] = code.toLowerCase() === "0x" ? "0x" : "0x01";
      return code;
    },

    async getPoolKeyRaw(feesManager, poolId) {
      const result = await live.getPoolKeyRaw(feesManager, poolId);
      calls.poolKeys[key(feesManager, poolId)] = result;
      return result;
    },

    async getShares(feesManager, poolId, beneficiary) {
      const result = await live.getShares(feesManager, poolId, beneficiary);
      calls.shares[key(feesManager, poolId, beneficiary)] = result.toString();
      return result;
    },

    async getCumulatedFees(feesManager, poolId, index, block) {
      const result = await live.getCumulatedFees(
        feesManager,
        poolId,
        index,
        block,
      );
      calls.cumulatedFees[key(feesManager, poolId, index, block)] = result.toString();
      return result;
    },

    async getUncollectedFees(feesManager, poolId, block) {
      const result = await live.getUncollectedFees(feesManager, poolId, block);
      calls.uncollectedFees[key(feesManager, poolId, block)] = [
        result[0].toString(),
        result[1].toString(),
      ];
      return result;
    },

    async getSwapLogs(poolManager, poolId, fromBlock, toBlock, cap) {
      const result = await live.getSwapLogs(
        poolManager,
        poolId,
        fromBlock,
        toBlock,
        cap,
      );
      // The business logic only ever keeps the most-recent `cap` swaps across the whole
      // query range. Recording every raw log in every 10k-block chunk can blow fixtures
      // up to hundreds of KB for busy pools; trimming each chunk to its own most-recent
      // `cap` entries before persisting is safe because an entry that doesn't even make
      // the top of its own chunk can never make the global top-`cap` once merged with
      // other (typically more recent) chunks. Keying by `cap` (see `swapLogKey`) means a
      // replay with a larger, unrecorded cap correctly misses instead of silently
      // returning this trimmed set.
      const trimmed = [...result]
        .sort((a, b) => {
          if (a.blockNumber !== b.blockNumber) {
            return a.blockNumber < b.blockNumber ? 1 : -1;
          }
          return b.logIndex - a.logIndex;
        })
        .slice(0, cap);
      calls.swapLogs[swapLogKey(poolManager, poolId, fromBlock, toBlock, cap)] =
        trimmed.map(toRawSwapLogJson);
      return result;
    },

    async getTransactionSender(hash) {
      const result = await live.getTransactionSender(hash);
      calls.transactions[hash.toLowerCase()] = result;
      return result;
    },

    async getLatestRoundData(feed, block) {
      const result = await live.getLatestRoundData(feed, block);
      calls.roundData[key(feed, block)] = [
        result[0].toString(),
        result[1].toString(),
        result[2].toString(),
        result[3].toString(),
        result[4].toString(),
      ];
      return result;
    },

    async getFeedDecimals(feed, block) {
      const result = await live.getFeedDecimals(feed, block);
      calls.decimals[key(feed, block)] = result;
      return result;
    },

    async getAssetStateRaw(feesManager, asset) {
      const result = await live.getAssetStateRaw(feesManager, asset);
      calls.assetState[key(feesManager, asset)] = result;
      return result;
    },

    async getDopplerHookFlags(feesManager, dopplerHook) {
      const result = await live.getDopplerHookFlags(feesManager, dopplerHook);
      calls.dopplerHookFlags[key(feesManager, dopplerHook)] = result.toString();
      return result;
    },

    async getChainId() {
      const result = await live.getChainId();
      calls.chainId = result;
      return result;
    },

    async getLockBeneficiaries(feesManager, asset, fromBlock, toBlock) {
      const result = await live.getLockBeneficiaries(feesManager, asset, fromBlock, toBlock);
      calls.lockBeneficiaries[key(feesManager, asset, fromBlock, toBlock)] = result.map((b) => ({
        beneficiary: b.beneficiary,
        shares: b.shares.toString(),
      }));
      return result;
    },

    async getAirlockAssetData(airlock, asset) {
      const result = await live.getAirlockAssetData(airlock, asset);
      calls.airlockAssetData[key(airlock, asset)] = toAirlockAssetDataJson(result);
      return result;
    },
  };

  return {
    ops,
    dump(): ChainFixture {
      // Deep-copy the snapshot: sibling `Promise.all` reads keep mutating the live
      // `calls` object after a caller has already taken a decision off an earlier
      // `dump()` (e.g. one read throws while others are still in flight) — without this,
      // an evidence bundle built from a `dump()` result can silently change underneath
      // its own already-computed `evidenceHash` as those in-flight reads settle and
      // record themselves into the same object.
      return {
        token: meta.token,
        chainId: meta.chainId,
        recordedAt: new Date().toISOString(),
        calls: structuredClone(calls),
      };
    },
  };
}
