import type { ReactNode } from "react";
import { formatUsd } from "@/lib/format";
import { cx } from "@/lib/cx";
import { revenueWindowsModel, type RevenueWindowBar } from "./charts";
import { INK } from "./screen";
import styles from "./RevenueWindowsChart.module.css";

export interface RevenueWindowsChartProps {
  d1Usd: number;
  d7Usd: number;
  d30Usd: number;
  caption: ReactNode;
  className?: string;
}

function Canvas({ compact, label, windows }: { compact: boolean; label: string; windows: readonly RevenueWindowBar[] }) {
  const m = revenueWindowsModel(compact, windows);
  return (
    <svg className={compact ? styles.compact : styles.wide} viewBox={`0 0 ${m.width} ${m.height}`} role="img" aria-label={label}>
      <line x1={m.x0} x2={m.x1} y1={m.y1} y2={m.y1} stroke={INK.forest} strokeWidth="1.2" />
      {m.bars.map((bar) => (
        <g key={bar.label}>
          <rect x={bar.x.toFixed(1)} y={bar.y.toFixed(1)} width={bar.width.toFixed(1)} height={Math.max(0, bar.height).toFixed(1)} fill={INK.ochre} />
          <text x={bar.x + bar.width / 2} y={bar.y - 8} textAnchor="middle">
            {formatUsd(bar.usd)}
          </text>
          <text x={bar.x + bar.width / 2} y={m.y1 + 20} textAnchor="middle">
            {bar.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

/** Creator revenue over the three underwriting windows, as ascending bars — 1 day, 7 days and
 * 30 days always read as a subset of one another, so the bars only ever grow left to right. */
export function RevenueWindowsChart({ d1Usd, d7Usd, d30Usd, caption, className }: RevenueWindowsChartProps) {
  const windows: RevenueWindowBar[] = [
    { label: "1 day", usd: d1Usd },
    { label: "7 days", usd: d7Usd },
    { label: "30 days", usd: d30Usd },
  ];
  const label = `Creator revenue over the underwriting windows: ${formatUsd(d1Usd)} in the last day, ${formatUsd(d7Usd)} in the last 7 days, ${formatUsd(d30Usd)} in the last 30 days.`;
  return (
    <figure className={cx(styles.chart, className)}>
      <Canvas windows={windows} compact={false} label={label} />
      <Canvas windows={windows} compact label={label} />
      <figcaption>{caption}</figcaption>
    </figure>
  );
}
