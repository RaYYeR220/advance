import { describe, expect, it } from "vitest";
import {
  auctionChartModel,
  capBarSvg,
  clearingPriceAt,
  controlStripModel,
  sweepTicks,
  weeklyGeometry,
  weeklySvg,
} from "@/components/halftone/charts";
import { SCENE_IDS, sceneCell, sceneSvg } from "@/components/halftone/scenes";
import { landingFixture } from "./landing-fixture";

const { auction } = landingFixture.audiences;

describe("clearing auction", () => {
  it("holds each price until the next step", () => {
    expect(clearingPriceAt(auction.steps, 0)).toBe(80);
    expect(clearingPriceAt(auction.steps, 7.99)).toBe(80);
    expect(clearingPriceAt(auction.steps, 8)).toBe(81);
    expect(clearingPriceAt(auction.steps, 29)).toBe(83);
    expect(clearingPriceAt(auction.steps, 39)).toBe(84);
  });

  it("lays the wide chart out on a 640 by 330 canvas", () => {
    const m = auctionChartModel({ compact: false, ...auction });
    expect([m.width, m.height, m.x0, m.x1, m.y0, m.y1]).toEqual([640, 330, 56, 600, 36, 262]);
    expect(m.gridlines.map((g) => g.cents)).toEqual([80, 82, 84, 86]);
    expect(m.floorY).toBeCloseTo(262 - 0.2 * 226, 9);
    expect(m.clearing).toEqual({ x: 600, y: expect.closeTo(262 - 0.6 * 226, 9), cents: 84 });
    expect(m.bid.x).toBeCloseTo(56 + (12 / 40) * 544, 9);
    expect(m.ticks).toHaveLength(9);
    expect(m.stepPath.startsWith("M56 ")).toBe(true);
    expect((m.stepPath.match(/H/g) ?? []).length).toBe(40);
  });

  it("uses a narrower canvas on single-column layouts", () => {
    const m = auctionChartModel({ compact: true, ...auction });
    expect([m.width, m.height, m.x0, m.x1, m.y1]).toEqual([380, 300, 50, 368, 232]);
  });

  it("puts demand dots only under the clearing price", () => {
    const m = auctionChartModel({ compact: false, ...auction });
    expect(m.demand.length).toBeGreaterThan(1000);
    for (const match of m.demand.matchAll(/M([-\d.]+) ([-\d.]+)a/g)) {
      const y = Number(match[2]);
      expect(y).toBeGreaterThan(226 * 0.4 - 8);
    }
  });
});

describe("cap bar", () => {
  it("ticks once per sweep, proportional to the cap", () => {
    const ticks = sweepTicks(400, 100, [10, 15, 25]);
    expect(ticks).toEqual([40, 100, 200]);
  });

  it("prints forest only over the repaid share", () => {
    const svg = capBarSvg(200, 30, 0.5);
    const forest = svg.match(/fill="#173F35"[^>]*d="([^"]*)"/)?.[1] ?? "";
    const xs = [...forest.matchAll(/M([-\d.]+) /g)].map((m) => Number(m[1]));
    expect(xs.length).toBeGreaterThan(0);
    expect(Math.max(...xs)).toBeLessThan(105);
  });
});

describe("weekly bars", () => {
  it("rounds the scale up to the next hundred", () => {
    const g = weeklyGeometry(420, 294, landingFixture.economy.weeklyRepaidUsd);
    expect(g.max).toBe(800);
    expect(g.slot).toBe(35);
    expect(g.latest.value).toBe(775);
    expect(g.latest.y).toBeCloseTo(268 - (775 / 800) * 238, 9);
  });

  it("is deterministic", () => {
    const weeks = landingFixture.economy.weeklyRepaidUsd;
    expect(weeklySvg(420, 294, weeks)).toBe(weeklySvg(420, 294, weeks));
  });
});

describe("control strip", () => {
  it("prints ten tints per plate", () => {
    for (const compact of [false, true]) {
      const strip = controlStripModel(compact);
      expect(strip.patches.filter((p) => p.ink === "ochre").map((p) => p.coverage)).toEqual([
        0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1,
      ]);
      expect(strip.patches.filter((p) => p.ink === "forest")).toHaveLength(10);
    }
    expect(controlStripModel(false).registration).toEqual([26, 1318]);
  });
});

describe("lifecycle scenes", () => {
  it("renders every scene deterministically and differently", () => {
    const svgs = SCENE_IDS.map((id) => sceneSvg(id, 180, 180));
    expect(new Set(svgs).size).toBe(SCENE_IDS.length);
    expect(sceneSvg("escrow", 180, 180)).toBe(svgs[1]);
  });

  it("keeps the screen pitch readable", () => {
    expect(sceneCell(100)).toBe(3.5);
    expect(sceneCell(268.8)).toBeCloseTo(4.2, 9);
    expect(sceneCell(400)).toBe(4.6);
  });
});
