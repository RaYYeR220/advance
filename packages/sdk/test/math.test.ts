import { describe, expect, it } from "vitest";
import { TICK_SPACING_Q96, bidCurrencyCeiling, centsToQ96, q96ToCents } from "../src/contracts.js";

describe("TICK_SPACING_Q96", () => {
  it("matches AdvanceHub's on-chain constant: uint256(1e4 << 96) / 1e18", () => {
    expect(TICK_SPACING_Q96).toBe((10_000n << 96n) / 10n ** 18n);
  });
});

describe("centsToQ96 / q96ToCents", () => {
  it("round-trips whole-cent prices", () => {
    for (const cents of [1, 50, 80, 95, 100, 250]) {
      expect(q96ToCents(centsToQ96(cents))).toBe(cents);
    }
  });

  it("centsToQ96(0) is 0", () => {
    expect(centsToQ96(0)).toBe(0n);
  });

  it("rejects a non-integer or negative cents value", () => {
    expect(() => centsToQ96(1.5)).toThrow(/non-negative integer/);
    expect(() => centsToQ96(-1)).toThrow(/non-negative integer/);
  });

  it("q96ToCents rejects a price that isn't a multiple of the tick spacing", () => {
    expect(() => q96ToCents(centsToQ96(80) + 1n)).toThrow(/not a multiple/);
  });
});

describe("bidCurrencyCeiling", () => {
  it("is the least integer >= notes * priceQ96 / Q96 (the exact-division case)", () => {
    // priceQ96 = Q96 exactly (1.0) makes notes * priceQ96 / Q96 == notes with no remainder, so
    // the ceiling must equal the plain product with no rounding up.
    const notes = 12_345n;
    const priceQ96 = 1n << 96n;
    expect(bidCurrencyCeiling(notes, priceQ96)).toBe(notes);
  });

  it("rounds up rather than truncating a fractional remainder", () => {
    const priceQ96 = 1n << 96n; // exactly 1.0 in Q96
    // notes chosen so notes * priceQ96 / Q96 has no remainder ordinarily; shift priceQ96 down by
    // 1 wei to force a non-exact division and confirm ceiling (not floor) behavior.
    const notes = 3n;
    const price = priceQ96 / 2n + 1n; // not an exact divisor relationship with notes
    const floor = (notes * price) / (1n << 96n);
    const result = bidCurrencyCeiling(notes, price);
    expect(result).toBeGreaterThanOrEqual(floor);
    expect(result * (1n << 96n)).toBeGreaterThanOrEqual(notes * price);
  });

  it("returns 0 for a zero bid", () => {
    expect(bidCurrencyCeiling(0n, centsToQ96(80))).toBe(0n);
  });
});
