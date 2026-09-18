import { describe, expect, it } from "vitest";
import { HAIRCUT_THRESHOLDS, haircutFactors } from "@/lib/haircut";

const DAY = 86_400;

describe("haircutFactors", () => {
  it("marks nothing as fired for a clean, established, low-volatility token", () => {
    const factors = haircutFactors({ top5ConcentrationRatio: 0.3, washRatio: 0, cv: 0.4 }, BigInt(30 * DAY));
    expect(factors.every((f) => !f.fired)).toBe(true);
  });

  it("fires concentration strictly above its threshold, not at it", () => {
    const atThreshold = haircutFactors({ top5ConcentrationRatio: HAIRCUT_THRESHOLDS.concentration, washRatio: 0, cv: undefined }, BigInt(30 * DAY));
    expect(atThreshold.find((f) => f.id === "concentration")?.fired).toBe(false);

    const overThreshold = haircutFactors({ top5ConcentrationRatio: HAIRCUT_THRESHOLDS.concentration + 0.01, washRatio: 0, cv: undefined }, BigInt(30 * DAY));
    expect(overThreshold.find((f) => f.id === "concentration")?.fired).toBe(true);
  });

  it("fires wash trading above its threshold", () => {
    const factors = haircutFactors({ top5ConcentrationRatio: 0, washRatio: 0.21, cv: undefined }, BigInt(30 * DAY));
    expect(factors.find((f) => f.id === "wash")?.fired).toBe(true);
  });

  it("fires age for anything under the threshold, in days", () => {
    const young = haircutFactors({ top5ConcentrationRatio: 0, washRatio: 0, cv: undefined }, BigInt(3 * DAY));
    expect(young.find((f) => f.id === "age")?.fired).toBe(true);
    expect(young.find((f) => f.id === "age")?.measured).toBe("3.0 days");

    const established = haircutFactors({ top5ConcentrationRatio: 0, washRatio: 0, cv: undefined }, BigInt(20 * DAY));
    expect(established.find((f) => f.id === "age")?.fired).toBe(false);
  });

  it("never fires volatility when cv is undefined, and labels it as missing data", () => {
    const factors = haircutFactors({ top5ConcentrationRatio: 0, washRatio: 0, cv: undefined }, BigInt(30 * DAY));
    const volatility = factors.find((f) => f.id === "volatility");
    expect(volatility?.fired).toBe(false);
    expect(volatility?.measured).toBe("not enough data");
  });

  it("fires volatility above its threshold when cv is present", () => {
    const factors = haircutFactors({ top5ConcentrationRatio: 0, washRatio: 0, cv: 1.51 }, BigInt(30 * DAY));
    expect(factors.find((f) => f.id === "volatility")?.fired).toBe(true);
  });

  it("always returns exactly the four documented factors, in order", () => {
    const factors = haircutFactors({ top5ConcentrationRatio: 0, washRatio: 0, cv: undefined }, 0n);
    expect(factors.map((f) => f.id)).toEqual(["concentration", "wash", "age", "volatility"]);
  });
});
