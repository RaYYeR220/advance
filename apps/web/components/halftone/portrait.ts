/**
 * Procedural agent likeness. An agent's address seeds a small set of choices
 * (head shape, antennas, eyes, visor, light, chest), and the tone field below
 * turns those choices into forest and ochre coverage for the two-plate screen.
 * Portrait space is a unit square: head around the middle, shoulders cut off
 * by the bottom edge.
 */

import { INK, SCREEN_ANGLE, clamp, dots, duotoneSvg, svgDocument } from "./screen";

export interface Likeness {
  /** Head centre and half extents, in portrait units. */
  hx: number;
  hy: number;
  hw: number;
  hh: number;
  /** Superellipse exponent of the head: 2.6 is soft, 4.2 is nearly square. */
  ex: number;
  antennas: 1 | 2;
  eyes: "round" | "bar";
  /** Direction the key light comes from, in portrait units. */
  lx: number;
  ly: number;
  /** Half height of the visor band, in head units. */
  visor: number;
  /** Horizontal position of the chest badge. */
  badgeX: number;
  /** Whether a seam runs across the chest. */
  stripe: boolean;
}

export interface Framing {
  /** Horizontal position of the portrait centre, as a share of box width. */
  anchor: number;
  /** Vertical position of the portrait centre, as a share of box height. */
  cy: number;
  /** Portrait side as a share of the fitted box side. */
  zoom: number;
}

export interface PortraitFraming {
  wide: Framing;
  /** Used on single-column layouts; falls back to `wide`. */
  compact?: Framing;
}

/** Full-bleed hero crop: the head sits right of centre to leave room for callouts. */
export const HERO_FRAMING: PortraitFraming = {
  wide: { anchor: 0.58, cy: 0.53, zoom: 0.84 },
  compact: { anchor: 0.5, cy: 0.5, zoom: 0.95 },
};

/** Small evidence crop, centred. */
export const INSET_FRAMING: PortraitFraming = {
  wide: { anchor: 0.5, cy: 0.53, zoom: 0.86 },
};

const HEAD_X = 0.5;
const HEAD_Y = [0.4, 0.42] as const;
const HEAD_W = [0.25, 0.27, 0.29] as const;
const HEAD_H = [0.18, 0.195, 0.205] as const;
const HEAD_EXP = [2.6, 3.4, 4.2] as const;
const ANTENNAS = [1, 2] as const;
const EYES = ["round", "bar"] as const;
const LIGHTS = [
  [-0.55, -0.62],
  [0.5, -0.6],
  [-0.3, -0.7],
] as const;
const VISORS = [0.28, 0.2] as const;
const BADGES = [0.36, 0.64] as const;
const STRIPES = [true, false] as const;

/** Visor centre line, in head units above the head centre. */
const VISOR_Y = -0.12;

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, options: readonly T[]): T {
  return options[Math.floor(random() * options.length)] as T;
}

/** Same address, same agent. Case and surrounding whitespace are ignored. */
export function likenessFromSeed(seed: string): Likeness {
  const normal = seed.trim().toLowerCase();
  if (!normal) throw new TypeError("portrait seed must not be empty");
  const random = mulberry32(fnv1a(normal));
  const [lx, ly] = pick(random, LIGHTS);
  return {
    hx: HEAD_X,
    hy: pick(random, HEAD_Y),
    hw: pick(random, HEAD_W),
    hh: pick(random, HEAD_H),
    ex: pick(random, HEAD_EXP),
    antennas: pick(random, ANTENNAS),
    eyes: pick(random, EYES),
    lx,
    ly,
    visor: pick(random, VISORS),
    badgeX: pick(random, BADGES),
    stripe: pick(random, STRIPES),
  };
}

function antennaOffsets(likeness: Likeness): readonly number[] {
  return likeness.antennas === 1 ? [0] : [-0.5, 0.5];
}

