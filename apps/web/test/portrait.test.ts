import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HERO_FRAMING,
  INSET_FRAMING,
  describeLikeness,
  framingFor,
  likenessFromSeed,
  portraitAnchors,
  portraitCell,
  portraitMapper,
  portraitPlates,
  portraitSvg,
  portraitTone,
  type Likeness,
} from "@/components/halftone/portrait";
import { INK, dots, duotoneSvg } from "@/components/halftone/screen";
import { landingFixture } from "./landing-fixture";

const seedA = "0x3f2c5a0e1b7d44c8a9b2e6f01d3c7a8b5e4d9e11";
const seedB = "0x9b07e3c1d5a8f2b6049e7c3a1d8b5f2e6c9a41d0";

function arcCount(path: string): number {
  return (path.match(/M/g) ?? []).length;
}

describe("dots", () => {
  it("prints nothing where coverage is empty", () => {
    expect(dots(120, 80, 6, 15, () => 0)).toBe("");
  });

  it("prints one closed circle per screen cell under full coverage", () => {
    const path = dots(120, 80, 6, 45, () => 1);
    expect(arcCount(path)).toBeGreaterThan((120 / 6) * (80 / 6));
    expect(path).toMatch(/^M[-\d.]+ [-\d.]+a[\d.]+ [\d.]+ 0 1 0 [\d.]+ 0a/);
  });

  it("grows dots with coverage and never past the cell", () => {
    const radii = (cov: number) =>
      [...dots(60, 60, 6, 15, () => cov).matchAll(/a([\d.]+) /g)].map((m) => Number(m[1]));
    const light = radii(0.2);
    const heavy = radii(0.9);
    expect(Math.max(...light)).toBeLessThan(Math.min(...heavy));
    expect(Math.max(...heavy)).toBeLessThanOrEqual(6 * Math.sqrt(1 / Math.PI) * 1.06 + 0.01);
  });

  it("is deterministic", () => {
    const cov = (x: number, y: number) => (x / 100 + y / 100) / 2;
    expect(dots(100, 100, 5, 15, cov)).toBe(dots(100, 100, 5, 15, cov));
  });

  it("layers ochre at 15 degrees under forest multiplied on top", () => {
    const svg = duotoneSvg(40, 40, 4, () => [0.5, 0.5]);
    expect(svg.indexOf(`fill="${INK.ochre}"`)).toBeLessThan(svg.indexOf(`fill="${INK.forest}"`));
    expect(svg).toContain("mix-blend-mode:multiply");
  });
});

describe("likenessFromSeed", () => {
  it("is deterministic and ignores address case", () => {
    expect(likenessFromSeed(seedA)).toEqual(likenessFromSeed(seedA));
    expect(likenessFromSeed(seedA.toUpperCase().replace("0X", "0x"))).toEqual(likenessFromSeed(seedA));
  });

  it("varies antennas, eyes, visor and body across agents", () => {
    const seen = {
      antennas: new Set<number>(),
      eyes: new Set<string>(),
      visor: new Set<number>(),
      badge: new Set<number>(),
      stripe: new Set<boolean>(),
      shapes: new Set<string>(),
    };
    for (let i = 0; i < 96; i++) {
      const l = likenessFromSeed(`0x${i.toString(16).padStart(40, "0")}`);
      seen.antennas.add(l.antennas);
      seen.eyes.add(l.eyes);
      seen.visor.add(l.visor);
      seen.badge.add(l.badgeX);
      seen.stripe.add(l.stripe);
      seen.shapes.add(`${l.hw}/${l.hh}/${l.ex}`);
    }
    expect(seen.antennas.size).toBe(2);
    expect(seen.eyes.size).toBe(2);
    expect(seen.visor.size).toBe(2);
    expect(seen.badge.size).toBe(2);
    expect(seen.stripe.size).toBe(2);
    expect(seen.shapes.size).toBeGreaterThan(10);
  });

  it("gives neighbouring addresses different likenesses", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 32; i++) {
      keys.add(JSON.stringify(likenessFromSeed(`0x3f2c${i.toString(16).padStart(36, "0")}`)));
    }
    expect(keys.size).toBeGreaterThan(28);
  });

  it("rejects an empty seed", () => {
    expect(() => likenessFromSeed("  ")).toThrow(TypeError);
  });
});

