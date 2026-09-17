import type { Address, Hex } from "viem";
import type { ChainReader } from "../sources/chain.js";

const DAY_SECONDS = 86_400n;
/** `ChainReader.getEthUsdPrice` answers are Chainlink's fixed 8-decimal format. */
const ETH_USD_AND_WEI_SCALE = 10n ** 20n; // 1e18 (wei/ETH) * 1e8 (Chainlink decimals) / 1e6 (micro-USD/USD)

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
}

/** `wei` (1e18) valued at `ethUsdAnswer` (Chainlink 8-decimal) -> floored micro-USD (1e6). */
function weiToMicroUsd(wei: bigint, ethUsdAnswer: bigint): bigint {
  return (wei * ethUsdAnswer) / ETH_USD_AND_WEI_SCALE;
}

/**
 * Computes the 1d/7d/30d creator revenue windows (WETH wei + micro-USD) plus token age and
 * current creator shares. Reuses `ChainReader.getCreatorRevenueWindow` for the window math
 * (per plan-02 task 3 facts) rather than re-implementing the fee-accrual/shares logic.
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

  const [windowD1, windowD7, windowD30, createdAt, ethUsd] = await Promise.all([
    reader.getCreatorRevenueWindow({ ...windowArgs, windowSeconds: 1n * DAY_SECONDS }),
    reader.getCreatorRevenueWindow({ ...windowArgs, windowSeconds: 7n * DAY_SECONDS }),
    reader.getCreatorRevenueWindow({ ...windowArgs, windowSeconds: 30n * DAY_SECONDS }),
    reader.tokenCreatedAt(ctx.token),
    reader.getEthUsdPrice(ctx.ethUsdFeed, atBlockInfo.number),
  ]);

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
  };
}
