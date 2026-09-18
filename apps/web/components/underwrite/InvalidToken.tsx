import { TextLink } from "@/components/editorial/Action";
import { ScoreHeader } from "./ScoreHeader";
import styles from "./ScoreResult.module.css";

export interface InvalidTokenProps {
  token: string;
}

/** The route param isn't a well-formed token address — never reaches `getScore`. */
export function InvalidToken({ token }: InvalidTokenProps) {
  return (
    <>
      <ScoreHeader page={61} eyebrow="Not a token address" title="That doesn't look like a token address" />
      <p className={styles.body}>
        <code>{token}</code> isn&apos;t a 0x-prefixed, 40-character hex address. Check it against the explorer and try
        again.
      </p>
      <p className={styles.actions}>
        <TextLink href="/underwrite">Back to underwrite</TextLink>
      </p>
    </>
  );
}
