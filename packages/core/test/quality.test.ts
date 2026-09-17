import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { computeQuality, type QualityContext } from "../src/underwrite/quality.js";
import type { SwapRecord } from "../src/sources/chain.js";

const CREATOR: Address = "0xC0FFEEc0ffEec0FfeEc0ffEEc0FfEec0ffeEC0FF";
const DAY = 86_400n;

function addr(n: number): Address {
  return `0x${n.toString(16).padStart(40, "0")}` as Address;
}

/** Minimal `SwapRecord` stub — only `from` matters for `computeQuality`. */
function swap(from: Address): SwapRecord {
  return {
    poolId: "0x0000000000000000000000000000000000000000000000000000000000000000",
    sender: from,
    from,
    amount0: 0n,
    amount1: 0n,
    sqrtPriceX96: 0n,
    liquidity: 0n,
    tick: 0,
    fee: 0,
    blockNumber: 0n,
    transactionHash: "0x00",
    logIndex: 0,
  };
}

function swaps(from: Address, n: number): SwapRecord[] {
  return Array.from({ length: n }, () => swap(from));
}

function baseCtx(overrides: Partial<QualityContext> = {}): QualityContext {
  return {
    creator: CREATOR,
    ageSeconds: 20n * DAY,
    recentDailyRevenue: [],
    ...overrides,
  };
}

describe("computeQuality", () => {
  it("no swaps, old token, no buckets -> no haircut at all (10000 bps)", () => {
    const q = computeQuality([], baseCtx());
    expect(q.swapCount).toBe(0);
    expect(q.top5ConcentrationRatio).toBe(0);
    expect(q.washRatio).toBe(0);
    expect(q.cv).toBeUndefined();
    expect(q.haircutBps).toBe(10000);
  });

  it("top-5 concentration 100% (>60%) -> x0.6 haircut (6000 bps), no other signal", () => {
    const s = [...swaps(addr(1), 7), ...swaps(addr(2), 1), ...swaps(addr(3), 1), ...swaps(addr(4), 1)];
    const q = computeQuality(s, baseCtx());
    expect(q.top5ConcentrationRatio).toBe(1);
    expect(q.washRatio).toBe(0);
    expect(q.haircutBps).toBe(6000);
  });

  it("wash ratio 30% (>20%, concentration kept at 50% to isolate) -> x0.5 haircut (5000 bps)", () => {
    const others = Array.from({ length: 14 }, (_, i) => swap(addr(i + 1)));
    const s = [...swaps(CREATOR, 6), ...others];
    const q = computeQuality(s, baseCtx());
    expect(q.top5ConcentrationRatio).toBe(0.5);
    expect(q.washRatio).toBeCloseTo(0.3);
    expect(q.haircutBps).toBe(5000);
  });

  it("age < 14d, concentration kept at 50% to isolate -> x0.7 haircut (7000 bps)", () => {
    const s = Array.from({ length: 10 }, (_, i) => swap(addr(i + 1)));
    const q = computeQuality(s, baseCtx({ ageSeconds: 5n * DAY }));
    expect(q.top5ConcentrationRatio).toBe(0.5);
    expect(q.haircutBps).toBe(7000);
  });

  it("CV > 1.5 across daily buckets, no swap signal -> x0.8 haircut (8000 bps)", () => {
    const q = computeQuality([], baseCtx({ recentDailyRevenue: [0n, 0n, 0n, 0n, 0n, 0n, 700_000n] }));
    expect(q.cv).toBeGreaterThan(1.5);
    expect(q.cv).toBeCloseTo(2.449489742783178, 10);
    expect(q.haircutBps).toBe(8000);
  });

  it("cv is undefined with fewer than 2 buckets", () => {
    const q = computeQuality([], baseCtx({ recentDailyRevenue: [500n] }));
    expect(q.cv).toBeUndefined();
    expect(q.haircutBps).toBe(10000);
  });

  it("cv is undefined when every bucket is zero (non-positive mean), not treated as high volatility", () => {
    const q = computeQuality([], baseCtx({ recentDailyRevenue: [0n, 0n, 0n, 0n, 0n, 0n, 0n] }));
    expect(q.cv).toBeUndefined();
    expect(q.haircutBps).toBe(10000);
  });

  it("all four haircuts compound multiplicatively, floored down to an integer (1680 bps, not 1681)", () => {
    const others = Array.from({ length: 5 }, (_, i) => swap(addr(i + 1)));
    const s = [...swaps(CREATOR, 15), ...others];
    const q = computeQuality(
      s,
      baseCtx({ ageSeconds: 5n * DAY, recentDailyRevenue: [0n, 0n, 0n, 0n, 0n, 0n, 700_000n] }),
    );
    expect(q.top5ConcentrationRatio).toBeGreaterThan(0.6);
    expect(q.washRatio).toBeGreaterThan(0.2);
    expect(q.cv).toBeGreaterThan(1.5);
    // 0.6 * 0.5 * 0.7 * 0.8 = 0.168 exactly in floating point -> floor(1680.0) = 1680.
    expect(q.haircutBps).toBe(1680);
  });

  it("wash-trading signal is exactly tx.from === creator (case-insensitive), not sender", () => {
    const s = [{ ...swap(addr(9)), sender: CREATOR }]; // sender is the creator, tx.from is not
    const q = computeQuality(s, baseCtx());
    expect(q.washRatio).toBe(0);
  });
});
