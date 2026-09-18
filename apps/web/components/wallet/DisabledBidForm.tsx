import { formatCents } from "@/lib/format";
import styles from "./BidPanel.module.css";

export interface DisabledBidFormProps {
  floorCents: number;
  live: boolean;
}

/** Renders the same field layout as `BidForm`, disabled, with a plain explanation — used
 * whenever `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID` isn't configured, so a missing wallet
 * environment degrades the form instead of crashing the page. Explains whichever is true: the
 * auction has already ended, or bidding just needs a configured wallet environment. */
export function DisabledBidForm({ floorCents, live }: DisabledBidFormProps) {
  return (
    <div className={styles.form}>
      <label className={styles.field}>
        <span>Notes</span>
        <input type="number" min="1" step="1" disabled />
      </label>
      <label className={styles.field}>
        <span>Max price (USD per note)</span>
        <input type="number" min={(floorCents / 100).toFixed(2)} step="0.01" defaultValue={(floorCents / 100).toFixed(2)} disabled />
      </label>
      <button type="button" className="button" disabled>
        Place bid
      </button>
      {live ? (
        <p className={styles.explain}>
          Bidding needs a configured wallet environment. Set <code>NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID</code> to enable it.
        </p>
      ) : (
        <p className={styles.explain}>This auction has ended — no more bids are accepted.</p>
      )}
    </div>
  );
}
