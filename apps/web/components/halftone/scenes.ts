/**
 * The five lifecycle illustrations. Each scene is a coverage field over a unit
 * square (u right, v down) returning `[forest, ochre]`; a shared ochre river
 * runs through all five so the panels read as one strip when laid side by side.
 */

import { clamp, duotoneSvg, type DuotoneCoverage } from "./screen";

type Tone = [number, number];
type SceneField = (u: number, v: number) => Tone;

export const SCENE_IDS = ["underwrite", "escrow", "auction", "card", "sweep"] as const;
export type SceneId = (typeof SCENE_IDS)[number];

/** Signed distance helpers; negative inside. */
const sd = {
  box(u: number, v: number, cx: number, cy: number, hw: number, hh: number, r = 0): number {
    const qx = Math.abs(u - cx) - hw + r;
    const qy = Math.abs(v - cy) - hh + r;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  },
  circ(u: number, v: number, cx: number, cy: number, r: number): number {
    return Math.hypot(u - cx, v - cy) - r;
  },
  seg(u: number, v: number, ax: number, ay: number, bx: number, by: number, r: number): number {
    const px = u - ax;
    const py = v - ay;
    const qx = bx - ax;
    const qy = by - ay;
    const h = clamp((px * qx + py * qy) / (qx * qx + qy * qy));
    return Math.hypot(px - qx * h, py - qy * h) - r;
  },
  rot(u: number, v: number, cx: number, cy: number, deg: number): [number, number] {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const x = u - cx;
    const y = v - cy;
    return [cx + x * c + y * s, cy - x * s + y * c];
  },
};

function halo(u: number, v: number, cx: number, cy: number, r: number, amount: number): number {
  const d = Math.hypot(u - cx, v - cy) / r;
  return d < 1 ? amount * (1 - d) * (1 - d) : 0;
}

/** The fee stream. `panel` shifts the wave so neighbouring panels join up. */
function river(u: number, v: number, panel: number): Tone | null {
  const g = panel + u;
  const c = 0.872 + 0.022 * Math.sin(g * 2.3 + 0.6) + 0.008 * Math.sin(g * 5.3);
  const h = 0.044 + 0.011 * Math.sin(g * 1.7 + 1.2);
  const d = Math.abs(v - c) / h;
  if (d >= 1) return null;
  return [0.04 + 0.08 * (1 - d), 0.95 - 0.5 * d * d];
}

/** A loupe reads the fee stream; the score sheet shows weekly fees. */
const underwrite: SceneField = (u, v) => {
  let F = 0;
  let O = halo(u, v, 0.42, 0.36, 0.52, 0.3);
  const rv = river(u, v, 0);
  if (rv) [F, O] = rv;
  if (sd.box(u, v, 0.45, 0.37, 0.2, 0.25, 0.012) < 0) {
    F = Math.max(F, 0.3);
    O *= 0.4;
  }
  if (sd.box(u, v, 0.42, 0.34, 0.2, 0.25, 0.012) < 0) {
    F = 0;
    O = 0;
    if (sd.box(u, v, 0.33, 0.165, 0.1, 0.016) < 0) F = 0.82;
    if (sd.box(u, v, 0.38, 0.225, 0.15, 0.012) < 0) F = 0.42;
    const heights = [0.07, 0.11, 0.09, 0.15, 0.13, 0.2];
    for (let k = 0; k < 6; k++) {
      const cx = 0.275 + k * 0.06;
      if (Math.abs(u - cx) < 0.021 && v < 0.535 && v > 0.535 - (heights[k] ?? 0)) {
        F = 0.88;
        O = 0.1;
      }
    }
    if (Math.abs(v - 0.548) < 0.008 && u > 0.24 && u < 0.6) F = 0.92;
  }
  const dl = sd.circ(u, v, 0.68, 0.8, 0.125);
  if (dl < 0) {
    if (river(u, v, 0)) {
      F = 0;
      O = 1;
    } else {
      F = 0;
      O = 0.22;
    }
  }
  if (dl >= -0.03 && dl < 0) {
    F = 0.94;
    O = 0.08;
  }
  if (sd.seg(u, v, 0.77, 0.89, 0.87, 0.985, 0.028) < 0) {
    F = 0.95;
    O = 0.08;
  }
  return [F, O];
};

