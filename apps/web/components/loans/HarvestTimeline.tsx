import { txUrl } from "@/lib/explorer";
import { formatUsd } from "@/lib/format";
import type { HarvestEntry } from "@/lib/loanDetail";
import styles from "./LoanDetail.module.css";

export interface HarvestTimelineProps {
  harvests: readonly HarvestEntry[];
  chainId: number;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Every real sweep the escrow has made, oldest first, each linking straight to its
 * transaction. No sweep yet prints an honest line rather than an empty list standing in for
 * "we don't know". */
export function HarvestTimeline({ harvests, chainId }: HarvestTimelineProps) {
  if (harvests.length === 0) {
    return <p className={styles.empty}>No sweep has landed yet. The first one shows up here the moment the escrow harvests real fees.</p>;
  }
  return (
    <ul className={styles.list}>
      {harvests.map((h) => (
        <li key={h.id} className={styles.row}>
          <span className={styles.rowMain}>
            <b>{formatUsd(h.usdcOut, { cents: true })}</b>
            <span className={styles.rowMeta}>swept {formatDate(h.timestamp)}</span>
          </span>
          <a className={styles.rowLink} href={txUrl(chainId, h.txHash)} target="_blank" rel="noreferrer">
            view tx
          </a>
        </li>
      ))}
    </ul>
  );
}
