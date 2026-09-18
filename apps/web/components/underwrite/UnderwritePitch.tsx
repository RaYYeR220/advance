import { RunningHead } from "@/components/editorial/Folio";
import { cx } from "@/lib/cx";
import { UnderwriteForm } from "./UnderwriteForm";
import styles from "./UnderwritePitch.module.css";

/** `/underwrite`'s only content: what scoring is, what it costs, and the paste-a-token form. */
export function UnderwritePitch() {
  return (
    <section className={cx("sec", styles.pitch)} aria-labelledby="underwrite-title">
      <RunningHead page={60} title="Underwrite" />
      <h1 className="h2-xl" id="underwrite-title">
        Paste a token, get a score
      </h1>
      <p className={cx("sec-deck", styles.deck)}>
        Advance reads a Bankr token&apos;s fee history straight off Base archive nodes and turns it into loan terms —
        or a plain reason it can&apos;t, yet.
      </p>
      <div className={styles.costs}>
        <div>
          <b>Free</b>
          <span>A score: revenue windows, the haircut breakdown and the terms a formula would offer.</span>
        </div>
        <div>
          <b>Paid</b>
          <span>
            A signed quote — the memo that can tighten those terms and the term sheet a loan opens from — costs a
            small payment over x402, from the same gateway an agent already pays through.
          </span>
        </div>
      </div>
      <UnderwriteForm />
      <p className={styles.note}>
        Nothing here is reported by the agent. Every number traces back to a chain read anyone can repeat.
      </p>
    </section>
  );
}