/** A vault sits on the stream and takes it in. */
const escrow: SceneField = (u, v) => {
  let F = 0;
  let O = halo(u, v, 0.5, 0.45, 0.55, 0.28);
  const rv = river(u, v, 1);
  if (rv) [F, O] = rv;
  if (Math.abs(u - 0.5) < 0.05 && v > 0.7 && v < 0.87) {
    F = 0.06;
    O = 0.92;
  }
  if (sd.box(u, v, 0.34, 0.765, 0.035, 0.022) < 0 || sd.box(u, v, 0.66, 0.765, 0.035, 0.022) < 0) {
    F = 0.92;
    O = 0.05;
  }
  if (sd.box(u, v, 0.528, 0.478, 0.25, 0.265, 0.03) < 0) {
    F = Math.max(F, 0.3);
    O *= 0.45;
  }
  const db = sd.box(u, v, 0.5, 0.45, 0.25, 0.265, 0.03);
  if (db < 0) {
    const t = (v - 0.185) / 0.53;
    F = 0.5 + 0.3 * t - (u < 0.5 ? 0.08 : 0);
    O = 0.1;
    if (db > -0.024) {
      F = 0.94;
      O = 0.04;
    }
    const dd = sd.box(u, v, 0.5, 0.45, 0.19, 0.205, 0.02);
    if (dd < 0) {
      F = 0.26 + 0.14 * t;
      O = 0.26;
      if (dd > -0.014) {
        F = 0.82;
        O = 0.05;
      }
    }
    const dc = sd.circ(u, v, 0.5, 0.43, 0.1);
    if (dc < 0) {
      F = 0.03;
      O = 0.95;
    }
    if (dc >= -0.026 && dc < 0.004) {
      F = 0.94;
      O = 0.05;
    }
    for (let k = 0; k < 3; k++) {
      const a = (k * Math.PI) / 3 + 0.3;
      const ca = Math.cos(a) * 0.07;
      const sa = Math.sin(a) * 0.07;
      if (dc < -0.02 && sd.seg(u, v, 0.5 - ca, 0.43 - sa, 0.5 + ca, 0.43 + sa, 0.012) < 0) {
        F = 0.9;
        O = 0.1;
      }
    }
    if (sd.circ(u, v, 0.5, 0.43, 0.028) < 0) {
      F = 0.95;
      O = 0;
    }
    if (sd.box(u, v, 0.655, 0.58, 0.014, 0.055, 0.007) < 0) {
      F = 0.95;
      O = 0.05;
    }
  }
  if (sd.box(u, v, 0.242, 0.33, 0.02, 0.048, 0.006) < 0 || sd.box(u, v, 0.242, 0.57, 0.02, 0.048, 0.006) < 0) {
    F = 0.95;
    O = 0.05;
  }
  return [F, O];
};

/** The clearing price steps up block by block, with filled bids above it. */
const auction: SceneField = (u, v) => {
  let F = 0;
  let O = 0;
  const rv = river(u, v, 2);
  if (rv) [F, O] = rv;
  const floor = 0.635;
  const tops = [0.56, 0.56, 0.52, 0.52, 0.48, 0.43, 0.43, 0.39, 0.35, 0.35];
  const x0 = 0.08;
  const w = 0.084;
  const k = Math.floor((u - x0) / w);
  const top = tops[k];
  if (top !== undefined && v < floor && v > top) {
    const t = (v - top) / (floor - top);
    F = 0.04;
    O = 0.7 - 0.3 * t;
    if (v < top + 0.03) {
      F = 0.94;
      O = 0.05;
    }
  }
  for (let j = 1; j < 10; j++) {
    const prev = tops[j - 1] as number;
    const cur = tops[j] as number;
    if (cur !== prev) {
      const xx = x0 + j * w;
      if (Math.abs(u - xx) < 0.015 && v < prev + 0.03 && v > cur) {
        F = 0.94;
        O = 0.05;
      }
    }
  }
  const bids: [number, number][] = [
    [0.14, 0.46], [0.23, 0.41], [0.33, 0.37], [0.41, 0.31], [0.5, 0.36], [0.55, 0.26], [0.64, 0.23], [0.73, 0.28],
    [0.79, 0.17], [0.89, 0.24], [0.84, 0.08], [0.44, 0.17], [0.68, 0.12], [0.26, 0.29], [0.58, 0.1],
  ];
  bids.forEach(([bx, by], n) => {
    if (sd.circ(u, v, bx, by, 0.032) < 0) {
      if (n % 4 === 3) {
        F = 0.04;
        O = 1;
      } else {
        F = 0.92;
        O = 0.15;
      }
    }
  });
  return [F, O];
};