describe("portraitSvg", () => {
  it("returns identical markup for the same seed", () => {
    const a = portraitSvg({ seed: seedA, width: 240, height: 260, framing: INSET_FRAMING.wide });
    const b = portraitSvg({ seed: seedA, width: 240, height: 260, framing: INSET_FRAMING.wide });
    expect(a).toBe(b);
    expect(a.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="260"')).toBe(true);
  });

  it("returns visibly different markup for different seeds", () => {
    const a = portraitSvg({ seed: seedA, width: 240, height: 260, framing: INSET_FRAMING.wide });
    const b = portraitSvg({ seed: seedB, width: 240, height: 260, framing: INSET_FRAMING.wide });
    expect(a).not.toBe(b);
    const pathsA = a.match(/d="([^"]*)"/g) ?? [];
    const pathsB = b.match(/d="([^"]*)"/g) ?? [];
    const shared = pathsA[1]?.split("M").filter((s) => pathsB[1]?.includes(`M${s}`)).length ?? 0;
    expect(shared / Math.max(1, arcCount(pathsA[1] ?? ""))).toBeLessThan(0.9);
  });

  it("splits into an ochre and a forest plate", () => {
    const plates = portraitPlates({
      likeness: likenessFromSeed(seedA),
      width: 200,
      height: 200,
      framing: HERO_FRAMING.wide,
      cell: portraitCell(200),
    });
    expect(plates.ochre).toContain(`fill="${INK.ochre}"`);
    expect(plates.forest).toContain(`fill="${INK.forest}"`);
    expect(plates.ochre).not.toContain(INK.forest);
  });
});

describe("portrait geometry", () => {
  it("keeps tone inside 0..1", () => {
    const l = likenessFromSeed(seedB);
    for (let y = -0.2; y <= 1.2; y += 0.05) {
      for (let x = -0.2; x <= 1.2; x += 0.05) {
        const [f, o] = portraitTone(x, y, l);
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(1);
        expect(o).toBeGreaterThanOrEqual(0);
        expect(o).toBeLessThanOrEqual(1);
      }
    }
  });

  it("maps box pixels to portrait space and back", () => {
    const m = portraitMapper(HERO_FRAMING.wide, 720, 728);
    const [X, Y] = m.toPortrait(301.5, 402.25);
    const [x, y] = m.toBox(X, Y);
    expect(x).toBeCloseTo(301.5, 9);
    expect(y).toBeCloseTo(402.25, 9);
  });

  it("uses the compact framing only where one exists", () => {
    expect(framingFor(HERO_FRAMING, true)).toEqual({ anchor: 0.5, cy: 0.5, zoom: 0.95 });
    expect(framingFor(INSET_FRAMING, true)).toEqual(INSET_FRAMING.wide);
  });

  it("picks a finer screen for smaller boxes", () => {
    expect(portraitCell(240)).toBe(4.6);
    expect(portraitCell(390)).toBe(5.8);
    expect(portraitCell(720)).toBe(7);
  });
});

describe("landing specimens", () => {
  const hero: Likeness = {
    hx: 0.5, hy: 0.4, hw: 0.25, hh: 0.205, ex: 4.2, antennas: 1, eyes: "round",
    lx: -0.55, ly: -0.62, visor: 0.28, badgeX: 0.36, stripe: true,
  };
  const inset: Likeness = {
    hx: 0.5, hy: 0.42, hw: 0.29, hh: 0.18, ex: 2.6, antennas: 2, eyes: "bar",
    lx: 0.5, ly: -0.6, visor: 0.28, badgeX: 0.36, stripe: true,
  };

  it("draws the hero agent with one antenna, round eyes and a square head", () => {
    expect(likenessFromSeed(landingFixture.hero.agent)).toEqual(hero);
  });

  it("draws the refusal agent with two antennas and a bar visor", () => {
    expect(likenessFromSeed(landingFixture.refusal.agent)).toEqual(inset);
  });

  it("describes both specimens in words", () => {
    expect(describeLikeness(hero)).toBe("a robot with one antenna and round eyes behind a visor");
    expect(describeLikeness(inset)).toBe("a robot with two antennas and a bar visor");
  });

  it("pins the hero callouts to antenna, eye and badge", () => {
    const a = portraitAnchors(hero);
    expect(a.antenna).toEqual([0.5, 0.092]);
    expect(a.eye).toEqual([0.4, 0.375]);
    expect(a.badge).toEqual([0.36, 0.9]);
  });
});

describe("ink tokens", () => {
  it("match the stylesheet", () => {
    const css = readFileSync(fileURLToPath(new URL("../styles/tokens.css", import.meta.url)), "utf8");
    expect(css).toContain(`--forest: ${INK.forest};`);
    expect(css).toContain(`--ochre: ${INK.ochre};`);
    expect(css).toContain(`--paper: ${INK.paper};`);
    expect(css).toContain(`--stock: ${INK.stock};`);
  });
});
