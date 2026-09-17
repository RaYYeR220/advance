import type { Address, Hex } from "viem";
import type { ChainOps, RawSwapLog } from "./chainOps.js";

export interface PoolKeyInfo {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface FeeAccrual {
  block: bigint;
  cumulated0: bigint;
  cumulated1: bigint;
  uncollected0: bigint;
  uncollected1: bigint;
  /** `cumulated0 + uncollected0` — total fees ever accrued to the pool, token0. */
  total0: bigint;
  /** `cumulated1 + uncollected1` — total fees ever accrued to the pool, token1. */
  total1: bigint;
}

export interface SwapRecord {
  poolId: Hex;
  sender: Address;
  /** EOA that originated the transaction (`tx.from`), fetched separately and batched. */
  from: Address;
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
  fee: number;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
}

export interface CreatorRevenueWindow {
  wethIndex: 0 | 1;
  fromBlock: bigint;
  toBlock: bigint;
  fromTimestamp: bigint;
  toTimestamp: bigint;
  accruedFromWeth: bigint;
  accruedToWeth: bigint;
  /** Pool-wide WETH fee delta over the window (`accruedToWeth - accruedFromWeth`). */
  poolDeltaWeth: bigint;
  /** Creator's current shares, WAD (1e18) scaled. */
  creatorSharesWad: bigint;
  /** `poolDeltaWeth * creatorSharesWad / 1e18`. */
  creatorRevenueWeth: bigint;
}

export interface EthUsdPrice {
  roundId: bigint;
  answer: bigint;
  decimals: number;
  startedAt: bigint;
  updatedAt: bigint;
  answeredInRound: bigint;
  block: bigint;
}

export interface TokenCreatedAt {
  block: bigint;
  timestamp: number;
}

/** `blockAt(timestamp)` was asked for a timestamp before the chain's first block. */
export class BlockAtBeforeGenesisError extends Error {
  constructor(timestamp: bigint, genesisTimestamp: bigint) {
    super(
      `blockAt: timestamp ${timestamp} is before genesis (block 1 timestamp ${genesisTimestamp})`,
    );
    this.name = "BlockAtBeforeGenesisError";
  }
}

export interface ChainReader {
  getPoolKey(feesManager: Address, poolId: Hex): Promise<PoolKeyInfo>;
  getShares(
    feesManager: Address,
    poolId: Hex,
    beneficiary: Address,
  ): Promise<bigint>;
  getWethIndex(poolKey: PoolKeyInfo, weth: Address): 0 | 1;
  getFeeAccrual(
    feesManager: Address,
    poolId: Hex,
    block: bigint,
  ): Promise<FeeAccrual>;
  getLatestBlock(): Promise<{ number: bigint; timestamp: bigint }>;
  getBlockTimestamp(block: bigint): Promise<bigint>;
  /**
   * Binary search on `getBlock` timestamps for the latest block with `timestamp <= t`.
   * Throws `BlockAtBeforeGenesisError` if `t` is before block 1's own timestamp — it
   * never silently clamps to block 1.
   */
  blockAt(timestamp: bigint): Promise<bigint>;
  /**
   * First block at which `token` has non-empty code (`eth_getCode` binary search),
   * cached per reader instance. Throws if `token` has no code even at the latest block.
   */
  tokenCreatedAt(token: Address): Promise<TokenCreatedAt>;
  getCreatorRevenueWindow(params: {
    feesManager: Address;
    poolId: Hex;
    creator: Address;
    weth: Address;
    windowSeconds: bigint;
    /** Defaults to latest block. */
    atBlock?: bigint;
  }): Promise<CreatorRevenueWindow>;
  getSwaps(params: {
    poolManager: Address;
    poolId: Hex;
    fromBlock: bigint;
    toBlock: bigint;
    /** Most-recent-first cap; default 400. */
    cap?: number;
  }): Promise<SwapRecord[]>;
  getEthUsdPrice(feed: Address, block?: bigint): Promise<EthUsdPrice>;
}

const SWAP_LOG_CHUNK_BLOCKS = 10_000n;
const DEFAULT_SWAP_CAP = 400;
/** Base block time used only to seed the `blockAt` binary search guess. */
const SECONDS_PER_BLOCK_GUESS = 2n;
/** Bounded concurrency for batched `getTransactionSender` / `getCode` lookups. */
const BATCH_CONCURRENCY = 20;

/** Runs `fn` over `items` with at most `BATCH_CONCURRENCY` calls in flight at once. */
async function mapBatched<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  for (let i = 0; i < items.length; i += BATCH_CONCURRENCY) {
    const chunk = items.slice(i, i + BATCH_CONCURRENCY);
    const chunkResults = await Promise.all(chunk.map((item) => fn(item)));
    for (let j = 0; j < chunkResults.length; j++) {
      results[i + j] = chunkResults[j]!;
    }
  }
  return results;
}

