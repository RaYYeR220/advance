import { RunningHead } from "@/components/editorial/Folio";
import { WeeklyChart } from "@/components/halftone/WeeklyChart";
import { formatBlock, formatInteger, formatUsd } from "@/lib/format";
import type { LandingData } from "@/lib/landing-data";
import styles from "./EconomyBand.module.css";

export interface EconomyBandProps {
  economy: LandingData["economy"];
}

/** Running totals set as a sentence, beside the weekly repayment bars. */
export function EconomyBand({ economy }: EconomyBandProps) {
  const weeks = economy.weeklyRepaidUsd;
  const first = weeks[0] ?? 0;
  const last = weeks[weeks.length - 1] ?? 0;
  return (
    <section className={styles.band} id="economy" aria-labelledby="eco-title">
      <RunningHead page={48} title="The economy, live" tone="reverse" />
      <h2 className="sr-only" id="eco-title">
        Live numbers
      </h2>
      <div className={styles.grid}>
        <p className={styles.run}>
          Since launch, Advance has funded <span className={styles.figure}>{formatInteger(economy.fundedAgents)}</span>{" "}
          agents, paid <span className={styles.figure}>{formatUsd(economy.repaidUsd)}</span> back to noteholders and
          refused <span className={styles.figure}>{formatInteger(economy.refusals)}</span> attempts to spend outside the
          rules.
        </p>
        <figure className={styles.weekly}>
          <WeeklyChart
            className={styles.chart}
            screenClassName={styles.screen}
            weeks={weeks}
            label={`Repaid per week over ${weeks.length} weeks, rising from ${formatUsd(first)} to ${formatUsd(last)}`}
          />
          <figcaption>
            <b>Repaid per week, last {weeks.length} weeks.</b> Read from Base at block {formatBlock(economy.block)} and
            refreshed every block.
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
