import type { CSSProperties } from "react";
import { formatUsd } from "@/lib/format";
import type { DrawMeterData } from "@/lib/loanDetail";
import styles from "./LoanDetail.module.css";

export interface DrawMeterProps {
  meter: DrawMeterData;
}

/** Drawn vs. the credit line's per-period limit, with the period clock — the limit resets
 * every period, never a running total across periods. */
export function DrawMeter({ meter }: DrawMeterProps) {
  const ratio = meter.limitUsd > 0 ? Math.min(1, meter.usedUsd / meter.limitUsd) : 0;
  const label = `${formatUsd(meter.usedUsd, { cents: true })} drawn of ${formatUsd(meter.limitUsd, { cents: true })} available this ${meter.periodLabel}`;
  return (
    <div className={styles.meter}>
      <div className={styles.meterBar} role="img" aria-label={label} style={{ "--fill": `${Math.round(ratio * 100)}%` } as CSSProperties}>
        <div className={styles.meterFill} />
      </div>
      <p className={styles.meterLabels}>
        <span>
          <b>{formatUsd(meter.usedUsd, { cents: true })}</b> drawn this {meter.periodLabel}
        </span>
        <span>
          <b>{formatUsd(meter.availableUsd, { cents: true })}</b> still available
        </span>
      </p>
      <p className={styles.meterLabels}>
        <span>Resets every {meter.periodLabel}</span>
        <span>{formatUsd(meter.limitUsd, { cents: true })} limit</span>
      </p>
    </div>
  );
}
