/**
 * Geometry for the printed charts: the note's cap bar, the weekly repayment
 * bars, the clearing auction and the colophon's control strip. Each function
 * is pure so the same figures render identically on server and client.
 */

import { SCREEN_ANGLE, dots, duotoneSvg, svgDocument, INK } from "./screen";
import type { AuctionStep } from "@/lib/landing-data";

/* ---------- note cap bar ---------- */

export const CAP_BAR_CELL = 4.2;

/** Repaid share in forest (darker towards the start), unpaid share in ochre. */
export function capBarSvg(width: number, height: number, repaidRatio: number): string {
  const frac = Math.max(0, Math.min(1, repaidRatio));
  return duotoneSvg(width, height, CAP_BAR_CELL, (x) => {
    const p = x / width;
    if (p < frac) return [0.95 - 0.35 * (p / frac) * (p / frac), 0.25];
    return [0, 0.34];
  });
}

/** x position of the tick after each sweep, on a bar `width` wide. */
export function sweepTicks(width: number, capUsd: number, sweeps: readonly number[]): number[] {
  let total = 0;
  return sweeps.map((amount) => {
    total += amount;
    return (total / capUsd) * width;
  });
}

/* ---------- weekly repayments ---------- */

export const WEEKLY_CELL = 5.2;

export interface WeeklyGeometry {
  top: number;
  bottom: number;
  slot: number;
  barWidth: number;
  max: number;
  /** Top centre-right corner of the latest bar, where its label sits. */
  latest: { x: number; y: number; value: number };
}

export function weeklyGeometry(width: number, height: number, weeks: readonly number[]): WeeklyGeometry {
  const top = 30;
  const bottom = height - 26;
  const n = Math.max(1, weeks.length);
  const slot = width / n;
  const barWidth = slot * 0.7;
  const peak = Math.max(0, ...weeks);
  const max = Math.max(100, Math.ceil(peak / 100) * 100);
  const value = weeks[weeks.length - 1] ?? 0;
  return {
    top,
    bottom,
    slot,
    barWidth,
    max,
    latest: { x: (n - 0.5) * slot + barWidth / 2, y: bottom - (value / max) * (bottom - top), value },
  };
}

/** Ochre-only screen: bars are densest at the top and thin out towards the baseline. */
export function weeklySvg(width: number, height: number, weeks: readonly number[]): string {
  const g = weeklyGeometry(width, height, weeks);
  const path = dots(width, height, WEEKLY_CELL, SCREEN_ANGLE.forest, (x, y) => {
    const k = Math.floor(x / g.slot);
    const week = weeks[k];
    if (week === undefined) return 0;
    const cx = (k + 0.5) * g.slot;
    if (Math.abs(x - cx) > g.barWidth / 2) return 0;
    const h = (week / g.max) * (g.bottom - g.top);
    const t = g.bottom - h;
    if (y < t || y > g.bottom) return 0;
    return 0.95 - (0.55 * (y - t)) / (g.bottom - g.top);
  });
  return svgDocument(width, height, `<path fill="${INK.ochre}" d="${path}"/>`);
}

/* ---------- clearing auction ---------- */

export interface AuctionChartInput {
  compact: boolean;
  blocks: number;
  floorCents: number;
  steps: readonly AuctionStep[];
  bid: { maxPriceCents: number; atBlock: number };
}

export interface AuctionChartModel {
  width: number;
  height: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  demand: string;
  gridlines: { y: number; cents: number }[];
  floorY: number;
  stepPath: string;
  bid: { x: number; y: number };
  clearing: { x: number; y: number; cents: number };
  ticks: number[];
}

/** Price at a block: the latest step that has taken effect. */
export function clearingPriceAt(steps: readonly AuctionStep[], block: number): number {
  let cents = steps[0]?.priceCents ?? 0;
  for (const step of steps) if (block >= step.fromBlock) cents = step.priceCents;
  return cents;
}

