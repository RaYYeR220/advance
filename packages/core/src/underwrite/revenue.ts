import type { Address, Hex } from "viem";
import type { ChainReader, EthUsdPrice } from "../sources/chain.js";

const DAY_SECONDS = 86_400n;
/** `ChainReader.getEthUsdPrice` answers are Chainlink's fixed 8-decimal format. */
const ETH_USD_AND_WEI_SCALE = 10n ** 20n; // 1e18 (wei/ETH) * 1e8 (Chainlink decimals) / 1e6 (micro-USD/USD)
const ETH_USD_EXPECTED_DECIMALS = 8;
const ETH_USD_MAX_STALENESS_SECONDS = 3600n;

const DAILY_BUCKET_COUNT = 7;
const DAILY_ANCHOR_COUNT = DAILY_BUCKET_COUNT + 1; // 8 block anchors bound 7 day-buckets

export interface RevenueContext {
  token: Address;
  feesManager: Address;
  poolId: Hex;
  creator: Address;
  weth: Address;
  ethUsdFeed: Address;
  /** Every window, the ETH/USD read and the age calculation are anchored to this block;
   * defaults to the reader's latest block. */
  atBlock?: bigint;
}

export interface RevenueWindows {
  revenueWei: { d1: bigint; d7: bigint; d30: bigint };
  revenueMicroUsd: { d1: bigint; d7: bigint; d30: bigint };
  /**
   * `atBlock timestamp - tokenCreatedAt.timestamp`, seconds (floored at 0). Resolved here
   * rather than in `computeQuality`/`applyRules` because `computeRevenue` is the only
   * `underwrite/*` function with `ChainReader` access — both the quality age-haircut and
   * the rules `too_young` check consume this field instead of re-deriving it.
   */
  ageSeconds: bigint;
  /** Creator's current shares, WAD — reused by `applyRules`' `creator_has_no_shares` rule. */
  creatorSharesWad: bigint;
  /**
   * The last 7 on-chain daily creator-revenue buckets, WETH wei, most-recent-last.
   * Derived from 8 daily block anchors (`blockAt(now - k*1d)` for k=0..7) and fee
   * accrual reads at each anchor — the same accrual semantics as
   * `ChainReader.getCreatorRevenueWindow` (pool-wide accrual delta, then scaled by the
   * creator's current shares) — never from an off-chain claim/display API. Feeds
   * `computeQuality`'s CV haircut.
   */
  dailyRevenueWei: readonly bigint[];
}

/** `wei` (1e18) valued at `ethUsdAnswer` (Chainlink 8-decimal) -> floored micro-USD (1e6). */
function weiToMicroUsd(wei: bigint, ethUsdAnswer: bigint): bigint {
  return (wei * ethUsdAnswer) / ETH_USD_AND_WEI_SCALE;
}

/** Throws if the ETH/USD read is unusable: non-positive, the wrong decimal scale, or
 * posted more than an hour before the block it's being read at. Money math must never
 * silently run on a garbage or stale price. */
function assertUsableEthUsdPrice(price: EthUsdPrice, atTimestamp: bigint): void {
  if (price.answer <= 0n) {
    throw new Error(`computeRevenue: ETH/USD answer is non-positive (${price.answer})`);
  }
  if (price.decimals !== ETH_USD_EXPECTED_DECIMALS) {
    throw new Error(
      `computeRevenue: ETH/USD decimals is ${price.decimals}, expected ${ETH_USD_EXPECTED_DECIMALS}`,
    );
  }
  const staleness = atTimestamp - price.updatedAt;
  if (staleness > ETH_USD_MAX_STALENESS_SECONDS) {
    throw new Error(
      `computeRevenue: ETH/USD price is stale (updatedAt=${price.updatedAt}, read at ${atTimestamp}, ${staleness}s old, max ${ETH_USD_MAX_STALENESS_SECONDS}s)`,
    );
  }
}

/**
 * The last `DAILY_BUCKET_COUNT` on-chain daily creator-revenue buckets (WETH wei),
 * oldest-first / most-recent-last. Reads `DAILY_ANCHOR_COUNT` daily block anchors via
 * `blockAt`, the pool-wide WETH fee accrual at each, and the creator's current shares —
 * mirroring `ChainReader.getCreatorRevenueWindow`'s own accrual semantics (pool-wide
 * delta between two blocks, then scaled by shares) rather than a fresh formula. Any
 * reader failure (a missed fixture call, an RPC error, `blockAt` rejecting a
 * before-genesis timestamp) propagates — callers must treat a rejected
 * `computeRevenue` as `data_unavailable`, never fall back to a partial bucket set.
 */
