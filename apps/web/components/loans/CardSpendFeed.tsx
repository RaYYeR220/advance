import { txUrl } from "@/lib/explorer";
import { shortAddress } from "@/lib/format";
import type { CardReceipt } from "@/lib/loanDetail";
import styles from "./LoanDetail.module.css";

export interface CardSpendFeedProps {
  receipts: readonly CardReceipt[];
  chainId: number;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** The card's x402 spend, newest first: payee, amount, a link to the settlement. No spend yet
 * prints an honest line, never an empty table pretending nothing has ever been drawn. */
export function CardSpendFeed({ receipts, chainId }: CardSpendFeedProps) {
  if (receipts.length === 0) {
    return <p className={styles.empty}>No card spend recorded yet. Every x402 payment the card settles shows up here.</p>;
  }
  return (
    <ul className={styles.list}>
      {receipts.map((r) => (
        <li key={r.id} className={styles.row}>
          <span className={styles.rowMain}>
            <b>{r.amountUsdc ? `${r.amountUsdc} USDC` : "amount unavailable"}</b>
            <span className={styles.rowMeta}>
              to {shortAddress(r.payee)}, {formatDate(r.timestamp)}
            </span>
          </span>
          {r.txHash ? (
            <a className={styles.rowLink} href={txUrl(chainId, r.txHash)} target="_blank" rel="noreferrer">
              view tx
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
