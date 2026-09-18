import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const tokens = readFileSync(fileURLToPath(new URL("../styles/tokens.css", import.meta.url)), "utf8");

function token(name: string): string {
  const match = tokens.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6});`));
  if (!match?.[1]) throw new Error(`token --${name} is not a hex colour`);
  return match[1];
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function mix(a: string, b: string, t: number): string {
  const ca = channels(a);
  const cb = channels(b);
  return `#${ca.map((v, i) => Math.round(v * (1 - t) + (cb[i] as number) * t).toString(16).padStart(2, "0")).join("")}`;
}

/** Darkest paper pixel measured under the grain overlay in a rendered page. */
const GRAINED_PAPER = "#E5E4DC";

describe("ochre text contrast", () => {
  it("raw ochre is too light for text on paper", () => {
    expect(contrast(token("ochre"), token("paper"))).toBeLessThan(3);
  });

  it("ochre ink reads as large text on paper, grain included", () => {
    expect(contrast(token("ochre-ink"), token("paper"))).toBeGreaterThanOrEqual(3);
    expect(contrast(token("ochre-ink"), GRAINED_PAPER)).toBeGreaterThanOrEqual(3);
    expect(contrast(token("ochre-ink"), token("stock"))).toBeGreaterThanOrEqual(3);
  });

  it("screened ochre figures read as large text on the forest band", () => {
    // two offset dot grids, r ≈ 2.25px at a 6px pitch, cover about 88% of each glyph
    const screened = mix(token("forest"), token("ochre"), (2 * Math.PI * 2.25 ** 2) / 36);
    expect(contrast(screened, token("forest"))).toBeGreaterThanOrEqual(3);
  });

  it("forest text stays readable on an ochre hover fill", () => {
    expect(contrast(token("forest"), token("ochre"))).toBeGreaterThanOrEqual(4.5);
  });
});

describe("wallet error text contrast", () => {
  // Not a design token — the bid form's own error red (components/wallet/BidPanel.module.css),
  // checked directly against the same paper/stock backgrounds it's ever set on.
  const ERROR_RED = "#8a2a1a";

  it("reads as normal-size body text on paper and stock", () => {
    expect(contrast(ERROR_RED, token("paper"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(ERROR_RED, token("stock"))).toBeGreaterThanOrEqual(4.5);
  });
});