/** `[forest, ochre]` coverage at a point of portrait space. */
export function portraitTone(X: number, Y: number, P: Likeness): [number, number] {
  let F: number;
  let O: number;

  // backdrop: ochre halo up and to the right, forest settling towards the floor
  const hd = Math.hypot(X - 0.7, Y - 0.26);
  const halo = clamp(1 - hd / 0.7);
  O = 0.16 + 0.6 * halo * halo;
  F = 0.05 + 0.12 * clamp(Y - 0.3) + 0.05 * (1 - halo);

  // head shadow cast away from the light
  {
    const nx = (X - P.hx + P.lx * 0.12) / P.hw;
    const ny = (Y - P.hy + P.ly * 0.06) / P.hh;
    if (Math.abs(nx) ** P.ex + Math.abs(ny) ** P.ex < 1) {
      F = Math.max(F, 0.34);
      O *= 0.7;
    }
  }

  // shoulders, lit as a sphere, with seam and badge
  {
    const sx = (X - 0.5) / 0.52;
    const sy = (Y - 1.06) / 0.38;
    const q = sx * sx + sy * sy;
    if (q < 1) {
      const nz = Math.sqrt(1 - q);
      const lam = clamp(P.lx * sx * 0.8 + P.ly * sy * 0.8 + 0.62 * nz);
      F = 0.2 + 0.66 * (1 - lam);
      O = 0.12 + 0.34 * lam;
      if (P.stripe && Math.abs(sy + 0.62) < 0.025 && Math.abs(sx) < 0.7) {
        F = 0.88;
        O = 0.05;
      }
      if (Math.hypot(X - P.badgeX, Y - 0.9) < 0.036) {
        F = 0.06;
        O = 0.95;
      }
      if (Math.hypot(X - P.badgeX, Y - 0.9) < 0.018) F = 0.7;
    }
  }

  // neck, ribbed
  if (Math.abs(X - 0.5) < 0.055 && Y > P.hy + P.hh * 0.8 && Y < 0.7) {
    const k = (X - 0.5) / 0.055;
    F = 0.55 + 0.3 * clamp(k * 0.5 + 0.5);
    O = 0.08;
    if (((Y * 100) | 0) % 3 === 0) F = 0.9;
  }

  // ears
  for (const side of [-1, 1]) {
    const earX = P.hx + side * (P.hw + 0.025);
    if (Math.abs(X - earX) < 0.03 && Math.abs(Y - P.hy) < 0.06) {
      F = 0.78;
      O = 0.1;
    }
  }

  // head: superellipse shaded as a dome, visor, eyes and grille
  {
    const nx = (X - P.hx) / P.hw;
    const ny = (Y - P.hy) / P.hh;
    const q = Math.abs(nx) ** P.ex + Math.abs(ny) ** P.ex;
    if (q < 1) {
      const edge = q ** 3;
      let Nx = nx * 0.9 * (0.35 + edge);
      let Ny = ny * 0.9 * (0.35 + edge);
      let Nz = Math.sqrt(Math.max(0.02, 1 - q)) * 1.1;
      const len = Math.hypot(Nx, Ny, Nz);
      Nx /= len;
      Ny /= len;
      Nz /= len;
      const L = Math.hypot(P.lx, P.ly, 0.62);
      const lam = clamp((Nx * P.lx + Ny * P.ly + Nz * 0.62) / L);
      F = 0.1 + 0.8 * (1 - lam) ** 1.4;
      O = 0.1 + 0.42 * lam;
      if (Math.hypot(nx - P.lx * 0.7, ny - P.ly * 0.6) < 0.22) {
        F *= 0.25;
        O *= 0.6;
      }
      if (Math.abs(ny - VISOR_Y) < P.visor && Math.abs(nx) < 0.8) {
        F = 0.94;
        O = 0.04;
        const eyeY = VISOR_Y * P.hh + P.hy;
        for (const eyeOffset of [-0.4, 0.4]) {
          const eyeX = P.hx + eyeOffset * P.hw;
          const d =
            P.eyes === "round"
              ? Math.hypot(X - eyeX, Y - eyeY) / 0.034
              : Math.max(Math.abs(X - eyeX) / 0.06, Math.abs(Y - eyeY) / 0.016);
          if (d < 1) {
            F = 0;
            O = 1;
          } else if (d < 1.8) {
            F = 0.55 + 0.3 * (d - 1);
            O = 0.55 * (1.8 - d);
          }
        }
      }
      if (ny > 0.38 && ny < 0.66 && Math.abs(nx) < 0.38) {
        const band = Math.floor((ny - 0.38) / 0.056);
        if (band % 2 === 0) {
          F = 0.86;
          O = 0.05;
        }
      }
    }
  }

  // antennas: stalk and a lit ball on top
  for (const offset of antennaOffsets(P)) {
    const ax = P.hx + offset * P.hw;
    const top = P.hy - P.hh;
    if (Math.abs(X - ax) < 0.008 && Y < top + 0.01 && Y > top - 0.09) {
      F = 0.9;
      O = 0.05;
    }
    const bd = Math.hypot(X - ax, Y - (top - 0.105));
    if (bd < 0.03) {
      F = 0.22 + 0.3 * clamp((X - ax) / 0.03 + 0.3);
      O = 1;
    }
  }

  return [clamp(F), clamp(O)];
}

