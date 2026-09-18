import type { ReactNode } from "react";
import { INK } from "@/components/halftone/screen";
import { cx } from "@/lib/cx";
import { formatBlock, formatCents } from "@/lib/format";
import type { AuctionStep } from "@/lib/landing-data";
import { clearingPriceStepsModel, type ClearingPriceStepsInput } from "./clearingPriceGeometry";
import styles from "./ClearingPriceSteps.module.css";

export interface ClearingPriceStepsProps {
  startBlock: number;
  blocks: number;
  floorCents: number;
  steps: readonly AuctionStep[];
  elapsedBlocks: number;
  live: boolean;
  caption: ReactNode;
  className?: string;
}

function Canvas({
  compact,
  label,
  startBlock,
  blocks,
  floorCents,
  steps,
  elapsedBlocks,
  live,
}: ClearingPriceStepsInput & Pick<ClearingPriceStepsProps, "startBlock" | "elapsedBlocks" | "live"> & { label: string }) {
  const m = clearingPriceStepsModel({ compact, blocks, floorCents, steps });
  return (
    <svg className={compact ? styles.compact : styles.wide} viewBox={`0 0 ${m.width} ${m.height}`} role="img" aria-label={label}>
      {m.gridlines.map((g) => (
        <g key={g.cents}>
          <line x1={m.x0} x2={m.x1} y1={g.y} y2={g.y} stroke={INK.forest} strokeOpacity=".18" strokeWidth="1" />
          <text x={m.x0 - 10} y={g.y + 4} textAnchor="end">
            {formatCents(g.cents)}
          </text>
        </g>
      ))}
      <line x1={m.x0} x2={m.x1} y1={m.floorY} y2={m.floorY} stroke={INK.forest} strokeWidth="1.2" strokeDasharray="5 4" />
      <text x={m.x0 + 8} y={m.floorY + 18}>
        floor, set by the term sheet
      </text>
      <path d={m.stepPath} fill="none" stroke={INK.forest} strokeWidth="3" strokeLinejoin="miter" />
      {elapsedBlocks > 0 ? (
        <>
          <circle cx={m.clearing.x} cy={m.clearing.y} r="6" fill={INK.ochre} stroke={INK.forest} strokeWidth="2" />
          <text className={styles.serif} x={m.clearing.x - 10} y={m.clearing.y - 14} textAnchor="end">
            {live ? "clearing now at" : "cleared at"} {formatCents(m.clearing.cents)}
          </text>
        </>
      ) : null}
      <line x1={m.x0} x2={m.x1} y1={m.y1 + 14} y2={m.y1 + 14} stroke={INK.forest} strokeWidth="1" />
      {m.ticks.map((t) => (
        <line key={t.block} x1={t.x} x2={t.x} y1={m.y1 + 14} y2={m.y1 + 20} stroke={INK.forest} />
      ))}
      <text x={m.x0} y={m.y1 + 42}>
        block {formatBlock(startBlock)}
      </text>
      <text x={m.x1} y={m.y1 + 42} textAnchor="end">
        {formatBlock(startBlock + blocks)}
      </text>
    </svg>
  );
}

/**
 * The auction's clearing price as a step line: the term sheet's floor, and the price it has
 * climbed to over the blocks elapsed so far. Only two points are ever observable off-chain —
 * the floor and the auction's current checkpoint — so this never draws a full per-block curve
 * that wasn't actually read.
 */
export function ClearingPriceSteps({ caption, className, ...input }: ClearingPriceStepsProps) {
  const clearingCents = input.elapsedBlocks > 0 ? input.steps[input.steps.length - 1]?.priceCents ?? input.floorCents : input.floorCents;
  const label =
    input.elapsedBlocks > 0
      ? `Clearing price over ${input.blocks} blocks: holds at the ${formatCents(input.floorCents)} floor from block ${formatBlock(input.startBlock)}, then steps to ${formatCents(clearingCents)} at block ${formatBlock(input.startBlock + input.elapsedBlocks)}.`
      : `Clearing price over ${input.blocks} blocks, still at its ${formatCents(input.floorCents)} floor — no block has elapsed yet.`;
  return (
    <figure className={cx(styles.chart, className)}>
      <Canvas {...input} compact={false} label={label} />
      <Canvas {...input} compact label={label} />
      <figcaption>{caption}</figcaption>
    </figure>
  );
}
