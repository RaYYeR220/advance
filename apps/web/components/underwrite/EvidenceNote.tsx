import type { Hex } from "viem";
import { shortHash } from "@/lib/format";
import styles from "./EvidenceNote.module.css";

export interface EvidenceNoteProps {
  hash: Hex;
  /** The underwriter API's base URL, for linking straight to `/v1/evidence/:hash`.
   * `undefined` when the API's own address couldn't be resolved — the hash still prints, just
   * without a link. */
  apiBaseUrl?: string;
}

/** The evidence hash every number on this page was derived from, with a link to the raw bundle
 * — present on both an approved and a denied score, since both come from one evidence bundle. */
export function EvidenceNote({ hash, apiBaseUrl }: EvidenceNoteProps) {
  const href = apiBaseUrl ? `${apiBaseUrl}/v1/evidence/${hash}` : undefined;
  return (
    <section className={styles.note} aria-labelledby="evidence-title">
      <h2 id="evidence-title">Evidence</h2>
      <p>
        Every figure above comes from this bundle: the raw chain reads, the swap sample and the formula that turned
        them into terms. Anyone with an archive RPC for this chain can re-run the same reads and reproduce the exact
        same hash.
      </p>
      <p className={styles.hash}>
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" aria-label={`Evidence bundle ${hash}, opens the raw JSON in a new tab`}>
            {shortHash(hash)}
          </a>
        ) : (
          shortHash(hash)
        )}
      </p>
    </section>
  );
}
