import { txUrl } from "@/lib/explorer";
import { shortAddress } from "@/lib/format";
import { REFUSAL_LAYER_COPY, REFUSAL_LAYERS, type RefusalsByLayer } from "@/lib/refusals";
import styles from "./LoanDetail.module.css";

export interface RefusalExhibitsProps {
  grouped: RefusalsByLayer;
  chainId: number;
}

function formatDateTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Every refusal, grouped by the layer that refused it — gateway precheck, the card's own
 * ERC-1271 signature check, the CreditLine contract's revert, and the wallet's signing policy.
 * Each layer always prints its mechanism, even with nothing to show yet, so a reader learns
 * what stopped nothing from what stopped something.
 */
export function RefusalExhibits({ grouped, chainId }: RefusalExhibitsProps) {
  return (
    <>
      {REFUSAL_LAYERS.map((layer) => {
        const copy = REFUSAL_LAYER_COPY[layer];
        const refusals = grouped[layer];
        return (
          <div key={layer} className={styles.layerGroup}>
            <h3 className={styles.layerTitle}>{copy.title}</h3>
            <p className={styles.layerMechanism}>{copy.mechanism}</p>
            {refusals.length === 0 ? (
              <p className={styles.empty}>No refusals recorded at this layer yet.</p>
            ) : (
              refusals.map((refusal) => (
                <article key={refusal.id} className={styles.exhibit}>
                  <p className={styles.exhibitReason}>{refusal.reason}</p>
                  <p className={styles.exhibitMeta}>
                    <span>{formatDateTime(refusal.timestamp)}</span>
                    {refusal.payTo ? <span>to {shortAddress(refusal.payTo)}</span> : null}
                    {refusal.amount ? <span>{refusal.amount} USDC</span> : null}
                    {refusal.txHash ? (
                      <a href={txUrl(chainId, refusal.txHash)} target="_blank" rel="noreferrer">
                        view tx
                      </a>
                    ) : null}
                  </p>
                </article>
              ))
            )}
          </div>
        );
      })}
    </>
  );
}