export function auctionChartModel({ compact, blocks, floorCents, steps, bid }: AuctionChartInput): AuctionChartModel {
  const width = compact ? 380 : 640;
  const height = compact ? 300 : 330;
  const x0 = compact ? 50 : 56;
  const x1 = compact ? 368 : 600;
  const y0 = 36;
  const y1 = compact ? 232 : 262;
  const n = blocks;
  const floor = floorCents / 100;
  const low = floor - 0.02;
  const span = 0.1;
  const px = (b: number) => x0 + (b / n) * (x1 - x0);
  const py = (p: number) => y1 - ((p - low) / span) * (y1 - y0);
  const price = (b: number) => clearingPriceAt(steps, b) / 100;

  const w = x1 - x0;
  const h = y1 - y0;
  const demand = dots(w, h, 7, SCREEN_ANGLE.ochre, (x, y) => {
    const b = (x / w) * n;
    const p = low + (1 - y / h) * span;
    if (p > price(Math.min(n - 0.001, b)) || p < floor) return 0;
    return 0.12 + 0.6 * (b / n) * (1 - 0.45 * (y / h));
  });

  let stepPath = `M${px(0)} ${py(price(0))}`;
  for (let b = 1; b <= n; b++) {
    stepPath += `H${px(b).toFixed(1)}V${py(price(Math.min(b, n - 1))).toFixed(1)}`;
  }

  const ticks: number[] = [];
  for (let b = 0; b <= n; b += 5) ticks.push(px(b));

  const clearingCents = clearingPriceAt(steps, n - 1);
  return {
    width,
    height,
    x0,
    x1,
    y0,
    y1,
    demand,
    gridlines: [0, 2, 4, 6].map((d) => ({ y: py((floorCents + d) / 100), cents: floorCents + d })),
    floorY: py(floor),
    stepPath,
    bid: { x: px(bid.atBlock), y: py(bid.maxPriceCents / 100) },
    clearing: { x: px(n), y: py(clearingCents / 100), cents: clearingCents },
    ticks,
  };
}

/* ---------- colophon control strip ---------- */

export interface StripPatch {
  x: number;
  y: number;
  width: number;
  height: number;
  ink: "ochre" | "forest";
  coverage: number;
  path: string;
}

export interface StripModel {
  width: number;
  height: number;
  patches: StripPatch[];
  registration: number[];
}

/** Ten tint patches per plate, 10% to 100%, screened at each plate's angle. */
export function controlStripModel(compact: boolean): StripModel {
  const patches: StripPatch[] = [];
  for (let k = 0; k < 20; k++) {
    const ochre = k < 10;
    const i = ochre ? k : k - 10;
    const coverage = (i + 1) / 10;
    const angle = ochre ? SCREEN_ANGLE.ochre : SCREEN_ANGLE.forest;
    if (compact) {
      const pw = 34;
      const ph = 34;
      patches.push({
        x: 2 + i * (pw + 3.8),
        y: ochre ? 2 : 62,
        width: pw,
        height: ph,
        ink: ochre ? "ochre" : "forest",
        coverage,
        path: dots(pw, ph, 4.4, angle, (x, y) => (x < 2 || x > pw - 2 || y < 2 || y > 32 ? 0 : coverage)),
      });
    } else {
      const pw = 56;
      const ph = 40;
      patches.push({
        x: 72 + k * (pw + 4) + (ochre ? 0 : 16),
        y: 8,
        width: pw,
        height: ph,
        ink: ochre ? "ochre" : "forest",
        coverage,
        path: dots(pw, ph, 5, angle, (x, y) => (x < 2 || x > pw - 2 || y < 2 || y > 38 ? 0 : coverage)),
      });
    }
  }
  return compact
    ? { width: 380, height: 118, patches, registration: [] }
    : { width: 1344, height: 70, patches, registration: [26, 1318] };
}