export function buildChainReader(ops: ChainOps): ChainReader {
  const blockTimestampCache = new Map<bigint, bigint>();
  const tokenCreatedAtCache = new Map<string, TokenCreatedAt>();
  let latestCache: { number: bigint; timestamp: bigint } | undefined;
  let genesisTimestampCache: bigint | undefined;

  async function getBlockTimestamp(block: bigint): Promise<bigint> {
    const cached = blockTimestampCache.get(block);
    if (cached !== undefined) return cached;
    const ts = await ops.getBlockTimestamp(block);
    blockTimestampCache.set(block, ts);
    return ts;
  }

  async function getLatestBlock(): Promise<{ number: bigint; timestamp: bigint }> {
    if (latestCache) return latestCache;
    const number = await ops.getBlockNumber();
    const timestamp = await getBlockTimestamp(number);
    latestCache = { number, timestamp };
    return latestCache;
  }

  async function blockAt(timestamp: bigint): Promise<bigint> {
    const latest = await getLatestBlock();
    if (timestamp >= latest.timestamp) return latest.number;

    let lo = 1n;
    let hi = latest.number;
    let guess = latest.number - (latest.timestamp - timestamp) / SECONDS_PER_BLOCK_GUESS;
    if (guess < lo) guess = lo;
    if (guess > hi) guess = hi;

    let result: bigint | undefined;
    let first = true;
    while (lo <= hi) {
      const mid = first ? guess : (lo + hi) / 2n;
      first = false;
      const ts = await getBlockTimestamp(mid);
      if (ts <= timestamp) {
        result = mid;
        lo = mid + 1n;
      } else {
        hi = mid - 1n;
      }
    }

    if (result === undefined) {
      // Every candidate the search tried (including block 1) had a timestamp after
      // `timestamp` — it's before genesis. Never silently clamp to block 1.
      if (genesisTimestampCache === undefined) {
        genesisTimestampCache = await getBlockTimestamp(1n);
      }
      throw new BlockAtBeforeGenesisError(timestamp, genesisTimestampCache);
    }
    return result;
  }

  async function getPoolKey(
    feesManager: Address,
    poolId: Hex,
  ): Promise<PoolKeyInfo> {
    const [currency0, currency1, fee, tickSpacing, hooks] =
      await ops.getPoolKeyRaw(feesManager, poolId);
    return { currency0, currency1, fee, tickSpacing, hooks };
  }

  function getShares(
    feesManager: Address,
    poolId: Hex,
    beneficiary: Address,
  ): Promise<bigint> {
    return ops.getShares(feesManager, poolId, beneficiary);
  }

  function getWethIndex(poolKey: PoolKeyInfo, weth: Address): 0 | 1 {
    const target = weth.toLowerCase();
    if (poolKey.currency0.toLowerCase() === target) return 0;
    if (poolKey.currency1.toLowerCase() === target) return 1;
    throw new Error(
      `pool does not contain WETH (${weth}); currency0=${poolKey.currency0} currency1=${poolKey.currency1}`,
    );
  }

  async function getFeeAccrual(
    feesManager: Address,
    poolId: Hex,
    block: bigint,
  ): Promise<FeeAccrual> {
    const [cumulated0, cumulated1, uncollected] = await Promise.all([
      ops.getCumulatedFees(feesManager, poolId, 0, block),
      ops.getCumulatedFees(feesManager, poolId, 1, block),
      ops.getUncollectedFees(feesManager, poolId, block),
    ]);
    const [uncollected0, uncollected1] = uncollected;
    return {
      block,
      cumulated0,
      cumulated1,
      uncollected0,
      uncollected1,
      total0: cumulated0 + uncollected0,
      total1: cumulated1 + uncollected1,
    };
  }

  async function getCreatorRevenueWindow(params: {
    feesManager: Address;
    poolId: Hex;
    creator: Address;
    weth: Address;
    windowSeconds: bigint;
    atBlock?: bigint;
  }): Promise<CreatorRevenueWindow> {
    const { feesManager, poolId, creator, weth, windowSeconds } = params;

    const atBlockInfo =
      params.atBlock !== undefined
        ? { number: params.atBlock, timestamp: await getBlockTimestamp(params.atBlock) }
        : await getLatestBlock();

    const fromTimestamp = atBlockInfo.timestamp - windowSeconds;
    // Let `blockAt` itself decide what "before genesis" means (throws), rather than
    // silently clamping to block 1 here for a degenerate (e.g. oversized) window.
    const fromBlock = await blockAt(fromTimestamp);

    const poolKey = await getPoolKey(feesManager, poolId);
    const wethIndex = getWethIndex(poolKey, weth);

    const [accrualTo, accrualFrom, sharesWad] = await Promise.all([
      getFeeAccrual(feesManager, poolId, atBlockInfo.number),
      getFeeAccrual(feesManager, poolId, fromBlock),
      getShares(feesManager, poolId, creator),
    ]);

    const accruedToWeth = wethIndex === 0 ? accrualTo.total0 : accrualTo.total1;
    const accruedFromWeth =
      wethIndex === 0 ? accrualFrom.total0 : accrualFrom.total1;
    const poolDeltaWeth = accruedToWeth - accruedFromWeth;
    const creatorRevenueWeth = (poolDeltaWeth * sharesWad) / 10n ** 18n;

    return {
      wethIndex,
      fromBlock,
      toBlock: atBlockInfo.number,
      fromTimestamp,
      toTimestamp: atBlockInfo.timestamp,
      accruedFromWeth,
      accruedToWeth,
      poolDeltaWeth,
      creatorSharesWad: sharesWad,
      creatorRevenueWeth,
    };
  }

  async function getSwaps(params: {
    poolManager: Address;
    poolId: Hex;
    fromBlock: bigint;
    toBlock: bigint;
    cap?: number;
  }): Promise<SwapRecord[]> {
    const { poolManager, poolId, fromBlock, toBlock } = params;
    const cap = params.cap ?? DEFAULT_SWAP_CAP;

    const all: RawSwapLog[] = [];
    for (let start = fromBlock; start <= toBlock; start += SWAP_LOG_CHUNK_BLOCKS) {
      const end =
        start + SWAP_LOG_CHUNK_BLOCKS - 1n > toBlock
          ? toBlock
          : start + SWAP_LOG_CHUNK_BLOCKS - 1n;
      const chunk = await ops.getSwapLogs(poolManager, poolId, start, end, cap);
      all.push(...chunk);
    }

    all.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber < b.blockNumber ? 1 : -1;
      }
      return b.logIndex - a.logIndex;
    });
    const capped = all.slice(0, cap);

    // Batched (bounded-concurrency), not sequential: tx.from lookups are issued
    // concurrently, up to BATCH_CONCURRENCY at a time, instead of one at a time.
    const uniqueHashes = [...new Set(capped.map((s) => s.transactionHash))];
    const senders = await mapBatched(uniqueHashes, (hash) =>
      ops.getTransactionSender(hash),
    );
    const senderByHash = new Map<Hex, Address>();
    uniqueHashes.forEach((hash, i) => senderByHash.set(hash, senders[i]!));

    return capped.map((s) => ({
      poolId,
      sender: s.sender,
      from: senderByHash.get(s.transactionHash)!,
      amount0: s.amount0,
      amount1: s.amount1,
      sqrtPriceX96: s.sqrtPriceX96,
      liquidity: s.liquidity,
      tick: s.tick,
      fee: s.fee,
      blockNumber: s.blockNumber,
      transactionHash: s.transactionHash,
      logIndex: s.logIndex,
    }));
  }

  async function getEthUsdPrice(
    feed: Address,
    block?: bigint,
  ): Promise<EthUsdPrice> {
    const atBlock = block ?? (await getLatestBlock()).number;
    const [[roundId, answer, startedAt, updatedAt, answeredInRound], decimals] =
      await Promise.all([
        ops.getLatestRoundData(feed, atBlock),
        ops.getFeedDecimals(feed, atBlock),
      ]);
    return {
      roundId,
      answer,
      decimals,
      startedAt,
      updatedAt,
      answeredInRound,
      block: atBlock,
    };
  }

  async function hasCodeAt(token: Address, block: bigint): Promise<boolean> {
    const code = await ops.getCode(token, block);
    return code !== undefined && code.toLowerCase() !== "0x";
  }

  async function tokenCreatedAt(token: Address): Promise<TokenCreatedAt> {
    const cacheKey = token.toLowerCase();
    const cached = tokenCreatedAtCache.get(cacheKey);
    if (cached) return cached;

    const latest = await getLatestBlock();
    if (!(await hasCodeAt(token, latest.number))) {
      throw new Error(
        `tokenCreatedAt: ${token} has no code at the latest block (${latest.number})`,
      );
    }

    // Binary search for the first block with non-empty code: invariant
    // hasCodeAt(hi) === true throughout; find the smallest such block.
    let lo = 1n;
    let hi = latest.number;
    while (lo < hi) {
      const mid = lo + (hi - lo) / 2n;
      if (await hasCodeAt(token, mid)) {
        hi = mid;
      } else {
        lo = mid + 1n;
      }
    }

    const timestamp = Number(await getBlockTimestamp(hi));
    const result: TokenCreatedAt = { block: hi, timestamp };
    tokenCreatedAtCache.set(cacheKey, result);
    return result;
  }

  return {
    getPoolKey,
    getShares,
    getWethIndex,
    getFeeAccrual,
    getLatestBlock,
    getBlockTimestamp,
    blockAt,
    tokenCreatedAt,
    getCreatorRevenueWindow,
    getSwaps,
    getEthUsdPrice,
  };
}
