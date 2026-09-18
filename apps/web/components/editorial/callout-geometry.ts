export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Keeps a label of the given size inside the figure with a small margin. */
export function placeLabel(
  preferred: { x: number; y: number },
  label: { width: number; height: number },
  figure: { width: number; height: number },
  margin = 12,
): Box {
  const clampTo = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  return {
    left: clampTo(preferred.x * figure.width, margin, figure.width - label.width - margin),
    top: clampTo(preferred.y * figure.height, margin, figure.height - label.height - margin),
    width: label.width,
    height: label.height,
  };
}

/** Radius of the numbered pin; leaders start just outside it. */
export const PIN_CLEARANCE = 13;
/** Pins closer than this to their label need no leader. */
export const MIN_LEADER = 16;

/**
 * Leader from a pin to the nearest point of its label's box, starting at the
 * pin's rim. `null` when the pin sits on or right next to the label.
 */
export function leaderLine(pin: { x: number; y: number }, label: Box): Segment | null {
  const ex = Math.max(label.left, Math.min(label.left + label.width, pin.x));
  const ey = Math.max(label.top, Math.min(label.top + label.height, pin.y));
  const d = Math.hypot(ex - pin.x, ey - pin.y);
  if (d <= MIN_LEADER) return null;
  return {
    x1: pin.x + ((ex - pin.x) / d) * PIN_CLEARANCE,
    y1: pin.y + ((ey - pin.y) / d) * PIN_CLEARANCE,
    x2: ex,
    y2: ey,
  };
}
