import type { SwapMix } from "./types.js";

/** Swaps that go to neither the creator nor a named "whale" — each a unique one-off
 * address, exactly like `quality.ts`'s `sortedCounts` treats any other long-tail sender. */
export function longTailCount(mix: SwapMix): number {
  return mix.swapCount - mix.washCount - mix.whaleCounts.reduce((a, b) => a + b, 0);
}

/**
 * The REAL top-5 concentration count a swap mix produces — computed the same way
 * `quality.ts` does (sort every distinct sender's count descending, sum the top 5) rather
 * than assumed from `washCount`/`whaleCounts` alone. This matters whenever fewer than 5
 * named addresses (creator + up to 4 whales) are active: quality.ts's `sortedCounts` still
 * has 5 slots to fill, and it fills any that the named group leaves empty with the
 * highest-count long-tail addresses (each count 1) — so e.g. a wash-only mix (washCount>0,
 * no whales) realizes `washCount + min(4, longTailCount)`, not `washCount` alone. Using
 * this function (instead of a hand-picked target) is what keeps `independentFormula.ts`'s
 * expected ratio honest and in sync with what `fakes.ts` actually generates.
 */
export function realizedTop5Count(mix: SwapMix): number {
  const named = [...(mix.washCount > 0 ? [mix.washCount] : []), ...mix.whaleCounts.filter((c) => c > 0)];
  const tail = Math.max(0, longTailCount(mix));
  const all = [...named, ...new Array(tail).fill(1)].sort((a, b) => b - a);
  return all.slice(0, 5).reduce((a, b) => a + b, 0);
}

/** Splits `total` as evenly as possible across `parts` whale slots (largest remainder
 * first), for scenario authoring convenience. */
export function evenSplit(total: number, parts: number): number[] {
  const per = Math.floor(total / parts);
  const remainder = total - per * parts;
  return Array.from({ length: parts }, (_, i) => per + (i < remainder ? 1 : 0)).filter((c) => c > 0);
}
