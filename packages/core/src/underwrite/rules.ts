import type { Hex } from "viem";
import type { Quality } from "./quality.js";
import type { RevenueWindows } from "./revenue.js";

const MIN_AGE_SECONDS = 3n * 86_400n;
const CONCENTRATION_DENY_THRESHOLD = 0.8;
const WASH_DENY_THRESHOLD = 0.5;

export type DenyReason =
  | "not_bankr_doppler"
  | "not_weth_pool"
  | "creator_has_no_shares"
  | "already_escrowed"
  | "too_young"
  | "no_recent_revenue"
  | "wash_trading"
  | "concentrated_flow"
  | "below_minimum"
  | "memo_denied"
  | "memo_unavailable"
  | "data_unavailable";

export interface RulesContext {
  poolId: Hex;
  /** Bankr/Doppler discovery found a pool + fees manager for this token. */
  poolFound: boolean;
  /** WETH is one of the pool's two currencies (false for BNKR-paired pools, e.g. the
   * `deployer` fixture). */
  isWethPool: boolean;
  /** A data source (chain/API) read failed upstream — fails closed, short-circuits every
   * other check. */
  dataError?: boolean;
  /**
   * Known-Advance-escrow lookup. Plan 01's `AdvanceHub` ABI (`loanIdOf`) doesn't exist
   * yet, so this is an injected stub; defaults to a function that always resolves false.
   */
  isEscrowed?: (poolId: Hex) => Promise<boolean>;
}

async function defaultIsEscrowed(_poolId: Hex): Promise<boolean> {
  return false;
}

/**
 * Hard deny-rule checks. `rev`/`quality` are `undefined` when discovery or the pool shape
 * itself already failed (not_bankr_doppler / not_weth_pool / data_unavailable) — in that
 * case `computeRevenue`/`computeQuality` were never meaningfully callable, so those cases
 * short-circuit before touching them. Otherwise every applicable rule is evaluated and all
 * matching reasons are returned (not just the first).
 */
export async function applyRules(
  ctx: RulesContext,
  rev: RevenueWindows | undefined,
  quality: Quality | undefined,
): Promise<DenyReason[]> {
  if (ctx.dataError) return ["data_unavailable"];
  if (!ctx.poolFound) return ["not_bankr_doppler"];
  if (!ctx.isWethPool) return ["not_weth_pool"];
  if (!rev) return ["data_unavailable"];

  const reasons: DenyReason[] = [];

  if (rev.creatorSharesWad === 0n) reasons.push("creator_has_no_shares");

  const isEscrowed = ctx.isEscrowed ?? defaultIsEscrowed;
  if (await isEscrowed(ctx.poolId)) reasons.push("already_escrowed");

  if (rev.ageSeconds < MIN_AGE_SECONDS) reasons.push("too_young");
  if (rev.revenueMicroUsd.d7 === 0n) reasons.push("no_recent_revenue");

  if (quality) {
    if (quality.washRatio > WASH_DENY_THRESHOLD) reasons.push("wash_trading");
    if (quality.top5ConcentrationRatio > CONCENTRATION_DENY_THRESHOLD) {
      reasons.push("concentrated_flow");
    }
  }

  return reasons;
}
