import { describe, expect, it } from "vitest";
import { MIN_LEADER, PIN_CLEARANCE, leaderLine, placeLabel } from "@/components/editorial/callout-geometry";

describe("placeLabel", () => {
  const figure = { width: 720, height: 728 };
  const label = { width: 212, height: 82 };

  it("puts the label at its preferred corner when it fits", () => {
    const box = placeLabel({ x: 0.03, y: 0.33 }, label, figure);
    expect(box.left).toBeCloseTo(21.6, 9);
    expect(box.top).toBeCloseTo(240.24, 9);
    expect([box.width, box.height]).toEqual([212, 82]);
  });

  it("keeps the label a margin inside the figure", () => {
    const box = placeLabel({ x: 0.95, y: 0.99 }, label, figure);
    expect(box.left).toBe(720 - 212 - 12);
    expect(box.top).toBe(728 - 82 - 12);
    expect(placeLabel({ x: 0, y: 0 }, label, figure)).toMatchObject({ left: 12, top: 12 });
  });
});

describe("leaderLine", () => {
  const box = { left: 100, top: 100, width: 200, height: 80 };

  it("runs from the pin rim to the nearest point on the label", () => {
    const line = leaderLine({ x: 400, y: 140 }, box);
    expect(line).toEqual({ x1: 400 - PIN_CLEARANCE, y1: 140, x2: 300, y2: 140 });
  });

  it("aims at the closest corner when the pin is off both axes", () => {
    const line = leaderLine({ x: 330, y: 220 }, box);
    expect(line?.x2).toBe(300);
    expect(line?.y2).toBe(180);
    const len = Math.hypot((line?.x1 ?? 0) - 330, (line?.y1 ?? 0) - 220);
    expect(len).toBeCloseTo(PIN_CLEARANCE, 9);
  });

  it("draws nothing when the pin sits on or beside the label", () => {
    expect(leaderLine({ x: 150, y: 150 }, box)).toBeNull();
    expect(leaderLine({ x: 300 + MIN_LEADER, y: 150 }, box)).toBeNull();
  });
});
