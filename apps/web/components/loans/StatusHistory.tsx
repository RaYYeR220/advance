import { txUrl } from "@/lib/explorer";
import type { StatusHistoryEntry } from "@/lib/loanDetail";
import styles from "./LoanDetail.module.css";

export interface StatusHistoryProps {
  history: readonly StatusHistoryEntry[];
  chainId: number;
}

function formatDateTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Every milestone the loan has actually reached, oldest first. Always has at least one entry
 * (the loan's own opening) once a loan exists. */
export function StatusHistory({ history, chainId }: StatusHistoryProps) {
  if (history.length === 0) {
    return <p className={styles.empty}>No status history recorded.</p>;
  }
  return (
    <ul className={styles.list}>
      {history.map((entry) => (
        <li key={entry.id} className={styles.row}>
          <span className={styles.rowMain}>
            <b>{entry.label}</b>
            <span className={styles.rowMeta}>{formatDateTime(entry.timestamp)}</span>
          </span>
          {entry.txHash ? (
            <a className={styles.rowLink} href={txUrl(chainId, entry.txHash)} target="_blank" rel="noreferrer">
              view tx
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
