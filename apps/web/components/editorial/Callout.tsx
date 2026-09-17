import type { CSSProperties, ReactNode, Ref } from "react";
import { INK } from "@/components/halftone/screen";
import { cx } from "@/lib/cx";
import type { Segment } from "./callout-geometry";
import styles from "./Callout.module.css";

type Point = { x: number; y: number };

export interface CalloutProps {
  number: number;
  title: string;
  children: ReactNode;
  /** Where the pin sits, as fractions of the figure, until measured positions arrive. */
  anchor: Point;
  /** Preferred label corner, as fractions of the figure, until measured positions arrive. */
  labelAt: Point;
  /** Measured pin position in figure pixels. */
  pin?: Point | null;
  /** Measured label position in figure pixels. */
  label?: { left: number; top: number } | null;
  labelRef?: Ref<HTMLParagraphElement>;
  className?: string;
}

/**
 * A numbered pin on a figure with its label set in a quiet area nearby. The
 * number is repeated inside the label for the single-column layout, where
 * labels stack under the figure.
 */
export function Callout({ number, title, children, anchor, labelAt, pin, label, labelRef, className }: CalloutProps) {
  const pinStyle = {
    "--tx": pin ? `${pin.x.toFixed(1)}px` : `${anchor.x * 100}%`,
    "--ty": pin ? `${pin.y.toFixed(1)}px` : `${anchor.y * 100}%`,
  } as CSSProperties;
  const labelStyle = {
    "--left": label ? `${label.left}px` : `${labelAt.x * 100}%`,
    "--top": label ? `${label.top}px` : `${labelAt.y * 100}%`,
  } as CSSProperties;
  return (
    <li className={cx(styles.item, className)}>
      <span className={styles.pin} style={pinStyle} aria-hidden="true">
        {number}
      </span>
      <p ref={labelRef} className={styles.label} style={labelStyle}>
        <b className={styles.title}>
          <span className={styles.index} aria-hidden="true">
            {number}
          </span>
          {title}
        </b>
        {children}
      </p>
    </li>
  );
}

export interface CalloutListProps {
  label: string;
  children: ReactNode;
  className?: string;
}

export function CalloutList({ label, children, className }: CalloutListProps) {
  return (
    <ol className={cx(styles.list, className)} aria-label={label}>
      {children}
    </ol>
  );
}

export interface CalloutLeadersProps {
  width: number;
  height: number;
  lines: readonly Segment[];
  className?: string;
}

/** Hairline leaders from pins to labels, each ending in a small dot on the label edge. */
export function CalloutLeaders({ width, height, lines, className }: CalloutLeadersProps) {
  return (
    <svg
      className={cx(styles.leaders, className)}
      viewBox={width && height ? `0 0 ${width} ${height}` : undefined}
      aria-hidden="true"
    >
      {lines.map((line) => (
        <g key={`${line.x2.toFixed(1)}-${line.y2.toFixed(1)}`}>
          <line
            x1={line.x1.toFixed(1)}
            y1={line.y1.toFixed(1)}
            x2={line.x2.toFixed(1)}
            y2={line.y2.toFixed(1)}
            stroke={INK.forest}
            strokeWidth={1.25}
          />
          <circle cx={line.x2.toFixed(1)} cy={line.y2.toFixed(1)} r={2.6} fill={INK.forest} />
        </g>
      ))}
    </svg>
  );
}
