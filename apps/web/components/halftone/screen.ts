/**
 * Two-plate halftone screening. Every illustration on the site is printed the
 * same way: an ochre plate screened at 15 degrees, a forest plate screened at
 * 45 degrees and multiplied over it. Coverage functions return ink density in
 * 0..1 for a point in the box; the screen turns that into dot radii.
 */

export const INK = {
  forest: "#173F35",
  ochre: "#D9A441",
  paper: "#EFEBE2",
  stock: "#F7F4EC",
} as const;

export const SCREEN_ANGLE = { ochre: 15, forest: 45 } as const;

/** Below this coverage a cell prints no dot at all. */
export const COVERAGE_FLOOR = 0.035;
/** Dots smaller than this radius (px) are dropped; they would only blur. */
export const MIN_DOT_RADIUS = 0.38;
/** Slight dot gain so full coverage closes the gaps between neighbours. */
export const DOT_GAIN = 1.06;

const SVG_NS = "http://www.w3.org/2000/svg";

export type Coverage = (x: number, y: number) => number;
/** Returns `[forest, ochre]` coverage for a point. */
export type DuotoneCoverage = (x: number, y: number) => readonly [number, number];

export function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Path data for a rotated dot screen over a `width` x `height` box. Each dot is
 * a closed pair of arcs, so one `<path>` holds the whole plate.
 */
export function dots(width: number, height: number, cell: number, angle: number, coverage: Coverage): string {
  const a = (angle * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const reach = Math.hypot(width, height) / 2 + cell;
  const cx = width / 2;
  const cy = height / 2;
  const out: string[] = [];
  for (let i = -reach; i <= reach; i += cell) {
    for (let j = -reach; j <= reach; j += cell) {
      const x = cx + i * c - j * s;
      const y = cy + i * s + j * c;
      if (x < -cell || x > width + cell || y < -cell || y > height + cell) continue;
      const t = coverage(x, y);
      if (!(t > COVERAGE_FLOOR)) continue;
      const r = cell * Math.sqrt(Math.min(t, 1) / Math.PI) * DOT_GAIN;
      if (r < MIN_DOT_RADIUS) continue;
      const r2 = r.toFixed(2);
      const d2 = (2 * r).toFixed(2);
      out.push(`M${(x - r).toFixed(1)} ${y.toFixed(1)}a${r2} ${r2} 0 1 0 ${d2} 0a${r2} ${r2} 0 1 0 -${d2} 0`);
    }
  }
  return out.join("");
}

export function svgDocument(width: number, height: number, body: string): string {
  return `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

/** Both plates in one document, ochre underneath and forest multiplied on top. */
export function duotoneSvg(width: number, height: number, cell: number, coverage: DuotoneCoverage): string {
  const ochre = dots(width, height, cell, SCREEN_ANGLE.ochre, (x, y) => coverage(x, y)[1]);
  const forest = dots(width, height, cell, SCREEN_ANGLE.forest, (x, y) => coverage(x, y)[0]);
  return svgDocument(
    width,
    height,
    `<path fill="${INK.ochre}" d="${ochre}"/><path fill="${INK.forest}" style="mix-blend-mode:multiply" d="${forest}"/>`,
  );
}
