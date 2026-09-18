import { clearingPriceAt } from "@/components/halftone/charts";
import type { AuctionStep } from "@/lib/landing-data";

/**
 * Pure geometry for the auction detail page's stepped clearing-price chart. Unlike the
 * landing's `AuctionChart` (a fixed 40-block, 10-cent-span illustration with a "your bid"
 * annotation), this scales to any auction length/price range and never assumes a bid exists —
 * the bidder's own bids are listed separately, not plotted here.
 */

export interface ClearingPriceStepsInput {
  compact: boolean;
  blocks: number;
  floorCents: number;
  /** The observable clearing-price schedule: the floor at block 0, and (once at least one
   * block has elapsed) the current observed clearing price at its elapsed block. */
  steps: readonly AuctionStep[];
}

export interface ClearingPriceStepsModel {
  width: number;
  height: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  gridlines: { y: number; cents: number }[];
  floorY: number;
  stepPath: string;
  clearing: { x: number; y: number; cents: number };
  ticks: { x: number; block: number }[];
}

/** A tick spacing that keeps the ruler to roughly 6-10 marks regardless of the auction's
 * length, rounded to a friendly multiple of 5/10/25/50/100 blocks. */
function tickStep(blocks: number): number {
  const target = Math.max(1, Math.round(blocks / 8));
  const niceSteps = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
  return niceSteps.find((s) => s >= target) ?? niceSteps[niceSteps.length - 1]!;
}

export function clearingPriceStepsModel({ compact, blocks, floorCents, steps }: ClearingPriceStepsInput): ClearingPriceStepsModel {
  const width = compact ? 380 : 640;
  const height = compact ? 260 : 280;
  const x0 = compact ? 52 : 58;
  const x1 = compact ? 366 : 602;
  const y0 = 20;
  const y1 = compact ? 200 : 218;

  const n = Math.max(1, blocks);
  const floor = floorCents / 100;
  const highCents = Math.max(floorCents, ...steps.map((s) => s.priceCents));
  const spanCents = Math.max(highCents - floorCents, 4) * 1.25;
  const span = spanCents / 100;
  const low = floor - span * 0.1;

  const px = (b: number) => x0 + (Math.min(Math.max(b, 0), n) / n) * (x1 - x0);
  const py = (p: number) => y1 - ((p - low) / span) * (y1 - y0);
  const priceAt = (b: number) => clearingPriceAt(steps, b) / 100;

  let stepPath = `M${px(0).toFixed(1)} ${py(priceAt(0)).toFixed(1)}`;
  for (let b = 1; b <= n; b++) {
    stepPath += `H${px(b).toFixed(1)}V${py(priceAt(Math.min(b, n - 1))).toFixed(1)}`;
  }

  const step = tickStep(n);
  const ticks: { x: number; block: number }[] = [];
  for (let b = 0; b <= n; b += step) ticks.push({ x: px(b), block: b });
  if (ticks[ticks.length - 1]?.block !== n) ticks.push({ x: px(n), block: n });

  const clearingCents = clearingPriceAt(steps, n - 1);

  return {
    width,
    height,
    x0,
    x1,
    y0,
    y1,
    gridlines: [0, 0.25, 0.5, 0.75, 1].map((t) => {
      const cents = Math.round(floorCents + t * spanCents);
      return { y: py(cents / 100), cents };
    }),
    floorY: py(floor),
    stepPath,
    clearing: { x: px(n), y: py(clearingCents / 100), cents: clearingCents },
    ticks,
  };
}
