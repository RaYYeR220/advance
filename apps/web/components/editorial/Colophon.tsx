import { ControlStrip } from "@/components/halftone/ControlStrip";
import { cx } from "@/lib/cx";
import { RunningHead } from "./Folio";
import styles from "./Colophon.module.css";

export interface ColophonProps {
  page: number;
  contracts: readonly { name: string; role: string }[];
  rails: readonly { name: string; role: string; detail: string }[];
  className?: string;
}

/** What the product is built from: its own contracts, the rails beneath them and how the page is printed. */
export function Colophon({ page, contracts, rails, className }: ColophonProps) {
  return (
    <section className={cx("sec", styles.colophon, className)} aria-labelledby="col-title">
      <RunningHead page={page} title="Colophon" />
      <div className={styles.grid}>
        <div>
          <h2 className="h2-l" id="col-title">
            Built on
          </h2>
          <p className={cx("prose", styles.intro)}>
            Advance is a set of contracts and an underwriter. The rails underneath belong to people who built them
            first.
          </p>
          <div className={styles.contracts}>
            <h3>Our part</h3>
            <ul>
              {contracts.map((c) => (
                <li key={c.name}>
                  <span>{c.name}</span>
                  {c.role}
                </li>
              ))}
            </ul>
            <p>Verified on Basescan. No admin key can move a lender&apos;s funds.</p>
          </div>
        </div>
        <dl className={styles.rails}>
          {rails.map((r) => (
            <div key={r.name}>
              <dt>{r.name}</dt>
              <dd>
                {r.role}
                <small>{r.detail}</small>
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <figure className={styles.strip}>
        <ControlStrip compact={false} className={styles.wide} />
        <ControlStrip compact className={styles.compact} />
        <figcaption>
          Set in DM Serif Display, Karla and Courier Prime. Printed in two plates: ochre screened at 15°, forest at 45°.
        </figcaption>
      </figure>
    </section>
  );
}
