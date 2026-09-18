import { DENY_REASON_COPY, exhibitLetter } from "@/lib/denyReasons";
import type { DenyReason } from "@/lib/scoreTypes";
import styles from "./ReasonExhibit.module.css";

export interface ReasonExhibitProps {
  reason: DenyReason;
  index: number;
}

/** One deny reason, printed as an editorial exhibit: a letter, a plain-language title and an
 * explanation a reader with no protocol background can follow. */
export function ReasonExhibit({ reason, index }: ReasonExhibitProps) {
  const copy = DENY_REASON_COPY[reason];
  return (
    <article className={styles.exhibit}>
      <p className={styles.label}>Exhibit {exhibitLetter(index)}</p>
      <h3 className={styles.title}>{copy.title}</h3>
      <p className={styles.body}>{copy.body}</p>
    </article>
  );
}
