/**
 * A from-scratch reimplementation of the "Binding formulas" spec. Deliberately does NOT import
 * `@advance/core`'s `underwrite/{terms,quality,rules}.ts` — this is the independent
 * ground truth `deriveKey.ts` uses to build `answer-key.json`, so a shared bug between
 * this file and the engine's own formula code isn't possible by construction (a copy of
 * the engine's code would trivially "agree" with itself; this is written fresh from the
 * spec text instead).
 *
 * Every function here is pure math over plain scenario parameters — it never touches a
 * `ChainOps`/`ChainReader`/network. `run.ts` never imports this module: only
 * `deriveKey.ts` does, and only to produce the committed `answer-key.json`.
 */
import { realizedTop5Count } from "./swapMix.js";
import type { ScenarioParams } from "./types.js";

const DECAY_EXPONENT = 23;
const DECAY_MIN_BPS = 1000n;
const DECAY_MAX_BPS = 10000n;
const Q_MIN = 0.9;
const Q_MAX = 1.0;
const PROJECTION_DAYS = 90;

const CAP_CONSERVATISM_BPS = 5000n;
const BPS_DENOMINATOR = 10_000n;
const CENT_MICRO_USD = 10_000n;

const MAINNET_HARD_CEILING_MICRO_USD = 25_000_000n;
const DEMO_HARD_CEILING_MICRO_USD = 10_000_000_000n;

const BASE_FLOOR_CENTS = 80;
const FLOOR_BUMP_CENTS = 5;
const MAX_FLOOR_CENTS = 95;
const LOW_HAIRCUT_FLOOR_BUMP_THRESHOLD_BPS = 7000;
const YOUNG_AGE_THRESHOLD_SECONDS = 14n * 86_400n;
const MIN_AGE_SECONDS = 3n * 86_400n;

const MIN_PRINCIPAL_DRAW_PERIODS = 14n;
const MIN_DRAW_LIMIT_USDC_WEI = 100_000n;
const MIN_PRINCIPAL_USDC_WEI = 1_000_000n;

const CONCENTRATION_HAIRCUT_THRESHOLD = 0.6;
const WASH_HAIRCUT_THRESHOLD = 0.2;
const CV_HAIRCUT_THRESHOLD = 1.5;
const CONCENTRATION_DENY_THRESHOLD = 0.8;
const WASH_DENY_THRESHOLD = 0.5;

const CONCENTRATION_HAIRCUT_FACTOR_BPS = 6000;
const WASH_HAIRCUT_FACTOR_BPS = 5000;
const AGE_HAIRCUT_FACTOR_BPS = 7000;
const CV_HAIRCUT_FACTOR_BPS = 8000;

const WETH_USD_SCALE = 10n ** 20n; // wei(1e18) * chainlink(1e8) / microUsd(1e6)

function bigintMin3(a: bigint, b: bigint, c: bigint): bigint {
  return a < b ? (a < c ? a : c) : b < c ? b : c;
}

function clampBigint(x: bigint, lo: bigint, hi: bigint): bigint {
  return x < lo ? lo : x > hi ? hi : x;
}

