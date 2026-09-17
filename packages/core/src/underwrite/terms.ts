import type { Quality } from "./quality.js";
import type { RevenueWindows } from "./revenue.js";

const DAY_SECONDS = 86_400n;
const PROJECTION_DAYS = 90;
/** `q = (decayBps/10000)^(1/DECAY_EXPONENT)`. The [DECAY_MIN_BPS,DECAY_MAX_BPS]/[Q_MIN,Q_MAX]
 * clamps below don't bound a collapsing token's total projection in general — `base` itself
 * can still be much larger than `r1`. What they actually do is widen how far a low r7/r30
 * ratio is allowed to pull the daily retention factor `q` down (to as low as 0.90), so a
 * token whose 7d revenue rate has fallen steeply relative to its 30d rate decays hard over
 * the 90-day sum instead of projecting at a near-flat rate. */
const DECAY_EXPONENT = 23;
const DECAY_MIN_BPS = 1000n;
const DECAY_MAX_BPS = 10000n;
const Q_MIN = 0.9;
const Q_MAX = 1.0;

const CAP_CONSERVATISM_BPS = 5000n; // rawCap = projected90 * 5000/10000 * haircut/10000
const BPS_DENOMINATOR = 10_000n;
/** 1 cent = 1e4 micro-USD (1 USD = 1e6 micro-USD). Exported so a post-formula tightening
 * step (e.g. `mergeMemo`) can re-round a shrunk cap down to whole cents the same way. */
export const CENT_MICRO_USD = 10_000n;
/** noteSupply (1e18) = capMicroUsd (1e6) * 1e12. Exported for the same reason as
 * `CENT_MICRO_USD` — recomputing `noteSupply` after `capMicroUsd` changes post-formula. */
export const NOTE_DECIMALS_SCALE = 10n ** 12n;

const MAINNET_HARD_CEILING_MICRO_USD = 25_000_000n; // $25
const DEMO_HARD_CEILING_MICRO_USD = 10_000_000_000n; // $10,000

const BASE_FLOOR_CENTS = 80;
const FLOOR_BUMP_CENTS = 5;
/** Hard ceiling on `floorCents`, regardless of source — the formula's own bumps, or a
 * memo's `floorCentsDelta`. Exported so `mergeMemo` clamps against the same value. */
export const MAX_FLOOR_CENTS = 95;
const LOW_HAIRCUT_FLOOR_BUMP_THRESHOLD_BPS = 7000;
const YOUNG_AGE_THRESHOLD_SECONDS = 14n * DAY_SECONDS;

const MIN_PRINCIPAL_DRAW_PERIODS = 14n;
const MIN_DRAW_LIMIT_USDC_WEI = 100_000n;

const DEFAULT_DRAW_PERIOD_SECONDS = 86_400;
const DEFAULT_GRACE_PERIOD_SECONDS = 14 * 86_400;
const MAINNET_AUCTION_BLOCKS = 1000n;
const DEMO_AUCTION_BLOCKS = 250n;
/** Auction durations must divide this many blocks-mps. */
const AUCTION_BLOCKS_MODULUS = 10_000_000n; // 1e7

export type UnderwritingNetwork = "mainnet" | "demo";

export interface UnderwritingEnv {
  network: UnderwritingNetwork;
  /** USDC-wei hard ceiling on cap. Defaults: $25 mainnet, $10,000 demo (sepolia/fork). */
  hardCeilingMicroUsd?: bigint;
  /** Seconds; env override for compressed demos. Default 86400 regardless of network. */
  drawPeriodSeconds?: number;
  /** Seconds; env override for compressed demos. Default 14*86400 regardless of network. */
  gracePeriodSeconds?: number;
  /** Must divide 1e7. Default 1000 mainnet / 250 demo. */
  auctionBlocks?: bigint;
}

export interface TermsSummary {
  revenueWei: { d1: bigint; d7: bigint; d30: bigint };
  revenueMicroUsd: { d1: bigint; d7: bigint; d30: bigint };
  projected90dMicroUsd: bigint;
  haircutBps: number; // 0..10000
  capMicroUsd: bigint; // = noteSupply / 1e12
  floorCents: number;
  minPrincipal: bigint; // USDC-wei
  drawLimit: bigint;
  drawPeriod: number;
  gracePeriod: number;
}

