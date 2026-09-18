import { useId } from "react";
import { INK } from "@/components/halftone/screen";
import { cx } from "@/lib/cx";
import styles from "./Exhibit.module.css";

export interface ReceiptRow {
  label: string;
  value: string;
  /** Set in bold, for the line the receipt is about. */
  emphasis?: boolean;
}

export interface TornReceiptProps {
  label: string;
  title: string;
  subtitle: string;
  /** Row groups, each closed by a dashed rule. */
  groups: readonly (readonly ReceiptRow[])[];
  total: { label: string; value: string };
  /** Rubber-stamp text pressed across the foot of the slip. */
  stamp?: string;
  className?: string;
}

/** A transaction printed on a torn till slip, optionally stamped. */
export function TornReceipt({ label, title, subtitle, groups, total, stamp, className }: TornReceiptProps) {
  const captionId = useId();
  return (
    <figure className={cx(styles.receipt, className)} aria-labelledby={captionId}>
      <p className={styles.label} id={captionId}>
        {label}
      </p>
      <div className={styles.slipWrap}>
        <div className={styles.slip}>
          <p className={styles.slipTop}>
            <strong>{title}</strong>
            {subtitle}
          </p>
          {groups.map((rows, g) => (
            <dl key={g}>
              {rows.map((row) => (
                <div key={row.label} className={row.emphasis ? styles.emphasis : undefined}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          ))}
          <p className={styles.total}>
            <span>{total.label}</span>
            <span>{total.value}</span>
          </p>
        </div>
      </div>
      {stamp ? <Stamp text={stamp} /> : null}
    </figure>
  );
}

/** Worn rubber stamp: a double frame and a word, roughened and speckled where the ink did not take. */
function Stamp({ text }: { text: string }) {
  const id = useId();
  const rough = `${id}-rough`;
  const speckle = `${id}-speckle`;
  const wear = `${id}-wear`;
  return (
    <svg className={styles.stamp} viewBox="0 0 260 100" aria-hidden="true">
      <defs>
        <filter id={rough} x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency=".75" numOctaves={2} seed={4} />
          <feDisplacementMap in="SourceGraphic" scale={3.4} />
        </filter>
        <filter id={speckle}>
          <feTurbulence type="fractalNoise" baseFrequency="1.6" numOctaves={1} seed={11} />
          <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 -3.2 2.3" />
        </filter>
        <mask id={wear}>
          <rect width="260" height="100" fill="#fff" filter={`url(#${speckle})`} />
        </mask>
      </defs>
      <g mask={`url(#${wear})`} filter={`url(#${rough})`} opacity=".9">
        <rect x="6" y="8" width="248" height="84" rx="5" fill="none" stroke={INK.forest} strokeWidth="5" />
        <rect x="15" y="17" width="230" height="66" rx="2" fill="none" stroke={INK.forest} strokeWidth="1.6" />
        <text className={styles.stampText} x="130" y="66" textAnchor="middle" fontSize="44" fill={INK.forest}>
          {text}
        </text>
      </g>
    </svg>
  );
}
