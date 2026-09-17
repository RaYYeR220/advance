"use client";

import { formatUsd } from "@/lib/format";
import { weeklyGeometry, weeklySvg } from "./charts";
import { INK } from "./screen";
import { useScreen } from "./useScreen";

export interface WeeklyChartProps {
  /** USD repaid in each week, oldest first. */
  weeks: readonly number[];
  label: string;
  className?: string;
  screenClassName?: string;
}

/** Weekly repayments as ochre-screened bars on a reversed page. */
export function WeeklyChart({ weeks, label, className, screenClassName }: WeeklyChartProps) {
  const { ref, size, url } = useScreen<HTMLDivElement>(
    ({ width, height }) => weeklySvg(width, height, weeks),
    weeks.join(","),
  );
  const g = size ? weeklyGeometry(size.width, size.height, weeks) : null;
  return (
    <div ref={ref} className={className} role="img" aria-label={label}>
      <div className={screenClassName}>{url ? <img src={url} alt="" decoding="async" /> : null}</div>
      <svg viewBox={size ? `0 0 ${size.width} ${size.height}` : undefined} aria-hidden="true">
        {size && g ? (
          <>
            <line x1="0" x2={size.width} y1={g.bottom + 1} y2={g.bottom + 1} stroke={INK.paper} strokeOpacity=".7" />
            <text x={g.latest.x} y={g.latest.y - 10} textAnchor="end">
              {formatUsd(g.latest.value)}
            </text>
            <text x="0" y={size.height - 4}>
              {weeks.length} weeks ago
            </text>
            <text x={size.width} y={size.height - 4} textAnchor="end">
              this week
            </text>
          </>
        ) : null}
      </svg>
    </div>
  );
}
