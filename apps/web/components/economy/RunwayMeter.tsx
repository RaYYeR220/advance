import type { CSSProperties } from "react";
import type { RunwayData } from "@/lib/economy";
import styles from "./EconomyIndex.module.css";

export interface RunwayMeterProps {
  runway: RunwayData;
}

const LOW_RUNWAY_RATIO = 0.25;

/** Runway left in the loan's grace period, against the grace period itself — filled ochre
 * under a quarter left, forest otherwise. */
export function RunwayMeter({ runway }: RunwayMeterProps) {
  const percent = Math.round(runway.ratio * 100);
  const label = `${runway.label} of runway left before this loan's grace period ends`;
  return (
    <div className={styles.meter}>
      <div className={styles.meterBar} role="img" aria-label={label} style={{ "--fill": `${percent}%` } as CSSProperties}>
        <div className={styles.meterFill} data-low={runway.ratio < LOW_RUNWAY_RATIO || undefined} />
      </div>
      <p className={styles.meterLabel}>
        <b>{runway.label}</b> of runway left
      </p>
    </div>
  );
}
