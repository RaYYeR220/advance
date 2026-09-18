import type { Address } from "viem";
import type { ScoreResult } from "@advance/sdk";
import { RevenueWindowsChart } from "@/components/halftone/RevenueWindowsChart";
import { TornReceipt, type ReceiptRow } from "@/components/editorial/Exhibit";
import { formatCents, formatInteger, formatUsd, microUsdToUsd } from "@/lib/format";
import { haircutFactors } from "@/lib/haircut";
import { cx } from "@/lib/cx";
import { EvidenceNote } from "./EvidenceNote";
import { ScoreHeader } from "./ScoreHeader";
import styles from "./ScoreResult.module.css";

type Eligible = Extract<ScoreResult, { kind: "eligible" }>;

export interface EligibleResultProps {
  token: Address;
  result: Eligible;
  apiBaseUrl?: string;
}

const DRAW_PERIOD_LABEL = (seconds: number) => (seconds === 86_400 ? "day" : `${Math.round(seconds / 3600)}-hour period`);
const GRACE_LABEL = (seconds: number) => `${Math.round(seconds / 86_400)} days`;

/** The full approved score: revenue windows, the haircut breakdown with reasons, the
 * projection-to-terms walk-through and the resulting draw terms. */
export function EligibleResult({ token, result, apiBaseUrl }: EligibleResultProps) {
  const { terms, evidence, evidenceHash } = result;
  const { quality, revenue } = evidence.formula;
  const swapCount = evidence.swapSample.stats.swapCount;

  const d1 = microUsdToUsd(revenue.revenueMicroUsd.d1);
  const d7 = microUsdToUsd(revenue.revenueMicroUsd.d7);
  const d30 = microUsdToUsd(revenue.revenueMicroUsd.d30);
  const projected90d = microUsdToUsd(terms.projected90dMicroUsd);
  const capUsd = microUsdToUsd(terms.capMicroUsd);
  const minPrincipalUsd = microUsdToUsd(terms.minPrincipal);
  const drawLimitUsd = microUsdToUsd(terms.drawLimit);
  const qualityPct = Math.round(terms.haircutBps / 100);

  const factors = haircutFactors(quality, revenue.ageSeconds);
  const haircutRows: ReceiptRow[] = factors.map((f) => ({
    label: f.label,
    value: f.fired ? `${f.measured} — fires, ${f.multiplier}` : `${f.measured} — clear`,
    emphasis: f.fired,
  }));

  return (
    <>
      <ScoreHeader
        page={61}
        eyebrow="Eligible"
        title={`${formatUsd(capUsd)} available, at a ${formatCents(terms.floorCents)} floor`}
        token={{ address: token, chainId: evidence.chainId }}
      />

      <section className={styles.section} aria-labelledby="revenue-title">
        <h2 id="revenue-title">Revenue windows</h2>
        <p className={styles.sectionIntro}>
          Creator revenue read from on-chain fee accrual, never from a number the agent reports.
        </p>
        <RevenueWindowsChart
          d1Usd={d1}
          d7Usd={d7}
          d30Usd={d30}
          caption={`${formatInteger(swapCount)} swaps sampled over the trailing week feed the quality read below.`}
        />
      </section>

      <section className={styles.section} aria-labelledby="haircut-title">
        <h2 id="haircut-title">The haircut, broken down</h2>
        <p className={styles.sectionIntro}>
          Four checks can each shrink the quality multiplier. A clean, established, diversified fee stream keeps the
          full multiplier; this token cleared at {qualityPct}%.
        </p>
        <TornReceipt
          label="Exhibit. The haircut"
          title="Quality multiplier"
          subtitle={`${formatInteger(swapCount)} swaps sampled`}
          groups={[haircutRows]}
          total={{ label: "Combined multiplier", value: `${qualityPct}%` }}
        />
      </section>

      <section className={styles.section} aria-labelledby="formula-title">
        <h2 id="formula-title">Projection to terms</h2>
        <p className={styles.sectionIntro}>How the formula turns those windows into the terms below, in order.</p>
        <ol className={styles.formula}>
          <li>
            <span className={styles.num}>1</span>
            <span className={styles.step}>
              <b>{formatUsd(projected90d)}</b>
              <span>Projected revenue over the next 90 days, decayed from the 1/7/30-day windows above.</span>
            </span>
          </li>
          <li>
            <span className={styles.num}>2</span>
            <span className={styles.step}>
              <b>{formatUsd(capUsd)}</b>
              <span>
                Cap: half the projection, held back further by the {qualityPct}% quality multiplier, then capped at
                the program&apos;s hard ceiling.
              </span>
            </span>
          </li>
          <li>
            <span className={styles.num}>3</span>
            <span className={styles.step}>
              <b>{formatCents(terms.floorCents)}</b>
              <span>Floor: the lowest price a note can clear the auction at, bumped up for a thin multiplier or a young token.</span>
            </span>
          </li>
          <li>
            <span className={styles.num}>4</span>
            <span className={styles.step}>
              <b>
                {formatUsd(minPrincipalUsd)} to open, {formatUsd(drawLimitUsd)} a {DRAW_PERIOD_LABEL(terms.drawPeriod)}
              </b>
              <span>Draw terms: the auction&apos;s graduation threshold and the credit line&apos;s per-period limit, both derived from the cap and floor above.</span>
            </span>
          </li>
        </ol>
      </section>

      <section className={cx(styles.section)} aria-labelledby="terms-title">
        <h2 id="terms-title">Resulting terms</h2>
        <dl className={styles.terms}>
          <div>
            <dt>Cap</dt>
            <dd>{formatUsd(capUsd)}</dd>
          </div>
          <div>
            <dt>Floor</dt>
            <dd>{formatCents(terms.floorCents)}</dd>
          </div>
          <div>
            <dt>Opens at</dt>
            <dd>{formatUsd(minPrincipalUsd)}</dd>
          </div>
          <div>
            <dt>Draw limit</dt>
            <dd>
              {formatUsd(drawLimitUsd)}/{DRAW_PERIOD_LABEL(terms.drawPeriod)}
            </dd>
          </div>
          <div>
            <dt>Grace period</dt>
            <dd>{GRACE_LABEL(terms.gracePeriod)}</dd>
          </div>
        </dl>
      </section>

      <EvidenceNote hash={evidenceHash} apiBaseUrl={apiBaseUrl} />
    </>
  );
}
