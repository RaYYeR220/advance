import { useId } from "react";
import { Seal } from "@/components/halftone/Seal";
import { cx } from "@/lib/cx";
import { formatBlock, formatCents, formatInteger, formatMultiple, formatPercent, formatUsd } from "@/lib/format";
import type { NoteTerms } from "@/lib/landing-data";
import { CapBar } from "./CapBar";
import styles from "./Certificate.module.css";

export interface CertificateProps extends NoteTerms {
  headingLevel?: 2 | 3;
  className?: string;
}

/** The revenue note as a printed certificate: terms, repayment progress and the escrow clause. */
export function Certificate({
  agentLabel,
  series,
  notesOutstanding,
  repaidPerNote,
  clearingPriceCents,
  capMultiple,
  borrowedUsd,
  repaidUsd,
  capUsd,
  sweeps,
  latestBlock,
  headingLevel = 2,
  className,
}: CertificateProps) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const titleId = useId();
  const sweepCount = sweeps.length;
  const repaidShare = formatPercent(capUsd > 0 ? repaidUsd / capUsd : 0);
  return (
    <article className={cx(styles.note, className)} aria-labelledby={titleId}>
      <div className={styles.frame}>
        <div className={styles.inner}>
          <header className={styles.top}>
            <Seal className={styles.seal} />
            <div>
              <Heading className={styles.heading} id={titleId}>
                Revenue note<span className="sr-only">, agent {agentLabel}</span>
              </Heading>
              <p className={styles.series}>
                Series {series}, {formatInteger(notesOutstanding)} notes outstanding
              </p>
            </div>
          </header>
          <div className={styles.terms}>
            <div className={styles.term}>
              <b className={styles.figure}>{formatUsd(repaidPerNote, { cents: true })}</b>
              <span className={styles.caption}>repaid per note</span>
            </div>
            <div className={styles.term}>
              <b className={styles.figure}>{formatCents(clearingPriceCents)}</b>
              <span className={styles.caption}>auction clearing price</span>
            </div>
            <div className={styles.term}>
              <b className={styles.figure}>
                {formatMultiple(capMultiple)}
                <span className={styles.times}>×</span>
              </b>
              <span className={styles.caption}>cap on {formatUsd(borrowedUsd)} borrowed</span>
            </div>
          </div>
          <div className={styles.progress}>
            <p className={styles.progressRow}>
              <span>Repaid to noteholders</span>
              <span>
                <b>{formatUsd(repaidUsd, { cents: true })}</b> of {formatUsd(capUsd)}
              </span>
            </p>
            <CapBar
              repaidUsd={repaidUsd}
              capUsd={capUsd}
              sweeps={sweeps}
              label={`${repaidShare} percent of the cap repaid over ${sweepCount} sweeps`}
            />
            <p className={styles.progressFoot}>
              {sweepCount} {sweepCount === 1 ? "sweep" : "sweeps"} so far. Latest at block {formatBlock(latestBlock)}.
            </p>
          </div>
          <p className={styles.legal}>Fee stream escrowed by contract, handed back to the agent once the cap is repaid.</p>
        </div>
      </div>
    </article>
  );
}
