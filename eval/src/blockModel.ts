/**
 * Shared synthetic block/timestamp geometry used by every scenario's fake `ChainOps`.
 * Fixed 2s block time so every day-multiple offset (1d/7d/30d windows, the 8 daily
 * anchors `computeDailyRevenueBuckets` reads) lands on an *exact* integer block number —
 * no binary-search rounding ambiguity, no off-by-one at a day boundary.
 */
export const SECONDS_PER_BLOCK = 2n;
export const BLOCKS_PER_DAY = 86_400n / SECONDS_PER_BLOCK; // 43,200

/** Arbitrary fixed "genesis" (block 1's timestamp) — a real-looking 2023 Unix time. */
export const GENESIS_TIMESTAMP = 1_700_000_000n;

/** Comfortably larger than any lookback this eval needs (30d window + up to ~130d token
 * age): 6,000,000 blocks * 2s = 12,000,000s ≈ 139 days past genesis. */
export const LATEST_BLOCK = 6_000_000n;
export const LATEST_TIMESTAMP = GENESIS_TIMESTAMP + LATEST_BLOCK * SECONDS_PER_BLOCK;

export function blockTimestamp(block: bigint): bigint {
  return GENESIS_TIMESTAMP + block * SECONDS_PER_BLOCK;
}

/** The block exactly `m` days before latest (m = 0..30). Always an exact integer since
 * `BLOCKS_PER_DAY` is exact and `LATEST_BLOCK` is fixed. */
export function dayBlock(m: number | bigint): bigint {
  return LATEST_BLOCK - BigInt(m) * BLOCKS_PER_DAY;
}

/** Inverse of `dayBlock`: recovers `m` from a block that must be exactly `dayBlock(m)`
 * for some integer `m` in `[0,30]` — every block the engine ever queries `getFeeAccrual`
 * at, given the 2s/block + day-aligned-window geometry above. Throws if `block` isn't
 * exactly on a day boundary (a real bug in the model, not a valid scenario). */
export function dayIndexOfBlock(block: bigint): number {
  const diff = LATEST_BLOCK - block;
  if (diff < 0n || diff % BLOCKS_PER_DAY !== 0n) {
    throw new Error(
      `dayIndexOfBlock: block ${block} is not an exact day boundary of latest ${LATEST_BLOCK}`,
    );
  }
  return Number(diff / BLOCKS_PER_DAY);
}

/** First block at which a token created `ageSeconds` before latest has code. `ageSeconds`
 * must be an even integer (exact at 2s/block) — every scenario's `ageSeconds` is chosen
 * that way. */
export function tokenCreationBlock(ageSeconds: bigint): bigint {
  if (ageSeconds % SECONDS_PER_BLOCK !== 0n) {
    throw new Error(`tokenCreationBlock: ageSeconds ${ageSeconds} must be even (2s/block)`);
  }
  return LATEST_BLOCK - ageSeconds / SECONDS_PER_BLOCK;
}
