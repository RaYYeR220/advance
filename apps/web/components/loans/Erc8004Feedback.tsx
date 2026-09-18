import styles from "./LoanDetail.module.css";

/**
 * ERC-8004 feedback for this loan: once a loan repays or defaults, Advance posts that outcome
 * to the agent's identity and reputation registry — a value, a tag and the transaction. No
 * feed this page reads yet carries that record, so this always prints the honest mechanism
 * rather than a fabricated entry.
 */
export function Erc8004Feedback() {
  return (
    <p className={styles.empty}>
      No feedback posted yet. Advance posts value/tag feedback to the ERC-8004 reputation registry once a loan
      settles — repaid or defaulted — and it will show up here, with a link to the transaction, the moment it lands.
    </p>
  );
}
