"use client";

import { capBarSvg, sweepTicks } from "@/components/halftone/charts";
import { INK } from "@/components/halftone/screen";
import { useScreen } from "@/components/halftone/useScreen";
import styles from "./Certificate.module.css";

export interface CapBarProps {
  repaidUsd: number;
  capUsd: number;
  sweeps: readonly number[];
  label: string;
}

/** Progress towards the repayment cap, with a tick for every sweep. */
export function CapBar({ repaidUsd, capUsd, sweeps, label }: CapBarProps) {
  const ratio = capUsd > 0 ? repaidUsd / capUsd : 0;
  const { ref, size, url } = useScreen<HTMLDivElement>(
    ({ width, height }) => capBarSvg(width, height, ratio),
    String(ratio),
  );
  const ticks = size ? sweepTicks(size.width, capUsd, sweeps) : [];
  return (
    <div ref={ref} className={styles.bar} role="img" aria-label={label}>
      <div className={styles.barScreen}>{url ? <img src={url} alt="" decoding="async" /> : null}</div>
      <svg viewBox={size ? `0 -6 ${size.width} ${size.height + 8}` : undefined} aria-hidden="true">
        {size ? (
          <>
            {ticks.map((x, i) => (
              <line key={i} x1={x.toFixed(1)} y1="-4" x2={x.toFixed(1)} y2="2" stroke={INK.forest} strokeWidth="1" />
            ))}
            <line
              x1={size.width - 0.5}
              y1="-6"
              x2={size.width - 0.5}
              y2={size.height + 8}
              stroke={INK.forest}
              strokeWidth="2"
            />
            <rect
              x=".5"
              y="6.5"
              width={size.width - 1}
              height={size.height - 1}
              fill="none"
              stroke={INK.forest}
              strokeWidth="1"
            />
          </>
        ) : null}
      </svg>
    </div>
  );
}
