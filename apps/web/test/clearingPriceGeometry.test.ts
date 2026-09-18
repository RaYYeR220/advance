import { describe, expect, it } from "vitest";
import { clearingPriceStepsModel } from "@/components/charts/clearingPriceGeometry";

describe("clearingPriceStepsModel", () => {
  it("lays the wide chart on a 640-wide canvas and the compact one at 380", () => {
    const steps = [{ fromBlock: 0, priceCents: 80 }, { fromBlock: 140, priceCents: 92 }];
    const wide = clearingPriceStepsModel({ compact: false, blocks: 200, floorCents: 80, steps });
    const compact = clearingPriceStepsModel({ compact: true, blocks: 200, floorCents: 80, steps });
    expect(wide.width).toBe(640);
    expect(compact.width).toBe(380);
  });

  it("holds the step path at the floor before any block elapses", () => {
    const model = clearingPriceStepsModel({ compact: false, blocks: 100, floorCents: 80, steps: [{ fromBlock: 0, priceCents: 80 }] });
    expect(model.clearing.cents).toBe(80);
  });

  it("reads the clearing price at the final elapsed step", () => {
    const model = clearingPriceStepsModel({
      compact: false,
      blocks: 200,
      floorCents: 80,
      steps: [{ fromBlock: 0, priceCents: 80 }, { fromBlock: 140, priceCents: 92 }],
    });
    expect(model.clearing.cents).toBe(92);
  });

  it("spaces ticks so a long auction still gets a readable ruler", () => {
    const model = clearingPriceStepsModel({ compact: false, blocks: 1000, floorCents: 80, steps: [{ fromBlock: 0, priceCents: 80 }] });
    expect(model.ticks.length).toBeGreaterThan(2);
    expect(model.ticks.length).toBeLessThan(20);
    expect(model.ticks[model.ticks.length - 1]?.block).toBe(1000);
  });

  it("keeps the floor gridline within the chart's plotted vertical range", () => {
    const model = clearingPriceStepsModel({
      compact: false,
      blocks: 100,
      floorCents: 80,
      steps: [{ fromBlock: 0, priceCents: 80 }, { fromBlock: 50, priceCents: 84 }],
    });
    expect(model.floorY).toBeGreaterThan(model.y0);
    expect(model.floorY).toBeLessThanOrEqual(model.y1);
  });
});