async function computeDailyRevenueBuckets(
  reader: ChainReader,
  ctx: RevenueContext,
  atBlockInfo: { number: bigint; timestamp: bigint },
): Promise<bigint[]> {
  const poolKey = await reader.getPoolKey(ctx.feesManager, ctx.poolId);
  const wethIndex = reader.getWethIndex(poolKey, ctx.weth);

  const anchorTimestamps = Array.from(
    { length: DAILY_ANCHOR_COUNT },
    (_, i) => atBlockInfo.timestamp - BigInt(i) * DAY_SECONDS,
  );
  const anchorBlocks = await Promise.all(anchorTimestamps.map((ts) => reader.blockAt(ts)));

  const [accruals, sharesWad] = await Promise.all([
    Promise.all(
      anchorBlocks.map((block) => reader.getFeeAccrual(ctx.feesManager, ctx.poolId, block)),
    ),
    reader.getShares(ctx.feesManager, ctx.poolId, ctx.creator),
  ]);
  const wethAccruals = accruals.map((a) => (wethIndex === 0 ? a.total0 : a.total1));

  // anchorBlocks[0] is "now", anchorBlocks[7] is 7 days ago. bucketsNewestFirst[i] is the
  // creator's share of the pool-wide accrual between anchor i+1 and anchor i ("i days ago
  // through i-1 days ago"), i.e. bucketsNewestFirst[0] is yesterday-through-today.
  const bucketsNewestFirst: bigint[] = [];
  for (let i = 0; i < DAILY_BUCKET_COUNT; i++) {
    const poolDelta = wethAccruals[i]! - wethAccruals[i + 1]!;
    if (poolDelta < 0n) {
      throw new Error(
        `computeRevenue: daily bucket ${i} has a negative accrual delta (${poolDelta}) — fee accrual must be non-decreasing`,
      );
    }
    bucketsNewestFirst.push((poolDelta * sharesWad) / 10n ** 18n);
  }
  return bucketsNewestFirst.reverse(); // oldest-first, most-recent-last
}

/** True if `weth` is one of `poolId`'s two currencies, without throwing — for a
 * pre-check before calling `computeRevenue` (which throws on a non-WETH pool via
 * `ChainReader.getWethIndex`), so a caller can deny `not_weth_pool` instead of crashing. */
export async function checkIsWethPool(
  reader: ChainReader,
  feesManager: Address,
  poolId: Hex,
  weth: Address,
): Promise<boolean> {
  const poolKey = await reader.getPoolKey(feesManager, poolId);
  const target = weth.toLowerCase();
  return (
    poolKey.currency0.toLowerCase() === target || poolKey.currency1.toLowerCase() === target
  );
}

/**
 * Computes the 1d/7d/30d creator revenue windows (WETH wei + micro-USD), the last 7
 * on-chain daily revenue buckets, token age, and current creator shares. Reuses
 * `ChainReader.getCreatorRevenueWindow` for the window math rather than
 * re-implementing the fee-accrual/shares logic. Throws (never silently degrades) on any
 * reader failure or an unusable ETH/USD read — callers turn that into `data_unavailable`.
 */
export async function computeRevenue(
  reader: ChainReader,
  ctx: RevenueContext,
): Promise<RevenueWindows> {
  const atBlockInfo =
    ctx.atBlock !== undefined
      ? { number: ctx.atBlock, timestamp: await reader.getBlockTimestamp(ctx.atBlock) }
      : await reader.getLatestBlock();

  const windowArgs = {
    feesManager: ctx.feesManager,
    poolId: ctx.poolId,
    creator: ctx.creator,
    weth: ctx.weth,
    atBlock: atBlockInfo.number,
  };

  const [windowD1, windowD7, windowD30, createdAt, ethUsd, dailyRevenueWei] = await Promise.all([
    reader.getCreatorRevenueWindow({ ...windowArgs, windowSeconds: 1n * DAY_SECONDS }),
    reader.getCreatorRevenueWindow({ ...windowArgs, windowSeconds: 7n * DAY_SECONDS }),
    reader.getCreatorRevenueWindow({ ...windowArgs, windowSeconds: 30n * DAY_SECONDS }),
    reader.tokenCreatedAt(ctx.token),
    reader.getEthUsdPrice(ctx.ethUsdFeed, atBlockInfo.number),
    computeDailyRevenueBuckets(reader, ctx, atBlockInfo),
  ]);

  assertUsableEthUsdPrice(ethUsd, atBlockInfo.timestamp);

  const rawAgeSeconds = atBlockInfo.timestamp - BigInt(createdAt.timestamp);
  const ageSeconds = rawAgeSeconds < 0n ? 0n : rawAgeSeconds;

  return {
    revenueWei: {
      d1: windowD1.creatorRevenueWeth,
      d7: windowD7.creatorRevenueWeth,
      d30: windowD30.creatorRevenueWeth,
    },
    revenueMicroUsd: {
      d1: weiToMicroUsd(windowD1.creatorRevenueWeth, ethUsd.answer),
      d7: weiToMicroUsd(windowD7.creatorRevenueWeth, ethUsd.answer),
      d30: weiToMicroUsd(windowD30.creatorRevenueWeth, ethUsd.answer),
    },
    ageSeconds,
    creatorSharesWad: windowD1.creatorSharesWad,
    dailyRevenueWei,
  };
}
