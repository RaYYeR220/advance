import { describe, expect, it } from "vitest";
import {
  addressPrefix,
  formatBlock,
  formatCents,
  formatInteger,
  formatMultiple,
  formatPercent,
  formatUsd,
  formatUsdc,
  shortAddress,
  shortHash,
} from "@/lib/format";

describe("formatUsd", () => {
  it("drops cents on whole amounts by default", () => {
    expect(formatUsd(312)).toBe("$312");
    expect(formatUsd(4180)).toBe("$4,180");
    expect(formatUsd(0)).toBe("$0");
  });

  it("keeps two decimals on fractional amounts", () => {
    expect(formatUsd(241.8)).toBe("$241.80");
    expect(formatUsd(92.3)).toBe("$92.30");
    expect(formatUsd(1234567.891)).toBe("$1,234,567.89");
  });

  it("can force cents", () => {
    expect(formatUsd(1, { cents: true })).toBe("$1.00");
    expect(formatUsd(40, { cents: true })).toBe("$40.00");
  });

  it("can force whole dollars", () => {
    expect(formatUsd(96.4, { cents: false })).toBe("$96");
  });

  it("puts the sign before the dollar mark", () => {
    expect(formatUsd(-5)).toBe("-$5");
    expect(formatUsd(-0.5)).toBe("-$0.50");
  });

  it("does not print negative zero", () => {
    expect(formatUsd(-0)).toBe("$0");
    expect(formatUsd(-0.001)).toBe("$0.00");
  });

  it("rejects non-finite amounts", () => {
    expect(() => formatUsd(Number.NaN)).toThrow(RangeError);
    expect(() => formatUsd(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("formatCents", () => {
  it("renders a price in cents as dollars", () => {
    expect(formatCents(84)).toBe("$0.84");
    expect(formatCents(80)).toBe("$0.80");
    expect(formatCents(100)).toBe("$1.00");
    expect(formatCents(12_345)).toBe("$123.45");
  });

  it("rejects fractional cents", () => {
    expect(() => formatCents(84.5)).toThrow(RangeError);
  });
});

describe("integers and blocks", () => {
  it("groups thousands", () => {
    expect(formatInteger(31204)).toBe("31,204");
    expect(formatInteger(7)).toBe("7");
  });

  it("formats block numbers from number or bigint", () => {
    expect(formatBlock(18_204_090)).toBe("18,204,090");
    expect(formatBlock(18_204_113n)).toBe("18,204,113");
    expect(formatBlock(123_456_789_012_345_678n)).toBe("123,456,789,012,345,678");
  });

  it("rejects negative or fractional blocks", () => {
    expect(() => formatBlock(-1)).toThrow(RangeError);
    expect(() => formatBlock(1.5)).toThrow(RangeError);
  });
});

describe("formatUsdc", () => {
  it("always shows two decimals with the unit", () => {
    expect(formatUsdc(900)).toBe("900.00 USDC");
    expect(formatUsdc(40)).toBe("40.00 USDC");
    expect(formatUsdc(1250.5)).toBe("1,250.50 USDC");
  });

  it("can omit the unit", () => {
    expect(formatUsdc(0, { unit: false })).toBe("0.00");
  });
});

describe("formatMultiple and formatPercent", () => {
  it("prints a cap multiple with two decimals", () => {
    expect(formatMultiple(1.19)).toBe("1.19");
    expect(formatMultiple(1.25)).toBe("1.25");
    expect(formatMultiple(2)).toBe("2.00");
  });

  it("prints a whole percent from a ratio", () => {
    expect(formatPercent(241.8 / 372)).toBe("65");
    expect(formatPercent(1)).toBe("100");
    expect(formatPercent(0)).toBe("0");
  });
});

describe("addresses and hashes", () => {
  const address = "0x3F2C5a0e1b7d44c8a9b2e6f01d3c7a8b5e4d9e11";
  const hash = "0x5e1d4b7a0c2e9f8d6b3a1c5e7f9d2b4a6c8e0f1a3b5d7c9e1f2a4b6c8d0ea94c";

  it("shortens an address to head and tail with an ellipsis", () => {
    expect(shortAddress(address)).toBe("0x3f2c…9e11");
    expect(shortAddress(address, { head: 6, tail: 4 })).toBe("0x3f2c5a…9e11");
  });

  it("shortens a transaction hash the same way", () => {
    expect(shortHash(hash)).toBe("0x5e1d…a94c");
  });

  it("returns the series prefix of an address", () => {
    expect(addressPrefix(address)).toBe("0x3f2c");
  });

  it("rejects malformed addresses", () => {
    expect(() => shortAddress("0x123")).toThrow(TypeError);
    expect(() => shortAddress("3f2c5a0e1b7d44c8a9b2e6f01d3c7a8b5e4d9e11")).toThrow(TypeError);
    expect(() => shortHash("0xzz")).toThrow(TypeError);
  });
});
