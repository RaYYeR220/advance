import { formatPercent } from "./format";
import type { Quality } from "./scoreTypes";

/**
 * Mirrors the four haircut thresholds `packages/core/src/underwrite/quality.ts`'s
 * `computeQuality` applies, so the score page can show *why* a token's multiplier fell below
 * 100% without re-deriving the formula. `packages/core` doesn't export these constants — they
 * only ever change alongside `ENGINE_VERSION`, so keeping a documented copy here (rather than
 * a new cross-package dependency for four numbers) is the smaller risk.
 */
export const HAIRCUT_THRESHOLDS = {
  concentration: 0.6,
  wash: 0.2,
  ageDays: 14,
  cv: 1.5,
} as const;

export interface HaircutFactor {
  id: "concentration" | "wash" | "age" | "volatility";
  label: string;
  /** The measured value, formatted for display. */
  measured: string;
  /** The threshold past which this factor fires, formatted for display. */
  threshold: string;
  /** Whether this factor fired for the token being scored. */
  fired: boolean;
  /** The multiplier applied when this factor fires (e.g. `"×0.60"`). */
  multiplier: string;
}

const DAY_SECONDS = 86_400;

/** The per-factor haircut breakdown for one token's quality reading — pure and independent of
 * `haircutBps` itself (which is the already-combined result), so this can explain the combined
 * number without recomputing it. */
export function haircutFactors(quality: Pick<Quality, "top5ConcentrationRatio" | "washRatio" | "cv">, ageSeconds: bigint): HaircutFactor[] {
  const ageDays = Number(ageSeconds) / DAY_SECONDS;
  const concentrationFired = quality.top5ConcentrationRatio > HAIRCUT_THRESHOLDS.concentration;
  const washFired = quality.washRatio > HAIRCUT_THRESHOLDS.wash;
  const ageFired = ageDays < HAIRCUT_THRESHOLDS.ageDays;
  const cvFired = quality.cv !== undefined && quality.cv > HAIRCUT_THRESHOLDS.cv;

  return [
    {
      id: "concentration",
      label: "Top-5 wallet concentration",
      measured: `${formatPercent(quality.top5ConcentrationRatio)}% of swaps`,
      threshold: `over ${Math.round(HAIRCUT_THRESHOLDS.concentration * 100)}%`,
      fired: concentrationFired,
      multiplier: "×0.60",
    },
    {
      id: "wash",
      label: "Wash trades from the creator",
      measured: `${formatPercent(quality.washRatio)}% of swaps`,
      threshold: `over ${Math.round(HAIRCUT_THRESHOLDS.wash * 100)}%`,
      fired: washFired,
      multiplier: "×0.50",
    },
    {
      id: "age",
      label: "Token age",
      measured: `${ageDays.toFixed(1)} days`,
      threshold: `under ${HAIRCUT_THRESHOLDS.ageDays} days`,
      fired: ageFired,
      multiplier: "×0.70",
    },
    {
      id: "volatility",
      label: "Day-to-day revenue volatility",
      measured: quality.cv === undefined ? "not enough data" : quality.cv.toFixed(2),
      threshold: `over ${HAIRCUT_THRESHOLDS.cv.toFixed(1)}`,
      fired: cvFired,
      multiplier: "×0.80",
    },
  ];
}
