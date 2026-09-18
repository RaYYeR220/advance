import { TextLink } from "@/components/editorial/Action";
import { ScoreHeader } from "./ScoreHeader";
import styles from "./ScoreResult.module.css";

export interface ScoreErrorProps {
  token: string;
}

/** `getScore` threw — an unreachable underwriter, an unconfigured deployment, or a transient
 * chain read failure. Never a stack trace; always a way back. */
export function ScoreError({ token }: ScoreErrorProps) {
  return (
    <>
      <ScoreHeader page={61} eyebrow="Not available" title="Can't score this token right now" />
      <p className={styles.body}>
        The underwriter couldn&apos;t be reached for <code>{token}</code>. It may not be deployed yet, or the read
        failed partway through — this is usually transient.
      </p>
      <p className={styles.actions}>
        <TextLink href={`/underwrite/${token}`}>Try again</TextLink> · <TextLink href="/underwrite">Back to underwrite</TextLink>
      </p>
    </>
  );
}
