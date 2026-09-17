import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import { formatBlock, formatCents } from "@/lib/format";
import type { AuctionStep } from "@/lib/landing-data";
import { auctionChartModel } from "./charts";
import { INK } from "./screen";
import styles from "./AuctionChart.module.css";

export interface AuctionChartProps {
  startBlock: number;
  blocks: number;
  floorCents: number;
  steps: readonly AuctionStep[];
  bid: { maxPriceCents: number; atBlock: number };
  caption: ReactNode;
  className?: string;
}

function Canvas({ compact, label, ...input }: Omit<AuctionChartProps, "caption" | "className"> & { compact: boolean; label: string }) {
  const m = auctionChartModel({ compact, ...input });
  return (
    <svg className={compact ? styles.compact : styles.wide} viewBox={`0 0 ${m.width} ${m.height}`} role="img" aria-label={label}>
      <g transform={`translate(${m.x0} ${m.y0})`}>
        <path fill={INK.ochre} d={m.demand} />
      </g>
      {m.gridlines.map((g) => (
        <g key={g.cents}>
          <line x1={m.x0} x2={m.x1} y1={g.y} y2={g.y} stroke={INK.forest} strokeOpacity=".22" strokeWidth="1" />
          <text x={m.x0 - 10} y={g.y + 4} textAnchor="end">
            {formatCents(g.cents)}
          </text>
        </g>
      ))}
      <line x1={m.x0} x2={m.x1} y1={m.floorY} y2={m.floorY} stroke={INK.forest} strokeWidth="1.2" strokeDasharray="5 4" />
      <path d={m.stepPath} fill="none" stroke={INK.forest} strokeWidth="3" strokeLinejoin="miter" />
      <line
        x1={m.bid.x}
        x2={m.x1}
        y1={m.bid.y}
        y2={m.bid.y}
        stroke={INK.forest}
        strokeWidth="1.2"
        strokeDasharray="1.5 4"
        strokeLinecap="round"
      />
      <circle cx={m.bid.x} cy={m.bid.y} r="7" fill={INK.ochre} stroke={INK.forest} strokeWidth="2" />
      <text x={m.bid.x + (compact ? -8 : 14)} y={m.bid.y - 12}>
        Your bid, max {formatCents(input.bid.maxPriceCents)}
      </text>
      <circle cx={m.clearing.x} cy={m.clearing.y} r="6" fill={INK.forest} />
      <text className={styles.serif} x={m.clearing.x - 10} y={m.clearing.y - 14} textAnchor="end">
        cleared at {formatCents(m.clearing.cents)}
      </text>
      <text x={m.x0 + 8} y={m.floorY + 22}>
        floor, set by the term sheet
      </text>
      <line x1={m.x0} x2={m.x1} y1={m.y1 + 14} y2={m.y1 + 14} stroke={INK.forest} strokeWidth="1" />
      {m.ticks.map((x) => (
        <line key={x} x1={x} x2={x} y1={m.y1 + 14} y2={m.y1 + 20} stroke={INK.forest} />
      ))}
      <text x={m.x0} y={m.y1 + 42}>
        block {formatBlock(input.startBlock)}
      </text>
      <text x={m.x1} y={m.y1 + 42} textAnchor="end">
        {formatBlock(input.startBlock + input.blocks)}
      </text>
    </svg>
  );
}

/**
 * Clearing price over the auction as a step line, with the bidders' demand
 * screened underneath and one bid traced to its fill. Both canvases are
 * rendered and the stylesheet shows the one that fits the layout.
 */
export function AuctionChart({ caption, className, ...input }: AuctionChartProps) {
  const clearing = auctionChartModel({ compact: false, ...input }).clearing.cents;
  const label = `Clearing price over ${input.blocks} blocks, rising in steps from the ${formatCents(input.floorCents)} floor to ${formatCents(clearing)}. A bid with a maximum of ${formatCents(input.bid.maxPriceCents)} fills at ${formatCents(clearing)}.`;
  return (
    <figure className={cx(styles.chart, className)}>
      <Canvas {...input} compact={false} label={label} />
      <Canvas {...input} compact label={label} />
      <figcaption>{caption}</figcaption>
    </figure>
  );
}
