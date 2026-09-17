import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import styles from "./PullQuote.module.css";

export interface PullQuoteProps {
  children: ReactNode;
  /** Source or gloss set under the quote. */
  attribution?: ReactNode;
  /**
   * `ruled` sets a statement large under a heavy rule, pushed to the foot of its column.
   * `memo` sets an excerpt beside a hanging ochre quote mark.
   */
  variant?: "ruled" | "memo";
  className?: string;
}

export function PullQuote({ children, attribution, variant = "ruled", className }: PullQuoteProps) {
  if (variant === "memo") {
    return (
      <figure className={cx(styles.memo, className)}>
        <blockquote>
          <p>{children}</p>
        </blockquote>
        {attribution ? <figcaption>{attribution}</figcaption> : null}
      </figure>
    );
  }
  return (
    <blockquote className={cx(styles.ruled, className)}>
      <p>{children}</p>
      {attribution ? <footer>{attribution}</footer> : null}
    </blockquote>
  );
}
