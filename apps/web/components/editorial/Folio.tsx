import { cx } from "@/lib/cx";
import styles from "./Folio.module.css";

export interface FolioProps {
  /** Page number printed in the outer margin. */
  page: number;
  className?: string;
}

/** The large ochre page number. Decorative: hidden from assistive technology. */
export function Folio({ page, className }: FolioProps) {
  return (
    <span className={cx(styles.folio, className)} aria-hidden="true">
      {page}
    </span>
  );
}

export interface PageFootProps extends FolioProps {
  publication: string;
  date: string;
}

/** Folio with the publication line beside it, set at the foot of a page. */
export function PageFoot({ page, publication, date, className }: PageFootProps) {
  return (
    <div className={cx(styles.foot, className)} aria-hidden="true">
      <Folio page={page} />
      <span className={styles.meta}>
        <i>{publication}</i>
        <br />
        {date}
      </span>
    </div>
  );
}

export interface RunningHeadProps {
  page: number;
  title: string;
  /** Left-hand pages lead with the number, right-hand pages end with it. */
  side?: "left" | "right";
  tone?: "paper" | "reverse";
  className?: string;
}

/** Page number and section title above a hairline, as at the top of a magazine page. */
export function RunningHead({ page, title, side = "left", tone = "paper", className }: RunningHeadProps) {
  const number = <span className={styles.number}>{page}</span>;
  const heading = <i className={styles.title}>{title}</i>;
  return (
    <div
      className={cx(styles.rhead, side === "right" && styles.right, tone === "reverse" && styles.reverse, className)}
      aria-hidden="true"
    >
      {side === "left" ? (
        <>
          {number}
          {heading}
        </>
      ) : (
        <>
          {heading}
          {number}
        </>
      )}
    </div>
  );
}
