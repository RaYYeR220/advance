import type { ReactNode } from "react";
import type { Address } from "viem";
import { RunningHead } from "@/components/editorial/Folio";
import { tokenUrl } from "@/lib/explorer";
import styles from "./ScoreResult.module.css";

export interface ScoreHeaderProps {
  page: number;
  eyebrow: string;
  title: ReactNode;
  /** Present once the token address and its chain are both known — omitted for the invalid-token
   * and error states, which never reach a chain read. */
  token?: { address: Address; chainId: number };
}

export function ScoreHeader({ page, eyebrow, title, token }: ScoreHeaderProps) {
  return (
    <header>
      <RunningHead page={page} title="Score" />
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h1 className={styles.title}>{title}</h1>
      {token ? (
        <p className={styles.tokenLine}>
          <a href={tokenUrl(token.chainId, token.address)} target="_blank" rel="noreferrer">
            {token.address}
          </a>
        </p>
      ) : null}
    </header>
  );
}