function clampNumber(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function weiToMicroUsd(wei: bigint, answer: bigint): bigint {
  return (wei * answer) / WETH_USD_SCALE;
}

function sum(values: readonly bigint[]): bigint {
  return values.reduce((a, b) => a + b, 0n);
}

function floorHaircutStep(haircutBps: number, factorBps: number): number {
  return Math.floor((haircutBps * factorBps) / 10_000);
}

function computeCvIndependent(buckets: readonly bigint[]): number | undefined {
  if (buckets.length < 2) return undefined;
  const values = buckets.map((b) => Number(b));
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean <= 0) return undefined;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

export interface DrawTerms {
  minPrincipal: bigint;
  drawLimit: bigint;
}

export function deriveDrawTermsIndependent(capMicroUsd: bigint, floorCents: number): DrawTerms {
  const minPrincipalAfterFloor = (capMicroUsd * BigInt(floorCents)) / 100n;
  const minPrincipal = (minPrincipalAfterFloor * 50n) / 100n;
  const drawLimit =
    minPrincipal / MIN_PRINCIPAL_DRAW_PERIODS > MIN_DRAW_LIMIT_USDC_WEI
      ? minPrincipal / MIN_PRINCIPAL_DRAW_PERIODS
      : MIN_DRAW_LIMIT_USDC_WEI;
  return { minPrincipal, drawLimit };
}

export interface IndependentFormulaResult {
  revenueMicroUsd: { d1: bigint; d7: bigint; d30: bigint };
  r1: bigint;
  r7: bigint;
  r30: bigint;
  base: bigint;
  decayBps: bigint;
  q: number;
  sumQ: number;
  projected90dMicroUsd: bigint;
  top5ConcentrationRatio: number;
  washRatio: number;
  cv: number | undefined;
  haircutSteps: { concentration: number; wash: number; age: number; cv: number };
  haircutBps: number;
  rawCap: bigint;
  hardCeilingMicroUsd: bigint;
  capMicroUsd: bigint;
  floorCents: number;
  minPrincipal: bigint;
  drawLimit: bigint;
  /** Hard-rule + terms-derived deny reasons, evaluated purely from the formula inputs
   * (mirrors `applyRules` + `termsDenyReasons`, independently). Pool-shape rules
   * (not_bankr_doppler / not_weth_pool / pool_not_locked) are NOT included here — those
   * are decided by discovery/pool-state, evaluated separately in `deriveKey.ts`. */
  ruleDenyReasons: string[];
}

/**
 * Computes every number `computeTerms`/`computeQuality`/`applyRules`/`termsDenyReasons`
 * would, from raw scenario parameters, using code written fresh from the spec text.
 */
export function computeIndependentFormula(scenario: ScenarioParams): IndependentFormulaResult {
  const d1Wei = scenario.dailyFeesWei[0]!;
  const d7Wei = sum(scenario.dailyFeesWei.slice(0, 7));
  const d30Wei = sum(scenario.dailyFeesWei.slice(0, 30));

  const creatorD1Wei = (d1Wei * scenario.creatorSharesWad) / 10n ** 18n;
  const creatorD7Wei = (d7Wei * scenario.creatorSharesWad) / 10n ** 18n;
  const creatorD30Wei = (d30Wei * scenario.creatorSharesWad) / 10n ** 18n;

  const revenueMicroUsd = {
    d1: weiToMicroUsd(creatorD1Wei, scenario.ethUsdAnswerE8),
    d7: weiToMicroUsd(creatorD7Wei, scenario.ethUsdAnswerE8),
    d30: weiToMicroUsd(creatorD30Wei, scenario.ethUsdAnswerE8),
  };

  const r1 = revenueMicroUsd.d1;
  const r7 = revenueMicroUsd.d7 / 7n;
  const r30 = revenueMicroUsd.d30 / 30n;
  const base = bigintMin3(r7, r30, (r1 + r7) / 2n);

  const decayBps = clampBigint(
    (BPS_DENOMINATOR * r7) / (r30 > 0n ? r30 : 1n),
    DECAY_MIN_BPS,
    DECAY_MAX_BPS,
  );
  const q = clampNumber((Number(decayBps) / 10_000) ** (1 / DECAY_EXPONENT), Q_MIN, Q_MAX);
  let sumQ = 0;
  let qPow = 1;
  for (let d = 0; d < PROJECTION_DAYS; d++) {
    sumQ += qPow;
    qPow *= q;
  }
  const projected90dMicroUsd = BigInt(Math.floor(Number(base) * sumQ));

  const swapCount = scenario.swaps.swapCount;
  const top5ConcentrationRatio = swapCount > 0 ? realizedTop5Count(scenario.swaps) / swapCount : 0;
  const washRatio = swapCount > 0 ? scenario.swaps.washCount / swapCount : 0;

  const creatorBucketsWei = scenario.dailyFeesWei
    .slice(0, 7)
    .map((wei) => (wei * scenario.creatorSharesWad) / 10n ** 18n);
  const cv = computeCvIndependent(creatorBucketsWei);

  let haircutBps = 10_000;
  const steps = { concentration: haircutBps, wash: 0, age: 0, cv: 0 };
  if (top5ConcentrationRatio > CONCENTRATION_HAIRCUT_THRESHOLD) {
    haircutBps = floorHaircutStep(haircutBps, CONCENTRATION_HAIRCUT_FACTOR_BPS);
  }
  steps.concentration = haircutBps;
  if (washRatio > WASH_HAIRCUT_THRESHOLD) {
    haircutBps = floorHaircutStep(haircutBps, WASH_HAIRCUT_FACTOR_BPS);
  }
  steps.wash = haircutBps;
  if (scenario.ageSeconds < YOUNG_AGE_THRESHOLD_SECONDS) {
    haircutBps = floorHaircutStep(haircutBps, AGE_HAIRCUT_FACTOR_BPS);
  }
  steps.age = haircutBps;
  if (cv !== undefined && cv > CV_HAIRCUT_THRESHOLD) {
    haircutBps = floorHaircutStep(haircutBps, CV_HAIRCUT_FACTOR_BPS);
  }
  steps.cv = haircutBps;

  const capAfterConservatism = (projected90dMicroUsd * CAP_CONSERVATISM_BPS) / BPS_DENOMINATOR;
  const rawCap = (capAfterConservatism * BigInt(haircutBps)) / BPS_DENOMINATOR;

  const hardCeilingMicroUsd =
    scenario.network === "mainnet" ? MAINNET_HARD_CEILING_MICRO_USD : DEMO_HARD_CEILING_MICRO_USD;
  const capBeforeRounding = rawCap < hardCeilingMicroUsd ? rawCap : hardCeilingMicroUsd;
  const capMicroUsd = (capBeforeRounding / CENT_MICRO_USD) * CENT_MICRO_USD;

  let floorCents = BASE_FLOOR_CENTS;
  if (haircutBps < LOW_HAIRCUT_FLOOR_BUMP_THRESHOLD_BPS) floorCents += FLOOR_BUMP_CENTS;
  if (scenario.ageSeconds < YOUNG_AGE_THRESHOLD_SECONDS) floorCents += FLOOR_BUMP_CENTS;
  floorCents = Math.min(floorCents, MAX_FLOOR_CENTS);

  const { minPrincipal, drawLimit } = deriveDrawTermsIndependent(capMicroUsd, floorCents);

  const ruleDenyReasons: string[] = [];
  if (scenario.creatorSharesWad === 0n) ruleDenyReasons.push("creator_has_no_shares");
  if (scenario.ageSeconds < MIN_AGE_SECONDS) ruleDenyReasons.push("too_young");
  if (revenueMicroUsd.d7 === 0n) ruleDenyReasons.push("no_recent_revenue");
  if (washRatio > WASH_DENY_THRESHOLD) ruleDenyReasons.push("wash_trading");
  if (top5ConcentrationRatio > CONCENTRATION_DENY_THRESHOLD) ruleDenyReasons.push("concentrated_flow");
  if (minPrincipal < MIN_PRINCIPAL_USDC_WEI) ruleDenyReasons.push("below_minimum");

  return {
    revenueMicroUsd,
    r1,
    r7,
    r30,
    base,
    decayBps,
    q,
    sumQ,
    projected90dMicroUsd,
    top5ConcentrationRatio,
    washRatio,
    cv,
    haircutSteps: steps,
    haircutBps,
    rawCap,
    hardCeilingMicroUsd,
    capMicroUsd,
    floorCents,
    minPrincipal,
    drawLimit,
    ruleDenyReasons,
  };
}

/** Applies a scripted memo's numeric effect to already-computed (independent) terms,
 * matching `mergeMemo`'s tighten-only clamp — independently, for `deriveKey.ts` to predict
 * the expected *final* (post-memo) cap/floor/drawLimit band for an approval scenario. */
export function applyIndependentMemo(
  terms: IndependentFormulaResult,
  capMultiplierBpsRaw: number,
  floorCentsDeltaRaw: number,
): { capMicroUsd: bigint; floorCents: number; minPrincipal: bigint; drawLimit: bigint; belowMinimum: boolean } {
  const capMultiplierBps = Math.min(10_000, Math.max(0, capMultiplierBpsRaw));
  const floorCentsDelta = Math.max(0, floorCentsDeltaRaw);

  const capMicroUsdRaw = (terms.capMicroUsd * BigInt(capMultiplierBps)) / 10_000n;
  const capMicroUsd = (capMicroUsdRaw / CENT_MICRO_USD) * CENT_MICRO_USD;
  const floorCents = Math.min(terms.floorCents + floorCentsDelta, MAX_FLOOR_CENTS);
  const recomputed = deriveDrawTermsIndependent(capMicroUsd, floorCents);
  const drawLimit = recomputed.drawLimit < terms.drawLimit ? recomputed.drawLimit : terms.drawLimit;

  return {
    capMicroUsd,
    floorCents,
    minPrincipal: recomputed.minPrincipal,
    drawLimit,
    belowMinimum: recomputed.minPrincipal < MIN_PRINCIPAL_USDC_WEI,
  };
}
