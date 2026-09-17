import type { Address } from "viem";
import type { SwapRecord } from "../sources/chain.js";

const DAY_SECONDS = 86_400n;
const AGE_HAIRCUT_THRESHOLD_SECONDS = 14n * DAY_SECONDS;
const CONCENTRATION_HAIRCUT_THRESHOLD = 0.6;
const WASH_HAIRCUT_THRESHOLD = 0.2;
const CV_HAIRCUT_THRESHOLD = 1.5;
const TOP_N_FOR_CONCENTRATION = 5;
const BPS_SCALE = 10_000;

const CONCENTRATION_HAIRCUT_FACTOR_BPS = 6000;
const WASH_HAIRCUT_FACTOR_BPS = 5000;
const AGE_HAIRCUT_FACTOR_BPS = 7000;
const CV_HAIRCUT_FACTOR_BPS = 8000;

export interface QualityContext {
  /**
   * Wash-trading signal: swaps whose `tx.from` equals this address. Neither Bankr's
   * typed `token-fees` response nor `SwapRecord` carries a separate token-deployer
   * address — only the creator/beneficiary is reliably available — so "creator or token
   * deployer" collapses to "creator" here; documented here rather than silently assumed.
   */
  creator: Address;
  /** Token age in seconds (from `RevenueWindows.ageSeconds`). */
  ageSeconds: bigint;
  /**
   * The last 7 on-chain daily revenue buckets, most-recent-last, in any single
   * consistent unit — CV is dimensionless, so WETH wei works as well as micro-USD.
   * Source these from `RevenueWindows.dailyRevenueWei` (`computeRevenue` derives them
   * from on-chain fee accrual, never from off-chain claim/display data). Fewer than 2
   * buckets, or a non-positive mean, leaves `cv` undefined (no haircut contribution)
   * rather than fabricating a signal.
   */
  recentDailyRevenue: readonly bigint[];
}

export interface Quality {
  swapCount: number;
  /** Top-5 `tx.from` share of swap count, 0..1. */
  top5ConcentrationRatio: number;
  /** Share of swaps whose `tx.from` is the creator, 0..1. */
  washRatio: number;
  /** Coefficient of variation of `recentDailyRevenue`; undefined if not computable. */
  cv: number | undefined;
  /** Combined multiplicative haircut, integer bps, 0..10000. */
  haircutBps: number;
}

/** `h * factorBps / 10000`, floored — every haircut factor is applied as an integer bps
 * multiplication, never accumulated as a float and rounded once at the end. */
function applyHaircutFactor(haircutBps: number, factorBps: number): number {
  return Math.floor((haircutBps * factorBps) / BPS_SCALE);
}

function computeCv(buckets: readonly bigint[]): number | undefined {
  if (buckets.length < 2) return undefined;
  const values = buckets.map((b) => Number(b));
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean <= 0) return undefined;
  const variance =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

/**
 * Trade-quality signals from a capped, most-recent-first swap sample, plus the
 * multiplicative haircut they (and age/CV) produce. Pure/sync — every input is either the
 * swap sample or pre-resolved context (see `QualityContext`).
 */
export function computeQuality(
  swaps: readonly SwapRecord[],
  ctx: QualityContext,
): Quality {
  const swapCount = swaps.length;

  const countByFrom = new Map<string, number>();
  for (const swap of swaps) {
    const key = swap.from.toLowerCase();
    countByFrom.set(key, (countByFrom.get(key) ?? 0) + 1);
  }
  const sortedCounts = [...countByFrom.values()].sort((a, b) => b - a);
  const top5Count = sortedCounts
    .slice(0, TOP_N_FOR_CONCENTRATION)
    .reduce((a, b) => a + b, 0);
  const top5ConcentrationRatio = swapCount > 0 ? top5Count / swapCount : 0;

  const creatorKey = ctx.creator.toLowerCase();
  const washCount = swaps.filter((s) => s.from.toLowerCase() === creatorKey).length;
  const washRatio = swapCount > 0 ? washCount / swapCount : 0;

  const cv = computeCv(ctx.recentDailyRevenue);

  let haircutBps = BPS_SCALE;
  if (top5ConcentrationRatio > CONCENTRATION_HAIRCUT_THRESHOLD) {
    haircutBps = applyHaircutFactor(haircutBps, CONCENTRATION_HAIRCUT_FACTOR_BPS);
  }
  if (washRatio > WASH_HAIRCUT_THRESHOLD) {
    haircutBps = applyHaircutFactor(haircutBps, WASH_HAIRCUT_FACTOR_BPS);
  }
  if (ctx.ageSeconds < AGE_HAIRCUT_THRESHOLD_SECONDS) {
    haircutBps = applyHaircutFactor(haircutBps, AGE_HAIRCUT_FACTOR_BPS);
  }
  if (cv !== undefined && cv > CV_HAIRCUT_THRESHOLD) {
    haircutBps = applyHaircutFactor(haircutBps, CV_HAIRCUT_FACTOR_BPS);
  }

  return { swapCount, top5ConcentrationRatio, washRatio, cv, haircutBps };
}
