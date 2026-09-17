import type { Quality } from "./quality.js";
import type { RevenueWindows } from "./revenue.js";

const DAY_SECONDS = 86_400n;
const PROJECTION_DAYS = 90;
/** `q = (decayBps/10000)^(1/DECAY_EXPONENT)` per the plan-02 task-3 binding formula. */
const DECAY_EXPONENT = 23;
const DECAY_MIN_BPS = 5000n;
const DECAY_MAX_BPS = 10000n;
const Q_MIN = 0.97;
const Q_MAX = 1.0;

const CAP_CONSERVATISM_BPS = 5000n; // rawCap = projected90 * 5000/10000 * haircut/10000
const BPS_DENOMINATOR = 10_000n;
const CENT_MICRO_USD = 10_000n; // 1 cent = 1e4 micro-USD (1 USD = 1e6 micro-USD)
const NOTE_DECIMALS_SCALE = 10n ** 12n; // noteSupply (1e18) = capMicroUsd (1e6) * 1e12

const MAINNET_HARD_CEILING_MICRO_USD = 25_000_000n; // $25
const DEMO_HARD_CEILING_MICRO_USD = 10_000_000_000n; // $10,000

const BASE_FLOOR_CENTS = 80;
const FLOOR_BUMP_CENTS = 5;
const MAX_FLOOR_CENTS = 95;
const LOW_HAIRCUT_FLOOR_BUMP_THRESHOLD_BPS = 7000;
const YOUNG_AGE_THRESHOLD_SECONDS = 14n * DAY_SECONDS;

const MIN_PRINCIPAL_DRAW_PERIODS = 14n;
const MIN_DRAW_LIMIT_USDC_WEI = 100_000n;

const DEFAULT_DRAW_PERIOD_SECONDS = 86_400;
const DEFAULT_GRACE_PERIOD_SECONDS = 14 * 86_400;
const MAINNET_AUCTION_BLOCKS = 1000n;
const DEMO_AUCTION_BLOCKS = 250n;
/** Auction durations must divide this many blocks-mps (plan 00 constraint). */
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

/**
 * Pure underwriting math: 90-day revenue projection, quality haircut applied, cap +
 * floor + draw terms derived. Every output is bigint (money) or integer bps/seconds/
 * cents — the only floats used internally (decay retention `q`, the geometric-sum
 * multiplier) are converted back to bigint with explicit floor rounding before leaving
 * this function, per the plan-02 "no floats in money paths" constraint.
 */
export function computeTerms(
  rev: RevenueWindows,
  quality: Quality,
  env: UnderwritingEnv,
): TermsSummary & { noteSupply: bigint; auctionBlocks: bigint } {
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
  // Round cap down to whole cents.
  const capMicroUsd = (capBeforeRounding / CENT_MICRO_USD) * CENT_MICRO_USD;

  const noteSupply = capMicroUsd * NOTE_DECIMALS_SCALE;

  let floorCents = BASE_FLOOR_CENTS;
  if (haircutBps < LOW_HAIRCUT_FLOOR_BUMP_THRESHOLD_BPS) floorCents += FLOOR_BUMP_CENTS;
  if (rev.ageSeconds < YOUNG_AGE_THRESHOLD_SECONDS) floorCents += FLOOR_BUMP_CENTS;
  floorCents = Math.min(floorCents, MAX_FLOOR_CENTS);

  // minPrincipal = cap * floorCents/100 * 50/100, applied stepwise per the binding formula.
  const minPrincipalAfterFloor = (capMicroUsd * BigInt(floorCents)) / 100n;
  const minPrincipal = (minPrincipalAfterFloor * 50n) / 100n;

  const drawPeriod = env.drawPeriodSeconds ?? DEFAULT_DRAW_PERIOD_SECONDS;
  const gracePeriod = env.gracePeriodSeconds ?? DEFAULT_GRACE_PERIOD_SECONDS;

  const auctionBlocks =
    env.auctionBlocks ??
    (env.network === "mainnet" ? MAINNET_AUCTION_BLOCKS : DEMO_AUCTION_BLOCKS);
  if (auctionBlocks <= 0n || AUCTION_BLOCKS_MODULUS % auctionBlocks !== 0n) {
    throw new Error(`auctionBlocks (${auctionBlocks}) must divide 1e7`);
  }

  const drawLimit = bigintMax(minPrincipal / MIN_PRINCIPAL_DRAW_PERIODS, MIN_DRAW_LIMIT_USDC_WEI);

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