/** Plain description of a likeness for assistive technology. */
export function describeLikeness(P: Likeness): string {
  const antennas = P.antennas === 1 ? "one antenna" : "two antennas";
  const eyes = P.eyes === "round" ? "round eyes behind a visor" : "a bar visor";
  return `a robot with ${antennas} and ${eyes}`;
}

export type AnchorName = "antenna" | "eye" | "badge";

/** Anchors are placed on a 1/1000 grid; finer precision moves pins by less than a pixel. */
const anchorGrid = (v: number) => Math.round(v * 1000) / 1000;

/** Points of a likeness that callouts can point at, in portrait units. */
export function portraitAnchors(P: Likeness): Record<AnchorName, [number, number]> {
  const [firstAntenna = 0] = antennaOffsets(P);
  const point = (x: number, y: number): [number, number] => [anchorGrid(x), anchorGrid(y)];
  return {
    antenna: point(P.hx + firstAntenna * P.hw, P.hy - P.hh - 0.103),
    eye: point(P.hx - 0.4 * P.hw, P.hy + VISOR_Y * P.hh),
    badge: point(P.badgeX, 0.9),
  };
}

export interface PortraitMapper {
  toPortrait(x: number, y: number): [number, number];
  toBox(X: number, Y: number): [number, number];
}

/** Maps between box pixels and portrait units for a given crop. */
export function portraitMapper(framing: Framing, width: number, height: number): PortraitMapper {
  const side = Math.min(height, width * 1.15) * framing.zoom;
  const ox = framing.anchor * width;
  const oy = framing.cy * height;
  return {
    toPortrait: (x, y) => [(x - ox) / side + 0.5, (y - oy) / side + 0.5],
    toBox: (X, Y) => [(X - 0.5) * side + ox, (Y - 0.5) * side + oy],
  };
}

export function framingFor(framing: PortraitFraming, compact: boolean): Framing {
  return compact && framing.compact ? framing.compact : framing.wide;
}

/** Screen pitch for the fine plate; small boxes get a finer screen. */
export function portraitCell(width: number): number {
  if (width < 300) return 4.6;
  if (width < 520) return 5.8;
  return 7;
}

/** The loupe shows the same likeness through a screen this much coarser. */
export const LOUPE_SCREEN_RATIO = 2.1;

export interface PlateOptions {
  likeness: Likeness;
  width: number;
  height: number;
  framing: Framing;
  cell: number;
}

export interface PortraitPlates {
  ochre: string;
  forest: string;
}

/** Each plate as its own SVG document, so the two inks can be animated apart. */
export function portraitPlates({ likeness, width, height, framing, cell }: PlateOptions): PortraitPlates {
  const m = portraitMapper(framing, width, height);
  const plate = (angle: number, channel: 0 | 1) =>
    dots(width, height, cell, angle, (x, y) => {
      const [X, Y] = m.toPortrait(x, y);
      return portraitTone(X, Y, likeness)[channel];
    });
  return {
    ochre: svgDocument(width, height, `<path fill="${INK.ochre}" d="${plate(SCREEN_ANGLE.ochre, 1)}"/>`),
    forest: svgDocument(width, height, `<path fill="${INK.forest}" d="${plate(SCREEN_ANGLE.forest, 0)}"/>`),
  };
}

export interface PortraitSvgOptions {
  seed: string;
  width: number;
  height: number;
  framing: Framing;
  cell?: number;
}

/** A finished two-ink portrait for an address, as one SVG document. */
export function portraitSvg({ seed, width, height, framing, cell = portraitCell(width) }: PortraitSvgOptions): string {
  const likeness = likenessFromSeed(seed);
  const m = portraitMapper(framing, width, height);
  return duotoneSvg(width, height, cell, (x, y) => {
    const [X, Y] = m.toPortrait(x, y);
    return portraitTone(X, Y, likeness);
  });
}