/** Draws stop at the daily limit; the oversized one is crossed out. */
const card: SceneField = (u, v) => {
  let F = 0;
  let O = halo(u, v, 0.5, 0.3, 0.5, 0.2);
  const rv = river(u, v, 3);
  if (rv) [F, O] = rv;
  let [cu, cv] = sd.rot(u, v, 0.52, 0.3, -8);
  if (sd.box(cu, cv, 0.545, 0.325, 0.27, 0.16, 0.035) < 0) {
    F = Math.max(F, 0.3);
    O *= 0.35;
  }
  [cu, cv] = sd.rot(u, v, 0.5, 0.28, -8);
  const dc = sd.box(cu, cv, 0.5, 0.28, 0.27, 0.16, 0.035);
  if (dc < 0) {
    const t = clamp(((cu - 0.23) / 0.54) * 0.6 + ((cv - 0.12) / 0.32) * 0.4);
    O = 0.95 - 0.38 * t;
    F = 0.04 + 0.08 * t;
    if (dc > -0.016) {
      F = 0.92;
      O = 0.1;
    }
    if (sd.box(cu, cv, 0.34, 0.24, 0.055, 0.042, 0.01) < 0) {
      F = 0.6;
      O = 0.55;
      if (Math.abs(cv - 0.24) < 0.007 || Math.abs(cu - 0.34) < 0.007) F = 0.92;
    }
    for (let g = 0; g < 4; g++) {
      if (sd.box(cu, cv, 0.315 + g * 0.115, 0.355, 0.04, 0.013, 0.006) < 0) {
        F = 0.82;
        O = 0.2;
      }
    }
    const dd = Math.hypot(cu - 0.64, cv - 0.235);
    for (let a = 0; a < 3; a++) {
      const rr = 0.03 + a * 0.028;
      if (Math.abs(dd - rr) < 0.008 && cu > 0.645 && Math.abs(cv - 0.235) < rr * 0.72) {
        F = 0.88;
        O = 0.2;
      }
    }
  }
  const base = 0.79;
  const limit = 0.66;
  for (let k = 0; k < 7; k++) {
    const cx = 0.2 + k * 0.1;
    if (Math.abs(u - cx) < 0.033 && v < base && v > limit) {
      F = 0.86;
      O = 0.06;
    }
    if (k === 5 && Math.abs(u - cx) < 0.033 && v <= limit && v > 0.53) {
      F = 0.04;
      O = 0.72;
    }
  }
  if (sd.seg(u, v, 0.655, 0.54, 0.745, 0.645, 0.014) < 0 || sd.seg(u, v, 0.745, 0.54, 0.655, 0.645, 0.014) < 0) {
    F = 0.96;
    O = 0;
  }
  return [F, O];
};

/** Fees fill noteholder stacks up to the cap; the rest goes back to the agent. */
const sweep: SceneField = (u, v) => {
  let F = 0;
  let O = halo(u, v, 0.45, 0.55, 0.5, 0.18);
  const rv = river(u, v, 4);
  if (rv) [F, O] = rv;
  const shelf = 0.8;
  const th = 0.05;
  const rx = 0.07;
  const ry = 0.024;
  const stacks: [number, number][] = [
    [0.26, 4],
    [0.43, 6],
    [0.6, 8],
  ];
  for (const [cx, n] of stacks) {
    const top = shelf - n * th;
    if (Math.abs(u - cx) < 0.022 && v > shelf && v < 0.87) {
      F = 0.06;
      O = 0.92;
    }
    const side = (u - cx) / rx;
    const inBody = Math.abs(side) < 1 && v > top && v < shelf;
    const inBase = side * side + ((v - shelf) / ry) ** 2 < 1;
    if (inBody || inBase) {
      F = 0.42 + 0.42 * side * side + (side > 0 ? 0.08 : 0);
      O = 0.38;
      for (let j = 1; j < n; j++) {
        const gy = shelf - j * th + ry * Math.sqrt(Math.max(0, 1 - side * side));
        if (Math.abs(v - gy) < 0.0065) {
          F = 0.95;
          O = 0.05;
        }
      }
    }
    const face = side * side + ((v - top) / ry) ** 2;
    if (face < 1) {
      F = face > 0.62 ? 0.86 : 0.05;
      O = face > 0.62 ? 0.2 : 0.95;
    }
  }
  const hx = 0.84;
  const hy = 0.36;
  if (((u - hx) / 0.12) ** 2 + ((v - (hy + 0.2)) / 0.085) ** 2 < 1 && v < hy + 0.2) {
    F = 0.66 + 0.15 * clamp((u - hx) / 0.12 + 0.5);
    O = 0.22;
  }
  if (sd.box(u, v, hx, hy + 0.09, 0.022, 0.035) < 0) {
    F = 0.86;
    O = 0.05;
  }
  if (sd.box(u, v, hx, hy, 0.078, 0.062, 0.02) < 0) {
    F = 0.8 - 0.2 * clamp((hx - u) / 0.078);
    O = 0.1;
  }
  if (sd.box(u, v, hx, hy - 0.005, 0.06, 0.021, 0.008) < 0) {
    F = 0.95;
    O = 0;
  }
  if (sd.circ(u, v, hx - 0.03, hy - 0.005, 0.014) < 0 || sd.circ(u, v, hx + 0.03, hy - 0.005, 0.014) < 0) {
    F = 0;
    O = 1;
  }
  if (Math.abs(u - hx) < 0.008 && v < hy - 0.062 && v > hy - 0.115) {
    F = 0.9;
    O = 0;
  }
  if (sd.circ(u, v, hx, hy - 0.13, 0.022) < 0) {
    F = 0.1;
    O = 1;
  }
  return [F, O];
};

const FIELDS: Record<SceneId, SceneField> = { underwrite, escrow, auction, card, sweep };

/** Screen pitch for a scene box: about 64 dots tall, within a readable range. */
export function sceneCell(height: number): number {
  return clamp(height / 64, 3.5, 4.6);
}

/**
 * A scene printed into a `width` x `height` box. The square scene is centred
 * horizontally; on wide boxes the river keeps running out to both edges.
 */
export function sceneSvg(id: SceneId, width: number, height: number): string {
  const field = FIELDS[id];
  const offset = (width - height) / 2;
  const coverage: DuotoneCoverage = (x, y) => field((x - offset) / height, y / height);
  return duotoneSvg(width, height, sceneCell(height), coverage);
}