/** `computeTerms`'s full return shape, including the two fields (`noteSupply`,
 * `auctionBlocks`) that round out the `TermSheet` but aren't part of `TermsSummary`
 * itself. Named so callers downstream of the formula (`mergeMemo`) don't have to repeat
 * the intersection type. */
export type ComputedTerms = TermsSummary & { noteSupply: bigint; auctionBlocks: bigint };

function clampBigint(x: bigint, lo: bigint, hi: bigint): bigint {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function clampNumber(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function bigintMin(a: bigint, b: bigint, c: bigint): bigint {
  return a < b ? (a < c ? a : c) : b < c ? b : c;
}

function bigintMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** Rounds `x` down to a whole cent (the nearest lower multiple of `CENT_MICRO_USD`). */
export function roundDownToWholeCents(x: bigint): bigint {
  return (x / CENT_MICRO_USD) * CENT_MICRO_USD;
}

/**
 * `minPrincipal`/`drawLimit` as a pure function of `capMicroUsd`/`floorCents` — the same
 * stepwise formula `computeTerms` applies (cap * floorCents/100 * 50/100, then floored up
 * to `MIN_DRAW_LIMIT_USDC_WEI` over `MIN_PRINCIPAL_DRAW_PERIODS`). Exported so a
 * post-formula tightening step (`mergeMemo`) that lowers the cap or raises the floor keeps
 * `minPrincipal`/`drawLimit` consistent with the same rule, rather than leaving them stale.
 */
export function deriveDrawTerms(
  capMicroUsd: bigint,
  floorCents: number,
): { minPrincipal: bigint; drawLimit: bigint } {
  const minPrincipalAfterFloor = (capMicroUsd * BigInt(floorCents)) / 100n;
  const minPrincipal = (minPrincipalAfterFloor * 50n) / 100n;
  const drawLimit = bigintMax(minPrincipal / MIN_PRINCIPAL_DRAW_PERIODS, MIN_DRAW_LIMIT_USDC_WEI);
  return { minPrincipal, drawLimit };
}

/** Rejects negative money/ratio inputs outright rather than letting them silently flow
 * into a nonsensical cap — every input here should be structurally non-negative already
 * (revenue accrual deltas, ages, bps), so a negative value means something upstream is
 * broken and must fail loudly, not produce a plausible-looking wrong number. */
function assertNonNegativeInputs(rev: RevenueWindows, quality: Quality): void {
  const revenues = [rev.revenueMicroUsd.d1, rev.revenueMicroUsd.d7, rev.revenueMicroUsd.d30];
  for (const value of revenues) {
    if (value < 0n) {
      throw new Error(`computeTerms: revenueMicroUsd must be non-negative, got ${value}`);
    }
  }
  if (rev.ageSeconds < 0n) {
    throw new Error(`computeTerms: ageSeconds must be non-negative, got ${rev.ageSeconds}`);
  }
  if (quality.haircutBps < 0 || quality.haircutBps > 10000) {
    throw new Error(`computeTerms: haircutBps must be within [0,10000], got ${quality.haircutBps}`);
  }
}

/** Validates env overrides before they reach the formula: a non-positive or
 * non-integer draw/grace period would otherwise produce a nonsensical `TermSheet`, and
 * a hard ceiling above the mainnet pilot's $25 cap would silently blow past the
 * program's own risk limit. */
/** Exported so callers (the engine's up-front input validation) can reject a bad env
 * before doing any paid work, using the exact same rule `computeTerms` itself enforces —
 * rather than a second, potentially-diverging copy of the same checks. */
export function assertUsableEnv(env: UnderwritingEnv): void {
  for (const [name, value] of [
    ["drawPeriodSeconds", env.drawPeriodSeconds],
    ["gracePeriodSeconds", env.gracePeriodSeconds],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`computeTerms: ${name} must be a positive integer, got ${value}`);
    }
  }
  if (
    env.network === "mainnet" &&
    env.hardCeilingMicroUsd !== undefined &&
    env.hardCeilingMicroUsd > MAINNET_HARD_CEILING_MICRO_USD
  ) {
    throw new Error(
      `computeTerms: hardCeilingMicroUsd (${env.hardCeilingMicroUsd}) may not exceed the mainnet ceiling (${MAINNET_HARD_CEILING_MICRO_USD})`,
    );
  }
}

/**
 * Pure underwriting math: 90-day revenue projection, quality haircut applied, cap +
 * floor + draw terms derived. Every output is bigint (money) or integer bps/seconds/
 * cents — the only floats used internally (decay retention `q`, the geometric-sum
 * multiplier) are converted back to bigint with explicit floor rounding before leaving
 * this function.
 */
export function computeTerms(
  rev: RevenueWindows,
  quality: Quality,
  env: UnderwritingEnv,
): ComputedTerms {
  assertNonNegativeInputs(rev, quality);
  assertUsableEnv(env);

  const d1 = rev.revenueMicroUsd.d1;
  const d7 = rev.revenueMicroUsd.d7;
  const d30 = rev.revenueMicroUsd.d30;

  // Daily rates (micro-USD).
  const r1 = d1;
  const r7 = d7 / 7n;
  const r30 = d30 / 30n;
  const base = bigintMin(r7, r30, (r1 + r7) / 2n);

  // Decay: per-day retention `q`, geometric sum over 90 days.
  const decayBps = clampBigint(
    (BPS_DENOMINATOR * r7) / (r30 > 0n ? r30 : 1n),
    DECAY_MIN_BPS,
    DECAY_MAX_BPS,
  );
  const q = clampNumber(
    (Number(decayBps) / 10_000) ** (1 / DECAY_EXPONENT),
    Q_MIN,
    Q_MAX,
  );
  let sumQ = 0;
  let qPow = 1;
  for (let d = 0; d < PROJECTION_DAYS; d++) {
    sumQ += qPow;
    qPow *= q;
  }
  const projected90dMicroUsd = BigInt(Math.floor(Number(base) * sumQ));

  const haircutBps = quality.haircutBps;

  // rawCap = projected90 * 5000/10000 * haircut/10000, applied stepwise (matches the
  // binding formula's literal order rather than a single combined division).
  const capAfterConservatism = (projected90dMicroUsd * CAP_CONSERVATISM_BPS) / BPS_DENOMINATOR;
  const rawCap = (capAfterConservatism * BigInt(haircutBps)) / BPS_DENOMINATOR;

  const hardCeiling =
    env.hardCeilingMicroUsd ??
    (env.network === "mainnet" ? MAINNET_HARD_CEILING_MICRO_USD : DEMO_HARD_CEILING_MICRO_USD);
  const capBeforeRounding = rawCap < hardCeiling ? rawCap : hardCeiling;
  const capMicroUsd = roundDownToWholeCents(capBeforeRounding);

  const noteSupply = capMicroUsd * NOTE_DECIMALS_SCALE;

  let floorCents = BASE_FLOOR_CENTS;
  if (haircutBps < LOW_HAIRCUT_FLOOR_BUMP_THRESHOLD_BPS) floorCents += FLOOR_BUMP_CENTS;
  if (rev.ageSeconds < YOUNG_AGE_THRESHOLD_SECONDS) floorCents += FLOOR_BUMP_CENTS;
  floorCents = Math.min(floorCents, MAX_FLOOR_CENTS);

  const { minPrincipal, drawLimit } = deriveDrawTerms(capMicroUsd, floorCents);

  const drawPeriod = env.drawPeriodSeconds ?? DEFAULT_DRAW_PERIOD_SECONDS;
  const gracePeriod = env.gracePeriodSeconds ?? DEFAULT_GRACE_PERIOD_SECONDS;

  const auctionBlocks =
    env.auctionBlocks ??
    (env.network === "mainnet" ? MAINNET_AUCTION_BLOCKS : DEMO_AUCTION_BLOCKS);
  if (auctionBlocks <= 0n || AUCTION_BLOCKS_MODULUS % auctionBlocks !== 0n) {
    throw new Error(`auctionBlocks (${auctionBlocks}) must divide 1e7`);
  }

  return {
    revenueWei: rev.revenueWei,
    revenueMicroUsd: rev.revenueMicroUsd,
    projected90dMicroUsd,
    haircutBps,
    capMicroUsd,
    floorCents,
    minPrincipal,
    drawLimit,
    drawPeriod,
    gracePeriod,
    noteSupply,
    auctionBlocks,
  };
}
