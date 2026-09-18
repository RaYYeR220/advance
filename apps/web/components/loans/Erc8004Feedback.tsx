import type { Erc8004FeedbackView } from "@advance/sdk";
import { addressUrl } from "@/lib/explorer";
import styles from "./LoanDetail.module.css";

export interface Erc8004FeedbackProps {
  feedback: Erc8004FeedbackView | null;
  chainId: number;
}

const OUTCOME_COPY: Record<string, string> = {
  repaid: "repaid in full",
  default: "defaulted",
};

function formatValue(value: bigint, valueDecimals: number): string {
  const num = valueDecimals === 0 ? Number(value) : Number(value) / 10 ** valueDecimals;
  return num > 0 ? `+${num}` : String(num);
}

/**
 * ERC-8004 feedback for this loan: once a loan repays or defaults, Advance posts that outcome
 * to the agent's identity and reputation registry — a value, a tag and the transaction. Renders
 * the real registry entry when one exists; prints the honest empty state otherwise (the term
 * sheet never carried an agent id, or the registry has nothing posted yet for this agent).
 */
export function Erc8004Feedback({ feedback, chainId }: Erc8004FeedbackProps) {
  if (!feedback) {
    return (
      <p className={styles.empty}>
        No feedback posted yet. Advance posts value/tag feedback to the ERC-8004 reputation registry once a loan
        settles — repaid or defaulted — and it will show up here, with a link to the registry, the moment it lands.
      </p>
    );
  }

  const outcome = OUTCOME_COPY[feedback.tag2] ?? feedback.tag2;
  const revokedSuffix = feedback.isRevoked ? " (revoked)" : "";

  return (
    <ul className={styles.list}>
      <li className={styles.row}>
        <span className={styles.rowMain}>
          <b>{formatValue(feedback.value, feedback.valueDecimals)}</b>
          <span className={styles.rowMeta}>
            {outcome} — tags {feedback.tag1} / {feedback.tag2}, agent #{feedback.agentId.toString()}
            {revokedSuffix}
          </span>
        </span>
        <a className={styles.rowLink} href={addressUrl(chainId, feedback.registry)} target="_blank" rel="noreferrer">
          view registry
        </a>
      </li>
    </ul>
  );
}
